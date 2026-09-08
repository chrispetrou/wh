import { afterEach, describe, expect, it } from "vitest";
import { decodeStream, droppedFailure, networkFailure, providerFailure, StreamDecoder } from "./providers";
import {
  buildFollowupRequest,
  buildRequest,
  DEFAULT_MODELS,
  detectProvider,
  EFFORTS,
  extractText,
  isChatModel,
  MODEL_RE,
  modelFamily,
  modelIds,
  MODELS_CAP,
  modelsUrl,
  SUGGESTED_MODELS,
  type ProviderName,
} from "./providers";

describe("modelFamily", () => {
  it("resolves suggestions exactly, then by prefix", () => {
    expect(modelFamily("claude-opus-5")).toBe("anthropic");
    expect(modelFamily("claude-fable-5")).toBe("anthropic");
    expect(modelFamily("claude-3-7-sonnet")).toBe("anthropic");
    expect(modelFamily("gpt-5.6-terra")).toBe("openai");
    expect(modelFamily("gpt-5")).toBe("openai");
    expect(modelFamily("openai/gpt-oss-120b")).toBe("groq");
    // llama ids are served by several hosts, so they name no provider
    expect(modelFamily("llama-3.3-70b-versatile")).toBeNull();
    expect(modelFamily("mixtral-8x7b")).toBeNull();
  });
  it("lists the default first for every provider", () => {
    for (const p of Object.keys(SUGGESTED_MODELS) as Array<keyof typeof SUGGESTED_MODELS>) {
      expect(SUGGESTED_MODELS[p][0]).toBe(DEFAULT_MODELS[p]);
    }
  });
});

describe("detectProvider", () => {
  it("routes by key prefix, openai as the fallback", () => {
    expect(detectProvider("sk-ant-x")).toBe("anthropic");
    expect(detectProvider("gsk_x")).toBe("groq");
    expect(detectProvider("sk-proj-x")).toBe("openai");
    expect(detectProvider("")).toBe("openai");
  });
});

describe("groq defaults", () => {
  it("has a default model and the gpt-oss effort range", () => {
    expect(DEFAULT_MODELS.groq).toBe("openai/gpt-oss-120b");
    expect(EFFORTS.groq).toEqual(["low", "medium", "high"]);
  });
});

describe("MODEL_RE", () => {
  it("accepts vendor-prefixed groq ids", () => {
    expect(MODEL_RE.test("llama-3.3-70b-versatile")).toBe(true);
    expect(MODEL_RE.test("openai/gpt-oss-120b")).toBe(true);
    expect(MODEL_RE.test("gpt-5.6-terra")).toBe(true);
    expect(MODEL_RE.test("claude-opus-5")).toBe(true);
  });
  it("rejects a leading slash, spaces, and overlong ids", () => {
    expect(MODEL_RE.test("/x")).toBe(false);
    expect(MODEL_RE.test("a b")).toBe(false);
    expect(MODEL_RE.test("a".repeat(65))).toBe(false);
  });
});

describe("buildRequest for groq", () => {
  afterEach(() => {
    delete process.env.WH_GROQ_URL;
  });

  it("uses the openai dialect at groq's host", () => {
    const r = buildRequest("groq", "gsk_x", "sys", "usr");
    expect(r.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((r.headers as Record<string, string>).authorization).toBe("Bearer gsk_x");
    const body = JSON.parse(r.body);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1]).toEqual({ role: "user", content: "usr" });
  });

  it("sends reasoning_effort for groq and openai alike", () => {
    const groq = JSON.parse(buildRequest("groq", "gsk_x", "s", "u", undefined, "high").body);
    expect(groq.reasoning_effort).toBe("high");
    const openai = JSON.parse(buildRequest("openai", "sk-x", "s", "u", undefined, "high").body);
    expect(openai.reasoning_effort).toBe("high");
  });

  it("honours WH_GROQ_URL", () => {
    process.env.WH_GROQ_URL = "http://127.0.0.1:1234";
    expect(buildRequest("groq", "gsk_x", "s", "u").url).toBe(
      "http://127.0.0.1:1234/v1/chat/completions"
    );
  });

  it("splices follow-up history between system and question", () => {
    const history = [
      { role: "user" as const, content: "diff" },
      { role: "assistant" as const, content: "summary" },
    ];
    const r = buildFollowupRequest("groq", "gsk_x", "sys", history, "why?");
    expect(r.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(r.body);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[3].content).toBe("why?");
  });
});

