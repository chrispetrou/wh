import { afterEach, describe, expect, it } from "vitest";
import {
  buildFollowupRequest,
  buildRequest,
  DEFAULT_MODELS,
  detectProvider,
  EFFORTS,
  extractText,
  MODEL_RE,
  modelFamily,
  SUGGESTED_MODELS,
} from "./providers";

describe("modelFamily", () => {
  it("resolves suggestions exactly, then by prefix", () => {
    expect(modelFamily("claude-opus-5")).toBe("anthropic");
    expect(modelFamily("claude-3-7-sonnet")).toBe("anthropic");
    expect(modelFamily("gpt-5")).toBe("openai");
    expect(modelFamily("llama-3.3-70b-versatile")).toBe("groq");
    expect(modelFamily("openai/gpt-oss-120b")).toBe("groq");
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
  it("has a default model and no effort levels", () => {
    expect(DEFAULT_MODELS.groq).toBe("llama-3.3-70b-versatile");
    expect(EFFORTS.groq).toEqual([]);
  });
});

describe("MODEL_RE", () => {
  it("accepts vendor-prefixed groq ids", () => {
    expect(MODEL_RE.test("llama-3.3-70b-versatile")).toBe(true);
    expect(MODEL_RE.test("openai/gpt-oss-120b")).toBe(true);
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
    delete process.env.WD_GROQ_URL;
  });

  it("uses the openai dialect at groq's host", () => {
    const r = buildRequest("groq", "gsk_x", "sys", "usr");
    expect(r.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((r.headers as Record<string, string>).authorization).toBe("Bearer gsk_x");
    const body = JSON.parse(r.body);
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1]).toEqual({ role: "user", content: "usr" });
  });

  it("drops effort for groq but keeps it for openai", () => {
    const groq = JSON.parse(buildRequest("groq", "gsk_x", "s", "u", undefined, "high").body);
    expect(groq).not.toHaveProperty("reasoning_effort");
    const openai = JSON.parse(buildRequest("openai", "sk-x", "s", "u", undefined, "high").body);
    expect(openai.reasoning_effort).toBe("high");
  });

  it("honours WD_GROQ_URL", () => {
    process.env.WD_GROQ_URL = "http://127.0.0.1:1234";
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
