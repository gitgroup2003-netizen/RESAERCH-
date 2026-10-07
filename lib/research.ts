import { completeJSON, completeLLM, streamLLM } from "./llm";
import { scoreSource } from "./credibility";
import { searchAcademic } from "./sources/academic";
import { fetchPageText, searchGovernment, searchWeb } from "./sources/web";
import type { RawSource } from "./sources/academic";
import type { ResearchEvent, ResearchRequest, Source, UploadedDoc } from "./types";

type Emit = (e: ResearchEvent) => void;

const DEPTH = {
  quick: { queries: 2, maxSources: 8, deepen: 2 },
  standard: { queries: 3, maxSources: 14, deepen: 4 },
  deep: { queries: 5, maxSources: 22, deepen: 8 },
} as const;

const STOP = new Set(
  "a an the of and or to in on for with by is are was were be been it this that these those as at from how what why when which who does do can into about between than then".split(" "),
);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function relevance(question: string, s: RawSource): number {
  const q = new Set(tokens(question));
  if (!q.size) return 0;
  const text = tokens(`${s.title} ${s.title} ${s.abstract ?? ""}`);
  let hit = 0;
  const seen = new Set<string>();
  for (const w of text) if (q.has(w) && !seen.has(w)) (seen.add(w), hit++);
  return hit / q.size; // 0..1
}

function dedupe(items: RawSource[]): RawSource[] {
  const seen = new Set<string>();
  const out: RawSource[] = [];
  for (const s of items) {
    const key = (s.doi?.toLowerCase() || s.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase() || s.title.toLowerCase()).trim();
    const titleKey = "t:" + s.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(key) || seen.has(titleKey)) continue;
    seen.add(key);
    seen.add(titleKey);
    out.push(s);
  }
  return out;
}