describe("extractText for groq", () => {
  it("reads delta content and ignores the usage tail", () => {
    expect(extractText("groq", '{"choices":[{"delta":{"content":"hi"}}]}')).toBe("hi");
    expect(
      extractText("groq", '{"choices":[{"delta":{},"finish_reason":"stop"}],"x_groq":{"usage":{}}}')
    ).toBe("");
  });
});

describe("providerFailure", () => {
  const groq = (message: string, type = "tokens") => JSON.stringify({ error: { message, type } });
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

  it("turns a too-large body into our words, with the counts and a way out", () => {
    const body = groq(
      "Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 17842, please reduce your message size and try again."
    );
    const f = providerFailure(413, body, "openai/gpt-oss-120b");
    expect(f).toEqual({
      status: 413,
      error: "the diff is too big for openai/gpt-oss-120b: 17842 tokens, limit 8000",
      hint: "try fewer commits, cut it to a path (add: in src/), or /model one with a larger context",
    });
    // no org id, no raw json
    expect(f.error).not.toContain("org_x");

    const openai = JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 8192 tokens. However, you requested 17842 tokens (17842 in the messages, 0 in the completion). Please reduce the length.",
      },
    });
    expect(providerFailure(400, openai, "gpt-5-mini").error).toBe(
      "the diff is too big for gpt-5-mini: 17842 tokens, limit 8192"
    );
    const anthropic = JSON.stringify({
      error: { message: "prompt is too long: 213000 tokens > 200000 maximum" },
    });
    expect(providerFailure(400, anthropic, "claude-opus-5").error).toBe(
      "the diff is too big for claude-opus-5: 213000 tokens, limit 200000"
    );
  });

  it("tells a momentary groq 429 apart from a too-large request", () => {
    const tpm = groq(
      "Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 1500. Please try again in 5.2s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing"
    );
    expect(providerFailure(429, tpm, "llama-3.3-70b-versatile", { provider: "groq" })).toEqual({
      status: 429,
      error: "provider rate limit, try again in 6s",
    });
    const tpd = groq(
      "Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` on tokens per day (TPD): Limit 100000, Used 99000, Requested 5000. Please try again in 1h23m."
    );
    expect(providerFailure(429, tpd, "m", { provider: "groq" }).error).toBe(
      "provider daily limit reached, resets in 1h 23m"
    );
    expect(
      providerFailure(429, groq("Rate limit reached on requests per day (RPD): Limit 1000, Used 1000, Requested 1"), "m")
        .error
    ).toBe("provider daily limit reached, resets tomorrow");
  });

  it("recognizes keys, rate limits, and unknown models", () => {
    expect(providerFailure(401, "{}", "m")).toEqual({
      status: 401,
      error: "provider rejected the key",
      hint: "/key <value> replaces it",
    });
    expect(providerFailure(403, "{}", "m").error).toBe("provider rejected the key");
    expect(providerFailure(429, '{"error":{"message":"Rate limit reached"}}', "m")).toEqual({
      status: 429,
      error: "provider rate limit, try again in a moment",
    });
    expect(
      providerFailure(429, '{"error":{"message":"Rate limit reached"}}', "m", {
        headers: headers({ "retry-after": "12" }),
      }).error
    ).toBe("provider rate limit, try again in 12s");
    expect(
      providerFailure(429, '{"error":{"message":"Rate limit reached"}}', "m", {
        headers: headers({ "x-ratelimit-reset-tokens": "2m59.56s" }),
      }).error
    ).toBe("provider rate limit, try again in 3m");
    expect(providerFailure(404, '{"error":{"message":"The model `x` does not exist"}}', "x")).toEqual({
      status: 404,
      error: "provider has no model x",
      hint: "/model lists the ones it knows",
    });
  });

  it("names an empty balance and a spend limit, with where to fix them", () => {
    const anthropic402 = JSON.stringify({
      type: "error",
      error: { type: "billing_error", message: "Your credit balance is too low to access the Anthropic API." },
    });
    expect(providerFailure(402, anthropic402, "claude-opus-5", { provider: "anthropic" })).toEqual({
      status: 402,
      error: "your anthropic key is out of credit",
      hint: "top up at platform.claude.com/settings/billing, or /model another provider's",
    });
    const openaiQuota = JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    expect(providerFailure(429, openaiQuota, "gpt-5-mini", { provider: "openai" })).toEqual({
      status: 402,
      error: "your openai key is out of credit",
      hint: "top up at platform.openai.com/settings/organization/billing, or /model another provider's",
    });
    const anthropicSpend = JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "You have reached your API usage limits: your organization has crossed its monthly API usage threshold.",
        details: { error_code: "enforced_spend_limit_reached" },
      },
    });
    expect(providerFailure(429, anthropicSpend, "m", { provider: "anthropic" })).toEqual({
      status: 402,
      error: "your anthropic key hit its spend limit",
      hint: "raise it at platform.claude.com/settings/limits",
    });
    const anthropicOwn = JSON.stringify({
      error: { type: "invalid_request_error", message: "You have reached your specified API usage limits. Access resumes on 2026-09-01." },
    });
    expect(providerFailure(400, anthropicOwn, "m", { provider: "anthropic" }).error).toBe(
      "your anthropic key hit its spend limit"
    );
    const openaiSpend = JSON.stringify({
      error: { message: "Project spend limit reached", code: "project_spend_limit_exceeded" },
    });
    expect(providerFailure(429, openaiSpend, "m", { provider: "openai" }).hint).toBe(
      "raise it at platform.openai.com/settings/organization/limits"
    );
    // without a provider the line still reads
    expect(providerFailure(402, "{}", "m").error).toBe("the key is out of credit");
  });

  it("calls a server failure overloaded", () => {
    expect(providerFailure(500, '{"error":{"message":"overloaded"}}', "m")).toEqual({
      status: 503,
      error: "provider is overloaded, try again in a moment",
    });
    expect(providerFailure(529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}', "m").status).toBe(503);
    expect(providerFailure(503, '{"error":{"message":"The engine is currently overloaded, please try again later"}}', "m").error).toBe(
      "provider is overloaded, try again in a moment"
    );
    expect(providerFailure(502, "<html>bad gateway</html>", "m").error).toBe(
      "provider is overloaded, try again in a moment"
    );
    // an error frame after text, no status: still classified
    expect(providerFailure(0, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "m").status).toBe(503);
  });

  it("falls back to the provider's message, never its json", () => {
    expect(providerFailure(500, '{"error":"model not found"}', "m").error).toBe(
      "provider has no model m"
    );
    expect(providerFailure(400, '{"error":{"message":"Unrecognized request argument: stream_options"}}', "m")).toEqual({
      status: 502,
      error: "provider error: Unrecognized request argument: stream_options",
    });
    // the message is lifted out of the envelope for every class
    for (const status of [400, 401, 402, 404, 413, 429, 500, 529]) {
      const f = providerFailure(status, '{"error":{"message":"something odd","type":"x"}}', "m");
      expect(f.error).not.toContain('"error"');
      expect(f.error).not.toContain('"type"');
    }
  });

  it("names the host that could not be reached", () => {
    expect(networkFailure("https://api.groq.com/openai/v1/chat/completions")).toEqual({
      status: 502,
      error: "could not reach api.groq.com",
    });
    expect(droppedFailure("https://api.anthropic.com/v1/messages").error).toBe(
      "lost the connection to api.anthropic.com"
    );
  });
});

