import { describe, expect, it } from "vitest";
import {
  fmtTokens,
  fmtWait,
  headroom,
  lowLine,
  parseDuration,
  usageParts,
  waitFrom,
} from "./usage";

function bag(h: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (n: string) => lower[n.toLowerCase()] ?? null };
}

describe("fmtTokens", () => {
  // the example table in shared/prompts/provider.md; the cli runs the same
  it("rounds ties the way the spec says", () => {
    const table: Array<[number, string]> = [
      [0, "0"],
      [842, "842"],
      [999, "999"],
      [1000, "1k"],
      [1250, "1.3k"],
      [12400, "12.4k"],
      [999_949, "999.9k"],
      [999_950, "1m"],
      [1_234_567, "1.2m"],
      [84_300, "84.3k"],
    ];
    for (const [n, s] of table) expect(fmtTokens(n)).toBe(s);
  });
});

describe("fmtWait", () => {
  it("picks the unit by size and rounds up", () => {
    expect(fmtWait(0)).toBe("0s");
    expect(fmtWait(5.2)).toBe("6s");
    expect(fmtWait(59)).toBe("59s");
    expect(fmtWait(60)).toBe("1m");
    expect(fmtWait(121)).toBe("3m");
    expect(fmtWait(3600)).toBe("1h");
    expect(fmtWait(4800)).toBe("1h 20m");
    expect(fmtWait(7200)).toBe("2h");
    expect(fmtWait(7199)).toBe("2h");
  });
});

describe("parseDuration", () => {
  it("reads the openai and groq reset shapes", () => {
    expect(parseDuration("6m0s")).toBe(360);
    expect(parseDuration("2m59.56s")).toBe(180);
    expect(parseDuration("7.66s")).toBe(8);
    expect(parseDuration("1h23m")).toBe(4980);
    expect(parseDuration("12s")).toBe(12);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("2024-01-01T00:00:00Z")).toBeNull();
  });
});

describe("waitFrom", () => {
  it("prefers retry-after, then reset headers, then the message", () => {
    expect(waitFrom(bag({ "retry-after": "12" }), "try again in 5s")).toBe(12);
    expect(waitFrom(bag({ "x-ratelimit-reset-tokens": "2m59.56s" }), "")).toBe(180);
    expect(waitFrom(bag({}), "Please try again in 5.2s.")).toBe(6);
    expect(waitFrom(bag({}), "Rate limit reached")).toBeNull();
    expect(waitFrom(undefined, "")).toBeNull();
  });
  it("computes the delta for an rfc 3339 reset", () => {
    const at = new Date(Date.now() + 90_000).toISOString();
    const w = waitFrom(bag({ "anthropic-ratelimit-tokens-reset": at }), "");
    expect(w).toBeGreaterThanOrEqual(89);
    expect(w).toBeLessThanOrEqual(91);
  });
});

describe("headroom", () => {
  it("needs both remaining and limit", () => {
    expect(headroom("groq", bag({ "x-ratelimit-remaining-tokens": "500" }))).toBeNull();
    expect(
      headroom(
        "groq",
        bag({
          "x-ratelimit-remaining-tokens": "500",
          "x-ratelimit-limit-tokens": "100000",
          "x-ratelimit-reset-tokens": "42s",
        })
      )
    ).toEqual({ tokens: { left: 500, limit: 100000 }, requests: undefined, reset: "42s" });
    expect(
      headroom(
        "anthropic",
        bag({
          "anthropic-ratelimit-requests-remaining": "999",
          "anthropic-ratelimit-requests-limit": "1000",
        })
      )
    ).toEqual({ tokens: undefined, requests: { left: 999, limit: 1000 } });
  });
});

describe("lowLine", () => {
  it("warns under a tenth, with the reset when known", () => {
    expect(lowLine("groq", { tokens: { left: 8200, limit: 100000 }, reset: "42s" })).toBe(
      "low on groq tokens: 8.2k of 100k left, resets in 42s"
    );
    expect(lowLine("openai", { requests: { left: 3, limit: 60 } })).toBe(
      "low on openai requests: 3 of 60 left"
    );
    expect(lowLine("groq", { tokens: { left: 50000, limit: 100000 } })).toBeNull();
    expect(lowLine("groq", null)).toBeNull();
  });
});

describe("usageParts", () => {
  it("formats in and out, or nothing", () => {
    expect(usageParts({ in: 1234, out: 340 })).toBe("1.2k in · 340 out");
    expect(usageParts(null)).toBe("");
  });
});
