// provider request shapes and stream decoding; mirrors cli/src/llm.rs.
// keys arrive per request and are never stored or logged.

export type ProviderName = "anthropic" | "openai";

export function detectProvider(key: string): ProviderName {
  return key.startsWith("sk-ant-") ? "anthropic" : "openai";
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
  user: string
): ProviderRequest {
  if (provider === "anthropic") {
    return {
      url: `${process.env.WD_ANTHROPIC_URL ?? "https://api.anthropic.com"}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 4096,
        stream: true,
        system,
        messages: [{ role: "user", content: user }],
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
      model: "gpt-5-mini",
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
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
