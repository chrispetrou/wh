import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, SUGGESTED_MODELS } from "../explain/providers";
import { createKeyStore, type StorageLike } from "../key-store";
import { argNotes, branchSlot, buildCommands, menuFor, prSlot, rowSlot, stageOf } from "./menu";

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
