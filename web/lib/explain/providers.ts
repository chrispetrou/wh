// provider request shapes and stream decoding; mirrors cli/src/llm.rs.
// keys arrive per request and are never stored or logged.

export type ProviderName = "anthropic" | "openai";

export function detectProvider(key: string): ProviderName {
  return key.startsWith("sk-ant-") ? "anthropic" : "openai";
}

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5-mini",
};

// model ids as accepted by providers; also guards the request body
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// reasoning effort levels each provider understands (anthropic:
// output_config.effort; openai: reasoning_effort). model support varies;
// an unsupported combination surfaces as a provider error.
export const EFFORTS: Record<ProviderName, string[]> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["minimal", "low", "medium", "high"],
};

function effortBody(provider: ProviderName, effort?: string) {
  if (!effort) return {};
  return provider === "anthropic"
    ? { output_config: { effort } }
    : { reasoning_effort: effort };
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
    url: `${process.env.WD_OPENAI_URL ?? "https://api.openai.com"}/v1/chat/completions`,
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
    url: `${process.env.WD_OPENAI_URL ?? "https://api.openai.com"}/v1/chat/completions`,
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

interface OpenAiEvent {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

export function extractText(provider: ProviderName, json: string): string {
  try {
    if (provider === "anthropic") {
      const ev = JSON.parse(json) as AnthropicEvent;
      return ev.type === "content_block_delta" ? (ev.delta?.text ?? "") : "";
    }
    const ev = JSON.parse(json) as OpenAiEvent;
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