describe("StreamDecoder", () => {
  it("reads openai and groq usage from the last chunk", () => {
    const d = new StreamDecoder("groq");
    expect(d.line('{"choices":[{"delta":{"content":"hi"}}]}')).toBe("hi");
    expect(d.usage).toBeNull();
    expect(
      d.line(
        '{"choices":[{"delta":{},"finish_reason":"stop"}],"x_groq":{"usage":{"queue_time":0.01,"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}}'
      )
    ).toBe("");
    expect(d.usage).toEqual({ in: 9, out: 4 });
    const o = new StreamDecoder("openai");
    o.line('{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":0}}}');
    expect(o.usage).toEqual({ in: 120, out: 30 });
    expect(o.error).toBeNull();
  });

  it("sums anthropic input with its cache parts and keeps the last output", () => {
    const d = new StreamDecoder("anthropic");
    d.line(
      '{"type":"message_start","message":{"usage":{"input_tokens":25,"cache_creation_input_tokens":3,"cache_read_input_tokens":100,"output_tokens":1}}}'
    );
    expect(d.line('{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}')).toBe("hi");
    d.line('{"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":7}}');
    d.line('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}');
    expect(d.usage).toEqual({ in: 128, out: 15 });
  });

  it("keeps an error frame where a chunk should be", () => {
    const a = new StreamDecoder("anthropic");
    a.line('{"type":"content_block_delta","delta":{"text":"half"}}');
    a.line('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    expect(a.error).toContain("overloaded_error");
    expect(providerFailure(0, a.error!, "m", { provider: "anthropic" }).status).toBe(503);
    const g = new StreamDecoder("groq");
    expect(g.line('{"error":{"message":"x"}}')).toBe("");
    expect(g.error).toBe('{"error":{"message":"x"}}');
    // text that mentions "error" is text
    expect(g.line('{"choices":[{"delta":{"content":"\\"error\\": none"}}]}')).toBe('"error": none');
  });

  it("decodes a byte stream and flushes a last frame without a newline", async () => {
    const { stream, decoder } = decodeStream("groq");
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"sum"}}]}\n\ndata: {"choices":[{"del',
      'ta":{"content":"mary"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    ];
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const reader = src.pipeThrough(stream).getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toBe("summary");
    expect(decoder.usage).toEqual({ in: 2, out: 1 });
  });

  it("asks openai and groq for usage, anthropic sends it anyway", () => {
    expect(JSON.parse(buildRequest("groq", "gsk_x", "s", "u").body).stream_options).toEqual({
      include_usage: true,
    });
    expect(JSON.parse(buildRequest("openai", "sk-x", "s", "u").body).stream_options).toEqual({
      include_usage: true,
    });
    expect(JSON.parse(buildRequest("anthropic", "sk-ant-x", "s", "u").body)).not.toHaveProperty(
      "stream_options"
    );
    expect(
      JSON.parse(buildFollowupRequest("groq", "gsk_x", "s", [], "q").body).stream_options
    ).toEqual({ include_usage: true });
  });
});

