import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "../explain/providers";
import { createKeyStore, type StorageLike } from "../key-store";
import {
  activeEffort,
  activeModel,
  effortIgnored,
  keyLines,
  modelName,
  modelSuggestionLines,
  providerInfo,
  usageInfo,
  usageInfoRow,
  usageLines,
} from "./info";

function memory(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("info strings", () => {
  it("say there is nothing when no key is set", () => {
    const ks = createKeyStore(memory());
    expect(providerInfo(ks)).toBe("no key set");
    expect(modelName(ks)).toBe("");
    expect(activeModel(ks)).toBe("");
    expect(activeEffort(ks)).toBe("");
    expect(effortIgnored(ks)).toBe(false);
    expect(usageInfo(ks)).toBe("");
    expect(usageInfoRow(ks)).toBe("nothing counted yet");
    expect(usageLines(ks)).toEqual(["anthropic  no key", "openai     no key", "groq       no key"]);
    expect(keyLines(ks)).toEqual([
      "anthropic none",
      "openai    none",
      "groq      none (free tier at console.groq.com)",
    ]);
    expect(modelSuggestionLines(ks).every((l) => l.endsWith(" · no key"))).toBe(true);
    expect(modelSuggestionLines(ks)[2].startsWith("groq (free tier): ")).toBe(true);
  });

  it("follow the active key, its model, and its effort", () => {
    const ks = createKeyStore(memory());
    ks.addKey("gsk_x");
    expect(providerInfo(ks)).toBe(`groq · ${DEFAULT_MODELS.groq}`);
    expect(modelName(ks)).toBe(DEFAULT_MODELS.groq);
    expect(effortIgnored(ks)).toBe(true);
    ks.setModel("groq", "openai/gpt-oss-120b");
    expect(providerInfo(ks)).toBe("groq · openai/gpt-oss-120b");
    expect(activeModel(ks)).toBe("openai/gpt-oss-120b");
    expect(keyLines(ks)[2]).toBe("groq      set (active)");
    ks.addKey("sk-ant-1");
    ks.setEffort("anthropic", "high");
    expect(activeEffort(ks)).toBe("high");
    expect(effortIgnored(ks)).toBe(false);
    expect(keyLines(ks)[2]).toBe("groq      set");
  });

  it("count tokens on the active key and show the headroom", () => {
    const ks = createKeyStore(memory());
    ks.addKey("gsk_x");
    expect(usageLines(ks)[2]).toBe("groq       nothing yet (active)");
    ks.addUsage("groq", 1000, 2400, { tokens: { left: 5000, limit: 6000 } });
    expect(usageInfo(ks)).toBe(" · 3.4k tokens");
    expect(usageInfoRow(ks)).toMatch(/^3\.4k tokens on groq since \w{3} \d{1,2}, \/usage for the breakdown$/);
    const rows = usageLines(ks);
    expect(rows[2]).toContain("groq       1k in · 2.4k out · 1 answer · since ");
    expect(rows[2]).toContain("(active)");
    expect(rows[0]).toBe("anthropic  no key");
    expect(rows[3]).toBe("headroom   5k tokens left (as of the last answer)");
  });
});
