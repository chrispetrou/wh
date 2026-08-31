import { describe, expect, it } from "vitest";
import type { StorageLike } from "../key-store";
import { applyFont, applyFontSize, applyLigatures, createPrefs, rememberRecent, type RootLike } from "./prefs";

function memory(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeRoot(): RootLike & { attrs: Map<string, string>; props: Map<string, string> } {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  return {
    attrs,
    props,
    setAttribute: (n, v) => void attrs.set(n, v),
    removeAttribute: (n) => void attrs.delete(n),
    style: {
      setProperty: (n, v) => void props.set(n, v),
      removeProperty: (n) => void props.delete(n),
    },
  };
}

describe("prefs", () => {
  it("reads, writes, and removes on empty", () => {
    const m = memory();
    const p = createPrefs(m);
    expect(p.get("x")).toBe("");
    p.set("x", "1");
    expect(p.get("x")).toBe("1");
    p.set("x", "");
    expect(m.data.has("x")).toBe(false);
  });

  it("swallows a storage that throws", () => {
    const p = createPrefs({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(p.get("x")).toBe("");
    expect(() => p.set("x", "1")).not.toThrow();
  });
});

describe("appliers", () => {
  it("sets and clears the font, size, and ligature attributes", () => {
    const m = memory();
    const p = createPrefs(m);
    const r = fakeRoot();
    applyFont("fira", r, p);
    expect(r.attrs.get("data-font")).toBe("fira");
    expect(m.data.get("wd_font")).toBe("fira");
    applyFont("default", r, p);
    expect(r.attrs.has("data-font")).toBe(false);
    expect(m.data.has("wd_font")).toBe(false);

    applyFontSize("14", r, p);
    expect(r.props.get("--wd-font-size")).toBe("14px");
    expect(m.data.get("wd_fontsize")).toBe("14");
    applyFontSize("default", r, p);
    expect(r.props.has("--wd-font-size")).toBe(false);

    applyLigatures(false, r, p);
    expect(r.attrs.get("data-lig")).toBe("off");
    expect(m.data.get("wd_lig")).toBe("off");
    applyLigatures(true, r, p);
    expect(r.attrs.has("data-lig")).toBe(false);
    expect(m.data.has("wd_lig")).toBe(false);
  });
});

describe("rememberRecent", () => {
  it("moves the repo to the front, dedupes, and keeps five", () => {
    const m = memory({ wd_recent: JSON.stringify(["a/1", "b/2", "c/3", "d/4", "e/5"]) });
    rememberRecent("c/3", m);
    expect(JSON.parse(m.data.get("wd_recent")!)).toEqual(["c/3", "a/1", "b/2", "d/4", "e/5"]);
    rememberRecent("f/6", m);
    expect(JSON.parse(m.data.get("wd_recent")!)).toEqual(["f/6", "c/3", "a/1", "b/2", "d/4"]);
  });

  it("tolerates bad json", () => {
    const m = memory({ wd_recent: "{" });
    expect(() => rememberRecent("a/1", m)).not.toThrow();
    expect(m.data.get("wd_recent")).toBe("{");
  });
});