/** Split an uploaded document into passages and keep the ones most relevant to the question. */
function documentSources(docs: UploadedDoc[], question: string): RawSource[] {
  const q = new Set(tokens(question));
  const out: RawSource[] = [];
  for (const d of docs) {
    const paras = d.text.split(/\n{2,}|(?<=[.!?])\s{2,}/).map((p) => p.trim()).filter((p) => p.length > 80);
    const chunks: string[] = [];
    let cur = "";
    for (const p of paras) {
      if ((cur + p).length > 1400) (chunks.push(cur), (cur = p));
      else cur += (cur ? "\n\n" : "") + p;
    }
    if (cur) chunks.push(cur);
    const scored = chunks
      .map((c) => ({ c, s: tokens(c).filter((w) => q.has(w)).length }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .filter((x) => x.s > 0 || chunks.length <= 3);
    const merged = scored.map((x) => x.c).join("\n\n…\n\n");
    if (merged) {
      out.push({
        kind: "document",
        origin: "Your upload",
        title: d.name,
        url: "",
        content: merged.slice(0, 5000),
        abstract: merged.slice(0, 400),
      });
    }
  }
  return out;
}

export async function runResearch(req: ResearchRequest, emit: Emit): Promise<void> {
  const depth = DEPTH[req.depth];
  const warnings: string[] = [];

  // 1 ── Plan
  emit({ type: "status", message: "Planning the research…" });
  let queries: string[] = [req.question];
  let subquestions: string[] = [];
  try {
    const plan = await completeJSON<{ subquestions: string[]; queries: string[] }>(req.llm, {
      system:
        "You are a research planner. Break the user's question into focused sub-questions and short, keyword-style search queries (3-8 words each) that will work on scholarly indexes and web search engines. Respond with JSON only: {\"subquestions\": string[], \"queries\": string[]}.",
      messages: [{ role: "user", content: `Question: ${req.question}\nReturn at most ${depth.queries} queries and ${depth.queries} sub-questions.` }],
      maxTokens: 600,
    });
    if (plan.queries?.length) queries = plan.queries.slice(0, depth.queries);
    subquestions = (plan.subquestions ?? []).slice(0, depth.queries);
  } catch (e: any) {
    if (/No API key|error 40[13]/i.test(e.message)) throw e; // credentials problem — stop early
    warnings.push("Planner fell back to the raw question");
  }
  if (!queries.includes(req.question) && queries.length < depth.queries + 1) queries.unshift(req.question);
  emit({ type: "plan", queries, subquestions });

  // 2 ── Search
  emit({ type: "status", message: `Searching ${queries.length} queries across selected sources…` });
  const raw: RawSource[] = [];
  const jobs: Promise<void>[] = [];
  for (const q of queries) {
    if (req.sources.academic)
      jobs.push(searchAcademic(q).then((r) => (raw.push(...r.results), void warnings.push(...r.warnings))));
    if (req.sources.government)
      jobs.push(searchGovernment(q, req.tavilyKey).then((r) => (raw.push(...r.results), void warnings.push(...r.warnings))));
    if (req.sources.web)
      jobs.push(searchWeb(q, req.tavilyKey).then((r) => (raw.push(...r.results), void warnings.push(...r.warnings))));
  }
  await Promise.all(jobs);
  if (req.sources.documents && req.documents?.length) raw.push(...documentSources(req.documents, req.question));

  // 3 ── Rank
  emit({ type: "status", message: "Scoring credibility and relevance…" });
  const unique = dedupe(raw).filter((s) => s.title && (s.abstract || s.content));
  const ranked = unique
    .map((s) => {
      const cred = scoreSource(s);
      const rel = relevance(req.question, s);
      // documents the user supplied always make the cut
      const combined = s.kind === "document" ? 1000 : cred.credibility * 0.55 + rel * 100 * 0.45;
      return { s, cred, rel, combined };
    })
    .filter((x) => x.s.kind !== "web" || x.cred.credibility >= 25)
    .sort((a, b) => b.combined - a.combined)
    .slice(0, depth.maxSources);

  if (!ranked.length) {
    emit({
      type: "error",
      message:
        "No usable sources were found. Check your source toggles, add a Tavily key for web/government search, or try rephrasing.",
    });
    return;
  }

  let sources: Source[] = ranked.map((x, i) => ({
    ...x.s,
    id: i + 1,
    credibility: x.cred.credibility,
    credibilityNotes: x.cred.credibilityNotes,
  }));

  // 4 ── Deepen: read the best pages in full
  emit({ type: "status", message: "Reading the strongest sources in more detail…" });
  const toDeepen = sources.filter((s) => (s.kind === "web" || s.kind === "government") && s.url).slice(0, depth.deepen);
  await Promise.all(
    toDeepen.map(async (s) => {
      const text = await fetchPageText(s.url);
      if (text) s.content = text;
    }),
  );
  sources = sources.map((s) => ({ ...s, content: s.content ?? s.abstract }));

  emit({ type: "sources", sources: sources.map(({ content, ...rest }) => rest as Source) });
  if (warnings.length) emit({ type: "status", message: `Notes: ${[...new Set(warnings)].join(" · ")}` });

  // 5 ── Synthesize with citations
  emit({ type: "status", message: "Writing the cited report…" });
  const evidence = sources
    .map((s) => {
      const meta = [s.authors?.slice(0, 3).join(", "), s.year, s.venue, s.origin].filter(Boolean).join(" · ");
      return `[${s.id}] ${s.title}\n${meta}\nCredibility: ${s.credibility}/100\n${(s.content ?? s.abstract ?? "").slice(0, 3200)}`;
    })
    .join("\n\n---\n\n");

  const system = `You are a rigorous research assistant. Write a research report that answers the user's question using ONLY the numbered sources provided.

Rules:
- Cite every factual claim inline with bracketed numbers like [1] or [2][5]. Never cite a number that is not in the source list.
- If sources disagree, say so and cite both sides. Weigh higher-credibility sources more, and note when a claim rests on a preprint or a low-credibility source.
- If the sources do not support a claim, do not make it. State clearly what the evidence does NOT cover under "Gaps & limitations".
- Do not invent statistics, quotes, authors or URLs.
- Paraphrase; quote only short phrases when exact wording matters.
- Format in Markdown with these sections: "## Summary" (3-5 sentences), "## Key findings" (bullets), "## Detailed analysis" (subheadings as needed), "## Gaps & limitations", "## Confidence" (High/Medium/Low with one-line reason).`;

  const user = `Question: ${req.question}\n\n${subquestions.length ? `Sub-questions to address:\n${subquestions.map((s) => `- ${s}`).join("\n")}\n\n` : ""}Sources:\n\n${evidence}`;

  let report = "";
  for await (const t of streamLLM(req.llm, {
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: req.depth === "deep" ? 6000 : 3500,
    temperature: 0.2,
  })) {
    report += t;
    emit({ type: "token", text: t });
  }

  // 6 ── Optional cross-model fact check
  if (req.reviewer) {
    emit({ type: "status", message: "Second model is fact-checking the report…" });
    try {
      const review = await completeLLM(req.reviewer, {
        system:
          "You are a skeptical fact-checker. You receive a draft report and the numbered sources it was based on. List up to 8 problems: claims not supported by the cited source, citations pointing to the wrong source, overstated certainty, or important missing caveats. Reference claims by quoting a few words and the [n] citation. If the report is sound, say so briefly. Be concise, Markdown bullets.",
        messages: [{ role: "user", content: `REPORT:\n${report}\n\nSOURCES:\n${evidence}` }],
        maxTokens: 1200,
      });
      emit({ type: "review", text: review });
    } catch (e: any) {
      emit({ type: "review", text: `_Fact-check unavailable: ${e.message}_` });
    }
  }

  emit({ type: "done" });
}
