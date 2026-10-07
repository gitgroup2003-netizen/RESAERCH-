export type SourceKind = "academic" | "government" | "web" | "document";

export interface Source {
  id: number; // citation number [n]
  kind: SourceKind;
  title: string;
  url: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  citations?: number;
  abstract?: string;
  content?: string; // full text / extracted passage fed to the LLM
  origin: string; // e.g. "OpenAlex", "arXiv", "Tavily"
  credibility: number; // 0-100
  credibilityNotes: string[];
}

export type ProviderId = "anthropic" | "openai" | "gemini" | "compat";

export interface ProviderConfig {
  provider: ProviderId;
  model?: string;
  apiKey?: string; // BYOK from the browser; falls back to env
  baseUrl?: string; // for compat
}

export interface UploadedDoc {
  name: string;
  text: string;
}

export interface ResearchRequest {
  question: string;
  depth: "quick" | "standard" | "deep";
  sources: {
    academic: boolean;
    government: boolean;
    web: boolean;
    documents: boolean;
  };
  llm: ProviderConfig;
  /** optional second provider used to fact-check the draft */
  reviewer?: ProviderConfig;
  tavilyKey?: string;
  documents?: UploadedDoc[];
}

export type ResearchEvent =
  | { type: "status"; message: string }
  | { type: "plan"; queries: string[]; subquestions: string[] }
  | { type: "sources"; sources: Source[] }
  | { type: "token"; text: string }
  | { type: "review"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-4.1",
  gemini: "gemini-2.5-pro",
  compat: "llama3.1",
};