describe("model catalog", () => {
  it("reads ids from the shared data[].id shape", () => {
    expect(modelIds({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }] })).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    expect(modelIds({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }] })).toEqual([
      "claude-opus-5",
    ]);
  });

  it("a catalog is not a model list", () => {
    expect(isChatModel("claude-opus-5")).toBe(true);
    for (const id of [
      "text-embedding-3-small",
      "whisper-large-v3",
      "tts-1",
      "dall-e-3",
      "omni-moderation-latest",
      "llama-guard-4-12b",
      "rerank-v1",
      "stable-diffusion-xl",
    ]) {
      expect(isChatModel(id), id).toBe(false);
    }
    expect(modelIds({ data: [{ id: "gpt-5.6-terra" }, { id: "whisper-1" }] })).toEqual([
      "gpt-5.6-terra",
    ]);
  });

  it("shrugs off a body that is not a catalog", () => {
    for (const body of [null, undefined, {}, { data: "nope" }, { data: [{}, { id: 4 }] }]) {
      expect(modelIds(body)).toEqual([]);
    }
  });

  it("drops ids the request body would reject anyway", () => {
    expect(modelIds({ data: [{ id: "a b c" }, { id: "ok-1" }] })).toEqual(["ok-1"]);
  });

  it("caps a very long catalog", () => {
    const data = Array.from({ length: MODELS_CAP + 10 }, (_, i) => ({ id: `m-${i}` }));
    expect(modelIds({ data })).toHaveLength(MODELS_CAP);
  });

  it("hangs the models route off the same base as the chat call", () => {
    expect(modelsUrl("anthropic")).toBe("https://api.anthropic.com/v1/models");
    expect(modelsUrl("openai")).toBe("https://api.openai.com/v1/models");
    // groq's base already carries /openai
    expect(modelsUrl("groq")).toBe("https://api.groq.com/openai/v1/models");
  });

  it("routes a synced id to its provider", () => {
    // unknown to the shipped list and to the prefix rule
    expect(modelFamily("qwen/qwen3.8-27b-preview")).toBe(null);
    const synced = (p: ProviderName) => (p === "groq" ? ["qwen/qwen3.8-27b-preview"] : []);
    expect(modelFamily("qwen/qwen3.8-27b-preview", synced)).toBe("groq");
    // the shipped list still wins
    expect(modelFamily("claude-opus-5", () => [])).toBe("anthropic");
  });
});
