import { DEFAULT_MODELS, ProviderConfig } from "./types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
}

function resolveKey(cfg: ProviderConfig): string {
  const env = process.env;
  const key =
    cfg.apiKey ||
    (cfg.provider === "anthropic"
      ? env.ANTHROPIC_API_KEY
      : cfg.provider === "openai"
        ? env.OPENAI_API_KEY
        : cfg.provider === "gemini"
          ? env.GEMINI_API_KEY
          : env.OPENAI_COMPAT_API_KEY || "none");
  if (!key) {
    throw new Error(
      `No API key for "${cfg.provider}". Add it in Settings or set the environment variable.`,
    );
  }
  return key;
}

async function failIfBad(res: Response, who: string) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${who} error ${res.status}: ${body.slice(0, 400)}`);
  }
}

/** Parse an SSE stream, yielding each `data:` payload string. */
async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

/** Stream tokens from the chosen provider. */
export async function* streamLLM(
  cfg: ProviderConfig,
  opts: CompleteOptions,
): AsyncGenerator<string> {
  const model = cfg.model || DEFAULT_MODELS[cfg.provider];
  const key = resolveKey(cfg);
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.2;

  if (cfg.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: opts.system,
        messages: opts.messages,
        stream: true,
      }),
    });
    await failIfBad(res, "Anthropic");
    for await (const data of sseLines(res)) {
      try {
        const ev = JSON.parse(data);
        if (ev.type === "content_block_delta" && ev.delta?.text) yield ev.delta.text;
      } catch {}
    }
    return;
  }

  if (cfg.provider === "openai" || cfg.provider === "compat") {
    const base =
      cfg.provider === "openai"
        ? "https://api.openai.com/v1"
        : (cfg.baseUrl || process.env.OPENAI_COMPAT_BASE_URL || "").replace(/\/$/, "");
    if (!base) throw new Error("Set a base URL for the OpenAI-compatible provider.");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature,
        stream: true,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          ...(opts.system ? [{ role: "system", content: opts.system }] : []),
          ...opts.messages,
        ],
      }),
    });
    await failIfBad(res, cfg.provider === "openai" ? "OpenAI" : "Compatible API");
    for await (const data of sseLines(res)) {
      if (data === "[DONE]") break;
      try {
        const t = JSON.parse(data).choices?.[0]?.delta?.content;
        if (t) yield t;
      } catch {}
    }
    return;
  }

  // Gemini
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: opts.system ? { parts: [{ text: opts.system }] } : undefined,
      contents: opts.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });
  await failIfBad(res, "Gemini");
  for await (const data of sseLines(res)) {
    try {
      const parts = JSON.parse(data).candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) if (p.text) yield p.text;
    } catch {}
  }
}

/** Non-streaming convenience wrapper. */
export async function completeLLM(cfg: ProviderConfig, opts: CompleteOptions): Promise<string> {
  let out = "";
  for await (const t of streamLLM(cfg, opts)) out += t;
  return out;
}

/** Ask for JSON and parse defensively. */
export async function completeJSON<T>(cfg: ProviderConfig, opts: CompleteOptions): Promise<T> {
  const text = await completeLLM(cfg, { ...opts, json: true, temperature: 0 });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model did not return JSON.");
  return JSON.parse(match[0]) as T;
}
