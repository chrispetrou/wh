// provider request shapes and stream decoding; mirrors cli/src/llm.rs.
// keys arrive per request and are never stored or logged.

export type ProviderName = "anthropic" | "openai" | "groq";

// key prefixes are disjoint; openai stays the fallback, so any future
// provider needs its own prefix here
export function detectProvider(key: string): ProviderName {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("gsk_")) return "groq";
  return "openai";
}

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5-mini",
  groq: "llama-3.3-70b-versatile",
};

// providers with a no-cost tier, for the "free" note in the terminal
export const FREE_TIER: ProviderName[] = ["groq"];

// what the terminal suggests for /model; the default comes first
export const SUGGESTED_MODELS: Record<ProviderName, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5-mini", "gpt-5"],
  groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
};

// which provider a model id belongs to, when that can be told: exact
// suggestion hits first (openai/gpt-oss-120b is groq's), then the
// family prefix; null for ids like llama-* that several hosts serve
export function modelFamily(id: string): ProviderName | null {
  for (const p of Object.keys(SUGGESTED_MODELS) as ProviderName[]) {
    if (SUGGESTED_MODELS[p].includes(id)) return p;
  }
  const lower = id.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt")) return "openai";
  return null;
}

// model ids as accepted by providers; also guards the request body. the
// slash is for groq ids like openai/gpt-oss-120b; ids only ever land in
// a json body, never a url.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

// reasoning effort levels each provider understands (anthropic:
// output_config.effort; openai: reasoning_effort; groq: none, its llama
// models take no effort level). model support varies; an unsupported
// combination surfaces as a provider error.
export const EFFORTS: Record<ProviderName, string[]> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["minimal", "low", "medium", "high"],
  groq: [],
};

function effortBody(provider: ProviderName, effort?: string) {
  if (!effort || EFFORTS[provider].length === 0) return {};
  return provider === "anthropic"
    ? { output_config: { effort } }
    : { reasoning_effort: effort };
}

// groq speaks the openai chat-completions dialect at its own host
function chatCompletionsUrl(provider: "openai" | "groq"): string {
  const base =
    provider === "groq"
      ? (process.env.WD_GROQ_URL ?? "https://api.groq.com/openai")
      : (process.env.WD_OPENAI_URL ?? "https://api.openai.com");
  return `${base}/v1/chat/completions`;
}

export interface ProviderRequest {
  url: string;
  headers: HeadersInit;
  body: string;
}

export function buildRequest(
  provider: ProviderName,
  key: string,
  system: string,
  user: string,
  model?: string,
  effort?: string
): ProviderRequest {
  const chosen = model || DEFAULT_MODELS[provider];
  if (provider === "anthropic") {
    return {
      url: `${process.env.WD_ANTHROPIC_URL ?? "https://api.anthropic.com"}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: chosen,
        max_tokens: 4096,
        stream: true,
        system,
        messages: [{ role: "user", content: user }],
        ...effortBody(provider, effort),
      }),
    };
  }
  return {
    url: chatCompletionsUrl(provider),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: chosen,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...effortBody(provider, effort),
    }),
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// follow-up turn: prior history plus the new question. the first user
// message (the diff payload) gets an anthropic cache breakpoint so
// repeated follow-ups reuse the cached prefix.
export function buildFollowupRequest(
  provider: ProviderName,
  key: string,
  system: string,
  history: ChatMessage[],
  question: string,
  model?: string,
  effort?: string
): ProviderRequest {
  const chosen = model || DEFAULT_MODELS[provider];
  if (provider === "anthropic") {
    const messages = history.map((m, i) =>
      i === 0
        ? {
            role: m.role,
            content: [
              {
                type: "text",
                text: m.content,
                cache_control: { type: "ephemeral" },
              },
            ],
          }
        : { role: m.role, content: m.content }
    );
    return {
      url: `${process.env.WD_ANTHROPIC_URL ?? "https://api.anthropic.com"}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: chosen,
        max_tokens: 4096,
        stream: true,
        system,
        messages: [...messages, { role: "user", content: question }],
        ...effortBody(provider, effort),
      }),
    };
  }
  return {
    url: chatCompletionsUrl(provider),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: chosen,
      stream: true,
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: question },
      ],
      ...effortBody(provider, effort),
    }),
  };
}

interface AnthropicEvent {
  type?: string;
  delta?: { text?: string };
}

// openai and groq share this shape
interface ChatCompletionsEvent {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

export function extractText(provider: ProviderName, json: string): string {
  try {
    if (provider === "anthropic") {
      const ev = JSON.parse(json) as AnthropicEvent;
      return ev.type === "content_block_delta" ? (ev.delta?.text ?? "") : "";
    }
    const ev = JSON.parse(json) as ChatCompletionsEvent;
    return ev.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

// provider sse/ndjson bytes -> plain text chunks
export function sseToText(provider: ProviderName): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const json = line.startsWith("data: ") ? line.slice(6) : line;
        if (!json || json === "[DONE]" || !json.startsWith("{")) continue;
        const text = extractText(provider, json);
        if (text) controller.enqueue(encoder.encode(text));
      }
    },
  });
}
