# Research AI

A web app that answers research questions with **cited reports built from verified sources**.

**How it works**

1. **Plan** – the LLM splits your question into sub-questions and search queries.
2. **Search** – in parallel across:
   - **Academic**: OpenAlex, arXiv, Crossref, PubMed (no keys needed)
   - **Government & institutional**: `.gov`, `.edu`, WHO, UN, World Bank, IMF, OECD, EU… (via Tavily domain filter)
   - **Web**: general search (via Tavily)
   - **Your documents**: upload PDF / TXT / MD / CSV / JSON / HTML
3. **Score** – every source gets a transparent 0–100 credibility score (domain type, DOI, venue, citations, recency, preprint status). Click "Why this score?" on any source.
4. **Read** – the best web/government pages are fetched in full.
5. **Write** – the model must cite every claim as `[n]` using only the supplied sources, flag disagreements, and list gaps.
6. **Cross-check (optional)** – a *second, different* model audits the report against the sources.

**Models**: Claude, OpenAI, Gemini, or any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama…). Switch in Settings.

---

## Run it

```bash
npm install
cp .env.example .env.local   # add at least one LLM key (and a Tavily key for web/gov search)
npm run dev                  # http://localhost:3000
```

No keys in env? You can paste your own in **Settings & keys** — they stay in your browser's localStorage and are sent per request, never stored server-side.

## Put it on GitHub and deploy

```bash
git init && git add -A && git commit -m "Research AI"
git branch -M main
git remote add origin https://github.com/<you>/research-ai.git
git push -u origin main
```

**Vercel (recommended):** vercel.com → *Add New Project* → import the repo → add the env vars from `.env.example` → Deploy. Every push redeploys.
> Long "Deep" runs can exceed the free plan's function time limit. Use *Quick/Standard* on the free tier, or lower `maxDuration` in `app/api/research/route.ts` to match your plan.

**StackBlitz:** open `https://stackblitz.com/github/<you>/research-ai`. Add keys in Settings (browser) since StackBlitz has no server env.

> GitHub Pages alone can't host this — the app needs server routes (API keys, streaming, PDF parsing). Use GitHub for the code and Vercel for hosting.

## Project map

```
app/page.tsx              UI (settings, sources, live progress, cited report)
app/api/research/route.ts streaming (SSE) research endpoint
app/api/extract/route.ts  PDF/text extraction for uploads
lib/research.ts           the pipeline: plan → search → score → read → write → review
lib/llm.ts                Claude / OpenAI / Gemini / compatible, streaming
lib/credibility.ts        transparent scoring rules (edit these!)
lib/sources/academic.ts   OpenAlex, arXiv, Crossref, PubMed
lib/sources/web.ts        Tavily web + government search, page fetcher
```

## Limits to know

- Citations are enforced by prompt, then optionally audited by a second model — not mathematically guaranteed. Spot-check what matters.
- Credibility scores are heuristics, not truth. Tune `lib/credibility.ts` for your field.
- Scanned PDFs need OCR before upload.
