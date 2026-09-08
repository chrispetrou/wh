import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, SUGGESTED_MODELS } from "../explain/providers";
import { createKeyStore, type StorageLike } from "../key-store";
import { createCatalog } from "../catalog";
import {
  argNotes,
  branchSlot,
  buildCommands,
  menuFor,
  modelArgs,
  prSlot,
  rowSlot,
  stageOf,
} from "./menu";

function memory(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("slots", () => {
  it("finds where a branch name goes", () => {
    expect(branchSlot("what changed in fe")).toEqual({ prefix: "what changed in ", partial: "fe" });
    expect(branchSlot("what changed in pr #4")).toBeNull();
    expect(branchSlot("diff main..de")).toEqual({ prefix: "diff main..", partial: "de" });
    expect(branchSlot("pick 3 5 onto ma")).toEqual({ prefix: "pick 3 5 onto ", partial: "ma" });
    expect(branchSlot("log 20 on ")).toEqual({ prefix: "log 20 on ", partial: "" });
    expect(branchSlot("since v1")).toEqual({ prefix: "since ", partial: "v1" });
    expect(branchSlot("churn since v1")).toEqual({ prefix: "churn since ", partial: "v1" });
    // periods only, a branch would be rejected
    expect(branchSlot("activity since ")).toBeNull();
    expect(branchSlot("stale since ")).toBeNull();
    expect(branchSlot("/model x")).toBeNull();
    expect(branchSlot("explain the last 3 commits")).toBeNull();
  });

  it("finds where a row number or a pr number goes", () => {
    expect(rowSlot("pick 3 5 ")).toEqual({ prefix: "pick 3 5 ", partial: "" });
    expect(rowSlot("explain 1")).toEqual({ prefix: "explain ", partial: "1" });
    expect(rowSlot("explain abc")).toBeNull();
    expect(prSlot("describe pr ")).toEqual({ prefix: "describe pr ", partial: "" });
    expect(prSlot("what changed in pr #4")).toEqual({ prefix: "what changed in pr #", partial: "4" });
    expect(prSlot("pr 42x")).toBeNull();
  });
});

describe("menuFor", () => {
  const ks = createKeyStore(memory());
  const commands = buildCommands(ks);

  it("offers commands by prefix and options by argument", () => {
    expect(menuFor("/mo", commands)).toEqual({ stage: "cmd", rows: ["/model"] });
    expect(menuFor("/theme d", commands)?.rows).toEqual(["dark"]);
    expect(menuFor("/theme dark", commands)).toBeNull();
    expect(menuFor("/help x", commands)).toBeNull();
    expect(menuFor("/nope", commands)).toBeNull();
    expect(menuFor("log", commands)).toBeNull();
  });

  it("lists the active provider's models first", () => {
    ks.addKey("gsk_x");
    const rows = menuFor("/model ", commands)?.rows ?? [];
    expect(rows.slice(0, SUGGESTED_MODELS.groq.length)).toEqual(SUGGESTED_MODELS.groq);
    expect(menuFor("/key ", commands)?.rows).toEqual(["clear", "clear groq"]);
  });

  it("names the stage an input would open", () => {
    expect(stageOf("/mo", commands)).toBe("cmd");
    expect(stageOf("/theme ", commands)).toBe("arg");
    expect(stageOf("diff main..", commands)).toBe("branch");
    expect(stageOf("explain ", commands)).toBe("row");
    expect(stageOf("pr ", commands)).toBe("pr");
    expect(stageOf("hello", commands)).toBeUndefined();
  });
});

describe("argNotes", () => {
  it("annotates a /model row with provider, tier, default, and key state", () => {
    const ks = createKeyStore(memory());
    const spec = buildCommands(ks).find((c) => c.name === "/model");
    const notes = argNotes(spec, DEFAULT_MODELS.groq, ks).map((n) => n.text);
    expect(notes).toEqual(["groq", "free", "default", "no key"]);
    ks.addKey("gsk_x");
    expect(argNotes(spec, DEFAULT_MODELS.groq, ks).map((n) => n.text)).toEqual(["groq", "free", "default"]);
    expect(argNotes(spec, "default", ks)).toEqual([{ text: "provider default" }]);
    expect(argNotes(undefined, "x", ks)).toEqual([]);
  });
});

describe("model rows", () => {
  it("offers the shipped seed until a provider is synced", () => {
    const ks = createKeyStore(memory());
    const cat = createCatalog(memory());
    const rows = modelArgs(ks, cat);
    expect(rows).toContain("claude-opus-5");
    expect(rows).toContain("gpt-5.6-terra");
    expect(rows).toContain("sync");
  });

  it("a synced catalog replaces that provider's seed, so a retired id goes away", () => {
    const ks = createKeyStore(memory());
    ks.addKey("gsk_x");
    const cat = createCatalog(memory());
    cat.set("groq", ["openai/gpt-oss-120b", "moonshotai/kimi-k3"]);
    const rows = modelArgs(ks, cat);
    expect(rows).toContain("moonshotai/kimi-k3");
    // a groq seed id the provider no longer lists
    expect(rows).not.toContain(SUGGESTED_MODELS.groq[2]);
    // a provider nobody synced keeps its seed
    expect(rows).toContain("claude-opus-5");
  });

  it("marks the sync rows as verbs, not models", () => {
    const ks = createKeyStore(memory());
    ks.addKey("gsk_x");
    const spec = buildCommands(ks).find((c) => c.name === "/model");
    expect(argNotes(spec, "sync", ks)).toEqual([{ text: "refresh from the provider" }]);
    expect(argNotes(spec, "sync groq", ks)).toEqual([{ text: "refresh from the provider" }]);
  });

  it("offers a sync row per keyed provider", () => {
    const ks = createKeyStore(memory());
    const cat = createCatalog(memory());
    expect(modelArgs(ks, cat)).not.toContain("sync groq");
    ks.addKey("gsk_x");
    const rows = modelArgs(ks, cat);
    expect(rows).toContain("sync");
    expect(rows).toContain("sync groq");
  });

  it("keeps the whole catalog, so a retirement check is not fooled by a cap", () => {
    const ks = createKeyStore(memory());
    ks.addKey("sk-openai");
    const cat = createCatalog(memory());
    // more ids than the old 40-row cap, with the default late in the list
    const many = Array.from({ length: 60 }, (_, i) => `m-${i}`);
    cat.set("openai", [...many, DEFAULT_MODELS.openai]);
    expect(modelArgs(ks, cat)).toContain(DEFAULT_MODELS.openai);
  });
});
