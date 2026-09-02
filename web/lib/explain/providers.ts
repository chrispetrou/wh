// provider request shapes and stream decoding; mirrors cli/src/llm.rs.
// keys arrive per request and are never stored or logged.

import { fmtWait, hostOf, waitFrom, type HeaderBag } from "./usage";

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
  // openai superseded the gpt-5/-mini/-nano family with gpt-5.6
  // sol/terra/luna; terra is their balanced tier, like mini was
  openai: "gpt-5.6-terra",
  // groq retired llama-3.3-70b-versatile on 2026-08-16
  groq: "openai/gpt-oss-120b",
};

// providers with a no-cost tier, for the "free" note in the terminal
export const FREE_TIER: ProviderName[] = ["groq"];

// what the terminal suggests for /model; the default comes first
export const SUGGESTED_MODELS: Record<ProviderName, string[]> = {
  anthropic: ["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
  groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
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
  // the full documented range for gpt-5.6; which subset a model takes
  // varies, and an unsupported pick surfaces as a provider error
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
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

// a failed provider call, in our words: the message the provider sent
// (never its raw json), the usual cases recognized, and a hint with the
// way out where there is one. the classes and wording are the contract
// in shared/prompts/provider.md
export interface ProviderFailure {
  status: number;
  error: string;
  hint?: string;
}

// where each provider lives, and where its money is; the one part of the
// contract likely to drift
export const PROVIDER_HOSTS: Record<ProviderName, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  groq: "api.groq.com",
};
const BILLING_URLS: Record<ProviderName, string> = {
  anthropic: "platform.claude.com/settings/billing",
  openai: "platform.openai.com/settings/organization/billing",
  groq: "console.groq.com/settings/billing",
};
const LIMIT_URLS: Record<ProviderName, string> = {
  anthropic: "platform.claude.com/settings/limits",
  openai: "platform.openai.com/settings/organization/limits",
  groq: "console.groq.com/settings/limits",
};

interface ErrorBody {
  error?: { message?: string; code?: string; type?: string; details?: { error_code?: string } } | string;
  message?: string;
}

function parseError(body: string): ErrorBody | null {
  try {
    const j = JSON.parse(body.trim()) as unknown;
    return j && typeof j === "object" ? (j as ErrorBody) : null;
  } catch {
    return null;
  }
}

// the message inside the usual error bodies: {"error":{"message":..}}
// (openai, groq, anthropic), {"error":".."} (ollama), or the text itself
function providerMessage(body: string): string {
  const j = parseError(body);
  if (j) {
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (typeof m === "string" && m.trim()) return m.trim().replace(/\s+/g, " ");
  }
  return body.trim().replace(/\s+/g, " ").slice(0, 300);
}

// the codes a body carries: openai error.code, anthropic error.type and
// error.details.error_code
function providerCodes(body: string): string[] {
  const j = parseError(body);
  if (!j || typeof j.error !== "object" || !j.error) return [];
  return [j.error.code, j.error.type, j.error.details?.error_code].filter(
    (c): c is string => typeof c === "string"
  );
}

const CREDIT_CODES = ["billing_error", "insufficient_quota", "credit_balance_exhausted"];
const SPEND_CODES = [
  "enforced_spend_limit_reached",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
];

// never "tokens per minute" on its own: that is a momentary 429
const TOO_LARGE =
  /request_too_large|too large|too long|context length|maximum context|too many tokens|context_length_exceeded/i;

// "Limit 8000, Requested 17842" (groq), "maximum context length is 8192
// tokens. However, you requested 17842 tokens" (openai), "213000 tokens >
// 200000 maximum" (anthropic)
function tokenCounts(m: string): { requested: number; limit: number } | null {
  let r = /limit (\d+), requested (\d+)/i.exec(m);
  if (r) return { limit: +r[1], requested: +r[2] };
  r = /context length is (\d+) tokens.*?requested (\d+) tokens/i.exec(m);
  if (r) return { limit: +r[1], requested: +r[2] };
  r = /(\d+) tokens > (\d+) maximum/i.exec(m);
  if (r) return { requested: +r[1], limit: +r[2] };
  return null;
}

export interface FailureContext {
  provider?: ProviderName;
  headers?: HeaderBag;
}

// status first, then the body, in the order shared/prompts/provider.md
// lists the classes. status 0 means "no status": an error frame that
// came mid-stream, classified by its body alone
export function providerFailure(
  status: number,
  body: string,
  model: string,
  ctx: FailureContext = {}
): ProviderFailure {
  const message = providerMessage(body);
  const lower = message.toLowerCase();
  const codes = providerCodes(body);
  const who = ctx.provider ? `your ${ctx.provider} key` : "the key";
  const billing = ctx.provider ? BILLING_URLS[ctx.provider] : "the provider's billing page";
  const limits = ctx.provider ? LIMIT_URLS[ctx.provider] : "the provider's limits page";

  if (status === 401 || status === 403) {
    return { status: 401, error: "provider rejected the key", hint: "/key <value> replaces it" };
  }
  if (
    status === 402 ||
    codes.some((c) => CREDIT_CODES.includes(c)) ||
    lower.includes("credit balance")
  ) {
    return {
      status: 402,
      error: `${who} is out of credit`,
      hint: `top up at ${billing}, or /model another provider's`,
    };
  }
  if (
    codes.some((c) => SPEND_CODES.includes(c)) ||
    lower.includes("specified api usage limits") ||
    lower.includes("spend limit")
  ) {
    return { status: 402, error: `${who} hit its spend limit`, hint: `raise it at ${limits}` };
  }
  if (status === 429 && (lower.includes("used ") || lower.includes("try again in"))) {
    const wait = waitFrom(ctx.headers, message);
    if (/per day|\btpd\b|\brpd\b/i.test(message)) {
      return {
        status: 429,
        error: `provider daily limit reached, resets ${wait === null ? "tomorrow" : `in ${fmtWait(wait)}`}`,
      };
    }
    return { status: 429, error: rateLimitLine(wait) };
  }
  if (TOO_LARGE.test(message)) {
    const n = tokenCounts(message);
    const size = n ? `: ${n.requested} tokens, limit ${n.limit}` : "";
    return {
      status: 413,
      error: `the diff is too big for ${model}${size}`,
      hint: "try fewer commits, cut it to a path (add: in src/), or /model one with a larger context",
    };
  }
  if (status === 429) {
    return { status: 429, error: rateLimitLine(waitFrom(ctx.headers, message)) };
  }
  if (status === 404 || /model.*not (found|exist)|does not exist|unknown model/i.test(message)) {
    return { status: 404, error: `provider has no model ${model}`, hint: "/model lists the ones it knows" };
  }
  if (status >= 500 || codes.includes("overloaded_error") || lower.includes("overloaded")) {
    return { status: 503, error: "provider is overloaded, try again in a moment" };
  }
  return { status: 502, error: `provider error: ${message}` };
}

function rateLimitLine(wait: number | null): string {
  return wait === null
    ? "provider rate limit, try again in a moment"
    : `provider rate limit, try again in ${fmtWait(wait)}`;
}

// the request never got an answer: dns, tls, a refused connection
export function networkFailure(url: string): ProviderFailure {
  return { status: 502, error: `could not reach ${hostOf(url)}` };
}

// the answer stopped partway
export function droppedFailure(url: string): ProviderFailure {
  return { status: 502, error: `lost the connection to ${hostOf(url)}` };
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
      // the last chunk then carries usage (openai and groq both honor it)
      stream_options: { include_usage: true },
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
      // the last chunk then carries usage (openai and groq both honor it)
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: question },
      ],
      ...effortBody(provider, effort),
    }),
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicEvent {
  type?: string;
  delta?: { text?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

// openai and groq share this shape
interface ChatCompletionsEvent {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: ChatUsage | null;
  x_groq?: { usage?: ChatUsage };
  error?: unknown;
}

// tokens one answer cost, as the provider reported them
export interface Usage {
  in: number;
  out: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// one provider stream, frame by frame: the text of each, plus what the
// non-text frames carry (usage, an error where a chunk should be). see
// "usage" in shared/prompts/provider.md
export class StreamDecoder {
  usage: Usage | null = null;
  error: string | null = null;

  constructor(private readonly provider: ProviderName) {}

  line(json: string): string {
    let ev: unknown;
    try {
      ev = JSON.parse(json);
    } catch {
      return "";
    }
    if (!ev || typeof ev !== "object") return "";
    if (this.provider === "anthropic") {
      const a = ev as AnthropicEvent;
      if (a.type === "message_start") {
        const u = a.message?.usage;
        if (u) {
          this.usage = {
            in: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
            out: this.usage?.out ?? 0,
          };
        }
        return "";
      }
      if (a.type === "message_delta") {
        // cumulative: the last one wins, never message_start's
        if (a.usage && typeof a.usage.output_tokens === "number") {
          this.usage = { in: this.usage?.in ?? 0, out: a.usage.output_tokens };
        }
        return "";
      }
      if (a.type === "error") {
        this.error ??= json;
        return "";
      }
      return a.type === "content_block_delta" ? (a.delta?.text ?? "") : "";
    }
    const c = ev as ChatCompletionsEvent;
    const u = c.usage ?? c.x_groq?.usage;
    if (u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")) {
      this.usage = {
        in: u.prompt_tokens ?? this.usage?.in ?? 0,
        out: u.completion_tokens ?? this.usage?.out ?? 0,
      };
    }
    if (c.error !== undefined && !c.choices) {
      this.error ??= json;
      return "";
    }
    return c.choices?.[0]?.delta?.content ?? "";
  }
}

export function extractText(provider: ProviderName, json: string): string {
  return new StreamDecoder(provider).line(json);
}

// provider sse/ndjson bytes -> plain text chunks; the decoder keeps what
// the stream said besides text
export function decodeStream(provider: ProviderName): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  decoder: StreamDecoder;
} {
  const bytes = new TextDecoder();
  const encoder = new TextEncoder();
  const decoder = new StreamDecoder(provider);
  let buf = "";
  const take = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const trimmed = line.trim();
    const json = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
    if (!json || json === "[DONE]" || !json.startsWith("{")) return;
    const text = decoder.line(json);
    if (text) controller.enqueue(encoder.encode(text));
  };
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += bytes.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        take(line, controller);
      }
    },
    flush(controller) {
      // a last frame without its newline
      if (buf) take(buf, controller);
      buf = "";
    },
  });
  return { stream, decoder };
}

export function sseToText(provider: ProviderName): TransformStream<Uint8Array, Uint8Array> {
  return decodeStream(provider).stream;
}
