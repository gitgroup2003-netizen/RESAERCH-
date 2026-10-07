"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { DEFAULT_MODELS } from "@/lib/types";
import type { ProviderConfig, ProviderId, ResearchEvent, Source, UploadedDoc } from "@/lib/types";

type Depth = "quick" | "standard" | "deep";

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "anthropic", label: "Claude (Anthropic)" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Gemini (Google)" },
  { id: "compat", label: "OpenAI-compatible / Ollama" },
];

const EXAMPLES = [
  "What does current evidence say about intermittent fasting and cardiovascular risk?",
  "How effective are mobile money programs at reducing poverty in sub-Saharan Africa?",
  "What are the main approaches to reducing hallucinations in large language models?",
];

interface Settings {
  provider: ProviderId;
  model: string;
  keys: Partial<Record<ProviderId, string>>;
  baseUrl: string;
  tavilyKey: string;
  useReviewer: boolean;
  reviewerProvider: ProviderId;
  reviewerModel: string;
}

const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "",
  keys: {},
  baseUrl: "http://localhost:11434/v1",
  tavilyKey: "",
  useReviewer: false,
  reviewerProvider: "openai",
  reviewerModel: "",
};

function badge(score: number) {
  return score >= 75 ? "hi" : score >= 55 ? "mid" : "lo";
}
function badgeLabel(score: number) {
  return score >= 75 ? "High" : score >= 55 ? "Medium" : "Low";
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<Depth>("standard");
  const [src, setSrc] = useState({ academic: true, government: true, web: true, documents: true });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [uploadErr, setUploadErr] = useState("");

  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [queries, setQueries] = useState<string[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [report, setReport] = useState("");
  const [review, setReview] = useState("");
  const [error, setError] = useState("");
  const [flash, setFlash] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Settings (including API keys) live only in this browser's localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("research-ai-settings");
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    } catch {}
  }, []);
  const updateSettings = (patch: Partial<Settings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem("research-ai-settings", JSON.stringify(next));
      } catch {}
      return next;
    });

  const llm = useMemo<ProviderConfig>(
    () => ({
      provider: settings.provider,
      model: settings.model || undefined,
      apiKey: settings.keys[settings.provider] || undefined,
      baseUrl: settings.provider === "compat" ? settings.baseUrl : undefined,
    }),
    [settings],
  );

  const uploadFiles = async (files: FileList | null) => {
    if (!files) return;
    setUploadErr("");
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const res = await fetch("/api/extract", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        setDocs((d) => [...d.filter((x) => x.name !== data.name), { name: data.name, text: data.text }]);
      } catch (e: any) {
        setUploadErr(`${f.name}: ${e.message}`);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const run = useCallback(async () => {
    if (!question.trim() || running) return;
    setRunning(true);
    setLog([]);
    setQueries([]);
    setSources([]);
    setReport("");
    setReview("");
    setError("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const reviewer: ProviderConfig | undefined = settings.useReviewer
      ? {
          provider: settings.reviewerProvider,
          model: settings.reviewerModel || undefined,
          apiKey: settings.keys[settings.reviewerProvider] || undefined,
          baseUrl: settings.reviewerProvider === "compat" ? settings.baseUrl : undefined,
        }
      : undefined;

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          question,
          depth,
          sources: src,
          llm,
          reviewer,
          tavilyKey: settings.tavilyKey || undefined,
          documents: src.documents ? docs : [],
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const ev = JSON.parse(line.slice(5)) as ResearchEvent;
          if (ev.type === "status") setLog((l) => [...l, ev.message]);
          else if (ev.type === "plan") setQueries(ev.queries);
          else if (ev.type === "sources") setSources(ev.sources);
          else if (ev.type === "token") setReport((r) => r + ev.text);
          else if (ev.type === "review") setReview(ev.text);
          else if (ev.type === "error") setError(ev.message);
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [question, running, depth, src, llm, settings, docs]);

  const jumpTo = (n: number) => {
    const el = document.getElementById(`src-${n}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(n);
    setTimeout(() => setFlash(null), 1400);
  };

  // Turn [3] / [2][5] markers into clickable citation links.
  const linked = useMemo(
    () => report.replace(/\[(\d{1,2})\](?!\()/g, (_m, n) => `[${n}](#src-${n})`),
    [report],
  );

  const exportMarkdown = () => {
    const refs = sources
      .map(
        (s) =>
          `[${s.id}] ${s.title}${s.authors?.length ? " — " + s.authors.slice(0, 3).join(", ") : ""}${s.year ? ` (${s.year})` : ""}${s.url ? ` <${s.url}>` : ""} — credibility ${s.credibility}/100`,
      )
      .join("\n");
    const md = `# ${question}\n\n${report}\n\n## Sources\n\n${refs}\n${review ? `\n## Fact-check notes\n\n${review}\n` : ""}`;
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "research-report.md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggle = (k: keyof typeof src) => setSrc((s) => ({ ...s, [k]: !s[k] }));
  const noSources = !Object.values(src).some(Boolean);

  return (
    <main className="wrap">
      <header className="top">
        <h1 className="brand">
          Research<span>AI</span>
        </h1>
        <button className="btn ghost" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
          {showSettings ? "Close settings" : "Settings & keys"}
        </button>
      </header>
      <p className="tag">
        Ask anything. Get a report built from scholarly databases, government and institutional sources, the open web and
        your own documents — every claim cited, every source scored.
      </p>

      {showSettings && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h3>Model &amp; keys</h3>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <label className="f">Research model provider</label>
              <select value={settings.provider} onChange={(e) => updateSettings({ provider: e.target.value as ProviderId, model: "" })}>
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <label className="f">Model (blank = {DEFAULT_MODELS[settings.provider]})</label>
              <input type="text" value={settings.model} placeholder={DEFAULT_MODELS[settings.provider]} onChange={(e) => updateSettings({ model: e.target.value })} />
              <label className="f">API key for this provider</label>
              <input
                type="password"
                autoComplete="off"
                value={settings.keys[settings.provider] ?? ""}
                placeholder="Leave blank to use the server's environment variable"
                onChange={(e) => updateSettings({ keys: { ...settings.keys, [settings.provider]: e.target.value } })}
              />
              {(settings.provider === "compat" || (settings.useReviewer && settings.reviewerProvider === "compat")) && (
                <>
                  <label className="f">Base URL (OpenAI-compatible)</label>
                  <input type="text" value={settings.baseUrl} onChange={(e) => updateSettings({ baseUrl: e.target.value })} />
                  <div className="hint">Ollama must be reachable from the server, not just your laptop. On Vercel use a public endpoint (OpenRouter, Groq, …).</div>
                </>
              )}
            </div>
            <div>
              <label className="f">Web &amp; government search key (Tavily)</label>
              <input type="password" autoComplete="off" value={settings.tavilyKey} placeholder="tvly-… (free tier available)" onChange={(e) => updateSettings({ tavilyKey: e.target.value })} />
              <div className="hint">Academic sources (OpenAlex, arXiv, Crossref, PubMed) need no key.</div>
              <label className="f" style={{ marginTop: 16 }}>
                <input type="checkbox" checked={settings.useReviewer} onChange={(e) => updateSettings({ useReviewer: e.target.checked })} /> Cross-check with a second model
              </label>
              {settings.useReviewer && (
                <>
                  <select value={settings.reviewerProvider} onChange={(e) => updateSettings({ reviewerProvider: e.target.value as ProviderId, reviewerModel: "" })}>
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <input type="text" style={{ marginTop: 6 }} value={settings.reviewerModel} placeholder={DEFAULT_MODELS[settings.reviewerProvider]} onChange={(e) => updateSettings({ reviewerModel: e.target.value })} />
                  {settings.reviewerProvider !== settings.provider && (
                    <input
                      type="password"
                      autoComplete="off"
                      style={{ marginTop: 6 }}
                      value={settings.keys[settings.reviewerProvider] ?? ""}
                      placeholder="API key for the reviewer (or server env var)"
                      onChange={(e) => updateSettings({ keys: { ...settings.keys, [settings.reviewerProvider]: e.target.value } })}
                    />
                  )}
                </>
              )}
            </div>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            Keys typed here are saved only in this browser and sent to this app's server for each request. They are never stored on the server.
          </div>
        </section>
      )}

      <div className="grid">
        <div>
          <section className="card">
            <textarea
              className="q"
              value={question}
              placeholder="What do you want to find out?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
              }}
            />
            {!question && (
              <div className="row" style={{ marginTop: 8 }}>
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chip" onClick={() => setQuestion(ex)}>
                    {ex.length > 52 ? ex.slice(0, 50) + "…" : ex}
                  </button>
                ))}
              </div>
            )}
            <div className="row spread" style={{ marginTop: 12 }}>
              <div className="row">
                <button className="chip" aria-pressed={src.academic} onClick={() => toggle("academic")}>Academic</button>
                <button className="chip" aria-pressed={src.government} onClick={() => toggle("government")}>Government &amp; institutional</button>
                <button className="chip" aria-pressed={src.web} onClick={() => toggle("web")}>Web</button>
                <button className="chip" aria-pressed={src.documents} onClick={() => toggle("documents")}>My documents</button>
              </div>
              <div className="seg" role="group" aria-label="Depth">
                {(["quick", "standard", "deep"] as Depth[]).map((d) => (
                  <button key={d} aria-pressed={depth === d} onClick={() => setDepth(d)}>
                    {d[0].toUpperCase() + d.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {src.documents && (
              <div style={{ marginTop: 12 }}>
                <input ref={fileRef} type="file" multiple accept=".pdf,.txt,.md,.csv,.json,.html,.htm" onChange={(e) => uploadFiles(e.target.files)} />
                {uploadErr && <div className="err">{uploadErr}</div>}
                {docs.length > 0 && (
                  <div className="files">
                    {docs.map((d) => (
                      <div className="file" key={d.name}>
                        <span>{d.name} · {Math.round(d.text.length / 1000)}k chars</span>
                        <button className="btn ghost" onClick={() => setDocs((x) => x.filter((y) => y.name !== d.name))}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              {!running ? (
                <button className="btn" onClick={run} disabled={!question.trim() || noSources}>
                  Run research
                </button>
              ) : (
                <button className="btn stop" onClick={() => abortRef.current?.abort()}>
                  Stop
                </button>
              )}
              <span className="hint">⌘/Ctrl + Enter</span>
            </div>
            {error && <div className="err">{error}</div>}
          </section>

          {(running || log.length > 0) && (
            <section className="card">
              <h3>Progress</h3>
              <div className="log">
                {log.map((l, i) => (
                  <div key={i} className={running && i === log.length - 1 ? "live" : ""}>{l}</div>
                ))}
                {queries.length > 0 && <div>Queries: {queries.map((q) => `“${q}”`).join(" · ")}</div>}
              </div>
            </section>
          )}

          {report && (
            <section className="card">
              <div className="row spread" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>Report</h3>
                {!running && (
                  <div className="row">
                    <button className="btn ghost" onClick={() => navigator.clipboard.writeText(report)}>Copy</button>
                    <button className="btn ghost" onClick={exportMarkdown}>Download .md</button>
                  </div>
                )}
              </div>
              <div className="report">
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => {
                      const m = href?.match(/^#src-(\d+)$/);
                      if (m) {
                        return (
                          <button className="cite" onClick={() => jumpTo(Number(m[1]))} aria-label={`Source ${m[1]}`}>
                            {children}
                          </button>
                        );
                      }
                      return (
                        <a href={href} target="_blank" rel="noreferrer noopener">
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {linked}
                </ReactMarkdown>
              </div>
              {review && (
                <div className="review">
                  <h4>Second-model fact-check</h4>
                  <ReactMarkdown>{review}</ReactMarkdown>
                </div>
              )}
              <p className="disclaimer">
                AI-generated from the sources listed. Verify important claims against the originals, especially for medical, legal or financial decisions.
              </p>
            </section>
          )}
        </div>

        <aside>
          <section className="card">
            <h3>Sources {sources.length ? `(${sources.length})` : ""}</h3>
            {sources.length === 0 && <div className="empty">Sources appear here, ranked by credibility and relevance.</div>}
            {sources.map((s) => (
              <div key={s.id} id={`src-${s.id}`} className={`src ${flash === s.id ? "flash" : ""}`}>
                <div className="t">
                  <span className="n">{s.id}</span>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>
                  ) : (
                    s.title
                  )}
                </div>
                <div className="m">
                  <span className="kind">{s.kind}</span> · {s.origin}
                  {s.year ? ` · ${s.year}` : ""}
                  {s.venue ? ` · ${s.venue}` : ""}
                  {typeof s.citations === "number" ? ` · ${s.citations.toLocaleString()} cites` : ""}
                  <span className={`badge ${badge(s.credibility)}`}>{badgeLabel(s.credibility)} {s.credibility}</span>
                </div>
                {s.authors && s.authors.length > 0 && <div className="m">{s.authors.slice(0, 3).join(", ")}{s.authors.length > 3 ? " et al." : ""}</div>}
                <details className="why">
                  <summary>Why this score?</summary>
                  <ul>{s.credibilityNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                </details>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </main>
  );
}
