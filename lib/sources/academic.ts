import { Source } from "../types";

export type RawSource = Omit<Source, "id" | "credibility" | "credibilityNotes">;

const UA = () => {
  const mail = process.env.CONTACT_EMAIL;
  return `ResearchAI/0.1 (${mail ? `mailto:${mail}` : "https://github.com"})`;
};

async function getJSON(url: string, timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": UA(), accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": UA() } });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** OpenAlex returns abstracts as an inverted index; rebuild the text. */
function rebuildAbstract(inv?: Record<string, number[]>): string | undefined {
  if (!inv) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) words[p] = word;
  }
  return words.join(" ").trim() || undefined;
}

export async function searchOpenAlex(query: string, limit = 8): Promise<RawSource[]> {
  const mail = process.env.CONTACT_EMAIL ? `&mailto=${encodeURIComponent(process.env.CONTACT_EMAIL)}` : "";
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}&sort=relevance_score:desc&filter=has_abstract:true${mail}`;
  const data = await getJSON(url);
  return (data.results ?? []).map((w: any): RawSource => {
    const doi: string | undefined = w.doi ? String(w.doi).replace("https://doi.org/", "") : undefined;
    return {
      kind: "academic",
      origin: "OpenAlex",
      title: w.display_name ?? "Untitled",
      url: w.doi || w.primary_location?.landing_page_url || w.id,
      authors: (w.authorships ?? []).slice(0, 6).map((a: any) => a.author?.display_name).filter(Boolean),
      year: w.publication_year,
      venue: w.primary_location?.source?.display_name,
      doi,
      citations: w.cited_by_count,
      abstract: rebuildAbstract(w.abstract_inverted_index),
    };
  });
}

export async function searchArxiv(query: string, limit = 5): Promise<RawSource[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}&sortBy=relevance`;
  const xml = await getText(url);
  const entries = xml.split("<entry>").slice(1);
  return entries.map((e): RawSource => {
    const pick = (tag: string) => e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/\s+/g, " ").trim();
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()).slice(0, 6);
    const published = pick("published");
    return {
      kind: "academic",
      origin: "arXiv",
      title: pick("title") ?? "Untitled",
      url: pick("id") ?? "",
      authors,
      year: published ? Number(published.slice(0, 4)) : undefined,
      venue: "arXiv preprint",
      abstract: pick("summary"),
    };
  });
}

export async function searchCrossref(query: string, limit = 5): Promise<RawSource[]> {
  const mail = process.env.CONTACT_EMAIL ? `&mailto=${encodeURIComponent(process.env.CONTACT_EMAIL)}` : "";
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&select=DOI,title,author,issued,container-title,is-referenced-by-count,abstract,URL${mail}`;
  const data = await getJSON(url);
  return (data.message?.items ?? []).map((w: any): RawSource => ({
    kind: "academic",
    origin: "Crossref",
    title: w.title?.[0] ?? "Untitled",
    url: w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : ""),
    authors: (w.author ?? []).slice(0, 6).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")),
    year: w.issued?.["date-parts"]?.[0]?.[0],
    venue: w["container-title"]?.[0],
    doi: w.DOI,
    citations: w["is-referenced-by-count"],
    abstract: w.abstract ? String(w.abstract).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined,
  }));
}

export async function searchPubMed(query: string, limit = 5): Promise<RawSource[]> {
  const search = await getJSON(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&sort=relevance&term=${encodeURIComponent(query)}`,
  );
  const ids: string[] = search.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const [summary, abstractsXml] = await Promise.all([
    getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`),
    getText(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=${ids.join(",")}`).catch(() => ""),
  ]);
  const abstracts: Record<string, string> = {};
  for (const art of abstractsXml.split("<PubmedArticle>").slice(1)) {
    const pmid = art.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    const text = [...art.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, ""))
      .join(" ");
    if (pmid && text) abstracts[pmid] = text;
  }
  return ids.map((id): RawSource => {
    const r = summary.result?.[id] ?? {};
    const doi = (r.articleids ?? []).find((a: any) => a.idtype === "doi")?.value;
    return {
      kind: "academic",
      origin: "PubMed",
      title: r.title ?? "Untitled",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      authors: (r.authors ?? []).slice(0, 6).map((a: any) => a.name),
      year: r.pubdate ? Number(String(r.pubdate).slice(0, 4)) : undefined,
      venue: r.fulljournalname,
      doi,
      abstract: abstracts[id],
    };
  });
}

/** Query every scholarly index in parallel; individual failures never break the run. */
export async function searchAcademic(query: string, perSource = 6): Promise<{ results: RawSource[]; warnings: string[] }> {
  const jobs: [string, Promise<RawSource[]>][] = [
    ["OpenAlex", searchOpenAlex(query, perSource)],
    ["arXiv", searchArxiv(query, 4)],
    ["Crossref", searchCrossref(query, 4)],
    ["PubMed", searchPubMed(query, 4)],
  ];
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const results: RawSource[] = [];
  const warnings: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results.push(...s.value);
    else warnings.push(`${jobs[i][0]} unavailable`);
  });
  return { results, warnings };
}
