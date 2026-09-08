import { describe, expect, it } from "vitest";
import { createCatalog, type StorageLike } from "./catalog";

function memory(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const throwing: StorageLike = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

describe("catalog", () => {
  it("is empty until something is synced", () => {
    const c = createCatalog(memory());
    expect(c.models("anthropic")).toEqual([]);
    expect(c.fetched("anthropic")).toBe(0);
  });

  it("keeps one list per provider with the fetch time", () => {
    const c = createCatalog(memory());
    c.set("groq", ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
    c.set("anthropic", ["claude-opus-5"]);
    expect(c.models("groq")).toEqual(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
    expect(c.models("anthropic")).toEqual(["claude-opus-5"]);
    expect(c.fetched("groq")).toBeGreaterThan(0);
  });

  it("clears one provider without touching the rest", () => {
    const c = createCatalog(memory());
    c.set("groq", ["a"]);
    c.set("openai", ["b"]);
    c.clear("groq");
    expect(c.models("groq")).toEqual([]);
    expect(c.models("openai")).toEqual(["b"]);
  });

  it("survives a storage that throws, and a storage that is absent", () => {
    for (const s of [throwing, null]) {
      const c = createCatalog(s);
      expect(() => c.set("groq", ["a"])).not.toThrow();
      expect(c.models("groq")).toEqual([]);
    }
  });

  it("ignores a corrupt entry", () => {
    const m = memory();
    m.setItem("wh_catalog", "not json");
    expect(createCatalog(m).models("groq")).toEqual([]);
    m.setItem("wh_catalog", JSON.stringify({ groq: { models: "nope" } }));
    expect(createCatalog(m).models("groq")).toEqual([]);
  });
});
