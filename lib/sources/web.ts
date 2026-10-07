import { GOV_DOMAINS_FOR_SEARCH } from "../credibility";
import type { RawSource } from "./academic";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string | null;
  published_date?: string;
}

async function tavily(
  apiKey: string,
  query: string,
  opts: { includeDomains?: string[]; max?: number; topic?: "general" | "news" } = {},
): Promise<TavilyResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      max_results: opts.max ?? 8,
      include_raw_content: false,
      topic: opts.topic ?? "general",
      ...(opts.includeDomains ? { include_domains: opts.includeDomains } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return data.results ?? [];
}

export async function searchWeb(query: string, apiKey?: string): Promise<{ results: RawSource[]; warnings: string[] }> {
  const key = apiKey || process.env.TAVILY_API_KEY;
  if (!key) return { results: [], warnings: ["Web search skipped: no Tavily key configured"] };
  try {
    const r = await tavily(key, query, { max: 8 });
    return {
      results: r.map((x): RawSource => ({
        kind: "web",
        origin: "Web search",
        title: x.title,
        url: x.url,
        year: x.published_date ? Number(x.published_date.slice(0, 4)) || undefined : undefined,
        abstract: x.content,
        content: x.content,
      })),
      warnings: [],
    };
  } catch (e: any) {
    return { results: [], warnings: [`Web search failed (${e.message})`] };
  }
}

/** Same search engine, but restricted to government / intergovernmental / university domains. */
export async function searchGovernment(query: string, apiKey?: string): Promise<{ results: RawSource[]; warnings: string[] }> {
  const key = apiKey || process.env.TAVILY_API_KEY;
  if (!key) return { results: [], warnings: ["Government search skipped: no Tavily key configured"] };
  try {
    const r = await tavily(key, query, { max: 8, includeDomains: GOV_DOMAINS_FOR_SEARCH });
    return {
      results: r.map((x): RawSource => ({
        kind: "government",
        origin: "Government / institutional search",
        title: x.title,
        url: x.url,
        year: x.published_date ? Number(x.published_date.slice(0, 4)) || undefined : undefined,
        abstract: x.content,
        content: x.content,
      })),
      warnings: [],
    };
  } catch (e: any) {
    return { results: [], warnings: [`Government search failed (${e.message})`] };
  }
}

/** Fetch a page and reduce it to readable text (used to deepen the best sources). */
export async function fetchPageText(url: string, maxChars = 9000): Promise<string | undefined> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; ResearchAI/0.1)", accept: "text/html,text/plain" },
    });
    if (!res.ok) return undefined;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|xml/.test(type)) return undefined;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 400 ? text.slice(0, maxChars) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}
