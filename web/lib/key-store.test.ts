import { describe, expect, it } from "vitest";
import { createKeyStore, type StorageLike } from "./key-store";

function memory(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("key store", () => {
  it("starts empty", () => {
    const s = createKeyStore(memory());
    expect(s.providers()).toEqual([]);
    expect(s.active()).toBeNull();
    expect(s.activeKey()).toBe("");
  });

  it("migrates the legacy single key with its model and effort", () => {
    const m = memory({ wd_key: "gsk_old", wd_model: "openai/gpt-oss-120b", wd_effort: "high" });
    const s = createKeyStore(m);
    expect(s.providers()).toEqual(["groq"]);
    expect(s.active()).toBe("groq");
    expect(s.activeKey()).toBe("gsk_old");
    expect(s.model("groq")).toBe("openai/gpt-oss-120b");
    expect(s.effort("groq")).toBe("high");
    expect(m.data.has("wd_key")).toBe(false);
    expect(m.data.has("wd_model")).toBe(false);
    expect(m.data.has("wd_effort")).toBe(false);
  });

  it("stores one key per provider and activates the latest", () => {
    const s = createKeyStore(memory());
    expect(s.addKey("sk-ant-1")).toEqual({ provider: "anthropic", replaced: false });
    expect(s.addKey("gsk_1")).toEqual({ provider: "groq", replaced: false });
    expect(s.providers()).toEqual(["anthropic", "groq"]);
    expect(s.active()).toBe("groq");
    expect(s.activeKey()).toBe("gsk_1");
    expect(s.addKey("sk-ant-2")).toEqual({ provider: "anthropic", replaced: true });
    expect(s.activeKey()).toBe("sk-ant-2");
    expect(s.hasKey("openai")).toBe(false);
  });

  it("switches only to providers with a key", () => {
    const s = createKeyStore(memory());
    s.addKey("sk-ant-1");
    s.addKey("gsk_1");
    s.setActive("anthropic");
    expect(s.active()).toBe("anthropic");
    s.setActive("openai");
    expect(s.active()).toBe("anthropic");
  });

  it("remembers model and effort per provider", () => {
    const s = createKeyStore(memory());
    s.addKey("sk-ant-1");
    s.addKey("gsk_1");
    s.setModel("anthropic", "claude-sonnet-5");
    s.setEffort("anthropic", "high");
    expect(s.model("anthropic")).toBe("claude-sonnet-5");
    expect(s.model("groq")).toBe("");
    expect(s.effort("anthropic")).toBe("high");
    expect(s.effort("groq")).toBe("");
    s.setModel("anthropic", "");
    expect(s.model("anthropic")).toBe("");
  });

  it("removes one provider and falls back to the next", () => {
    const s = createKeyStore(memory());
    s.addKey("sk-ant-1");
    s.addKey("gsk_1");
    s.setModel("groq", "openai/gpt-oss-120b");
    s.removeKey("groq");
    expect(s.providers()).toEqual(["anthropic"]);
    expect(s.active()).toBe("anthropic");
    expect(s.model("groq")).toBe("");
    s.addKey("gsk_2");
    s.removeKey("anthropic");
    expect(s.active()).toBe("groq");
  });

  it("removes everything", () => {
    const m = memory();
    const s = createKeyStore(m);
    s.addKey("sk-ant-1");
    s.setModel("anthropic", "claude-sonnet-5");
    s.setEffort("anthropic", "high");
    s.removeKey();
    expect(s.providers()).toEqual([]);
    expect(s.active()).toBeNull();
    expect(m.data.size).toBe(0);
  });

  it("treats a throwing storage as empty", () => {
    const boom: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const s = createKeyStore(boom);
    expect(s.providers()).toEqual([]);
    expect(() => s.addKey("gsk_1")).not.toThrow();
    expect(s.activeKey()).toBe("");
  });

  it("ignores malformed stored json", () => {
    const s = createKeyStore(memory({ wd_keys: "not json", wd_provider: "groq" }));
    expect(s.providers()).toEqual([]);
    expect(s.active()).toBeNull();
  });
});

describe("usage count", () => {
  it("adds up per provider and remembers the last headroom", () => {
    const s = createKeyStore(memory());
    s.addKey("gsk_1");
    expect(s.usage("groq")).toBeNull();
    s.addUsage("groq", 1000, 200);
    s.addUsage("groq", 500, 40, { tokens: { left: 900, limit: 1000 } });
    const u = s.usage("groq")!;
    expect(u.in).toBe(1500);
    expect(u.out).toBe(240);
    expect(u.answers).toBe(2);
    expect(u.since).toBeGreaterThan(0);
    expect(u.left).toEqual({ tokens: { left: 900, limit: 1000 } });
    // no headroom this time keeps the last one
    s.addUsage("groq", 1, 1);
    expect(s.usage("groq")!.left).toEqual({ tokens: { left: 900, limit: 1000 } });
    expect(s.usage("anthropic")).toBeNull();
  });

  it("starts over when the key is replaced, removed, or reset", () => {
    const s = createKeyStore(memory());
    s.addKey("gsk_1");
    s.addKey("sk-ant-1");
    s.addUsage("groq", 10, 5);
    s.addUsage("anthropic", 7, 3);
    s.addKey("gsk_2");
    expect(s.usage("groq")).toBeNull();
    expect(s.usage("anthropic")!.in).toBe(7);
    s.addUsage("groq", 2, 2);
    s.resetUsage("groq");
    expect(s.usage("groq")).toBeNull();
    s.addUsage("groq", 2, 2);
    s.removeKey("groq");
    expect(s.usage("groq")).toBeNull();
    s.addUsage("anthropic", 1, 1);
    s.resetUsage();
    expect(s.usage("anthropic")).toBeNull();
    s.addUsage("anthropic", 1, 1);
    s.removeKey();
    expect(s.usage("anthropic")).toBeNull();
  });

  it("ignores a malformed count", () => {
    const s = createKeyStore(memory({ wd_keys: '{"groq":"gsk_1"}', wd_usage: '{"groq":"nope"}' }));
    expect(s.usage("groq")).toBeNull();
    const t = createKeyStore(memory({ wd_keys: '{"groq":"gsk_1"}', wd_usage: '{"groq":"{\\"in\\":\\"x\\"}"}' }));
    expect(t.usage("groq")).toBeNull();
  });
});
