import { describe, expect, it } from "vitest";
import { branchLine, classify, createAssembler, flat, lsLine, tagLine } from "./lines";

describe("classify", () => {
  it("colors diff lines in raw mode", () => {
    expect(classify("diff", "+x").cls).toBe("g");
    expect(classify("diff", "-x").cls).toBe("r");
    expect(classify("diff", "@@ -1 +1 @@").cls).toBe("x");
    expect(classify("diff", "diff --git a/x b/x").cls).toBe("c");
    expect(classify("diff", "+++ b/x").cls).toBe("o");
    expect(classify("diff", "- abc123 subject").cls).toBe("o");
    expect(classify("diff", "context").cls).toBe("");
  });

  it("paints section labels amber and unwraps the sentinels", () => {
    expect(classify("text", "summary").cls).toBe("a");
    expect(classify("text", "watch out ").cls).toBe("a");
    expect(classify("text", "plain words")).toEqual({ text: "plain words", cls: "" });
    expect(classify("text", "[wh:error] boom")).toEqual({
      head: { text: "error:", cls: "a" },
      text: " boom",
      cls: "",
    });
    expect(classify("text", "[wh:hint] try /key")).toEqual({ text: "try /key", cls: "o" });
  });

  it("hands listings to their row shapes", () => {
    expect(classify("branches", "  3  feat/x    behind 1")).toEqual(branchLine("  3  feat/x    behind 1"));
    expect(classify("tags", "2\tv1.0  \tabc1234\t2026-01-01T00:00:00Z").text).toBe("v1.0  ");
  });
});

describe("branch and tag rows", () => {
  it("makes a branch row a drop target with a muted index and status", () => {
    const l = branchLine("  3  feat/x    behind 1");
    expect(l.text).toBe("feat/x");
    expect(l.cls).toBe("");
    expect(l.head).toEqual({ text: "  3  ", cls: "o" });
    expect(l.tail).toEqual({ text: "    behind 1", cls: "o" });
    expect(l.drop).toBe("branch:feat/x");
    expect(branchLine("2 branches")).toEqual({ text: "2 branches", cls: "o" });
    // a stale row has the same shape, so it drops and paints the same way
    const s = branchLine("1  feat/old  last commit 20w ago · behind 3");
    expect(s.text).toBe("feat/old");
    expect(s.drop).toBe("branch:feat/old");
    expect(s.tail).toEqual({ text: "  last commit 20w ago · behind 3", cls: "o" });
  });

  it("colors an ls row and keeps the count line muted", () => {
    const d = lsLine("1\tsrc/   \t");
    expect(d.text).toBe("src/   ");
    expect(d.head).toEqual({ text: "1  ", cls: "o" });
    expect(d.tail).toEqual({ text: "", cls: "o" });
    const f = lsLine("2\tmain.rs\t1.2k");
    expect(f.text).toBe("main.rs");
    expect(f.tail).toEqual({ text: "1.2k", cls: "o" });
    expect(lsLine("3 entries in src on main")).toEqual({
      text: "3 entries in src on main",
      cls: "o",
    });
  });

  it("keeps a short tags line muted", () => {
    expect(tagLine("no tags")).toEqual({ text: "no tags", cls: "o" });
    const l = tagLine("1\tv1.0  \tabc1234\t");
    expect(l.text).toBe("v1.0  ");
    expect(l.tail?.text).toBe("abc1234");
  });
});

describe("flat", () => {
  it("joins prefix, head, text, and tail", () => {
    expect(flat({ prefix: "o/r $", head: { text: "→ ok", cls: "g" }, text: " done", cls: "o" })).toBe(
      "o/r $ → ok done"
    );
    expect(flat({ text: "x", cls: "", tail: { text: " y", cls: "o" } })).toBe("x y");
  });
});

describe("assembler", () => {
  it("returns complete rows and holds the fragment", () => {
    const a = createAssembler();
    a.reset("text");
    expect(a.feed("a\nb")).toEqual([{ text: "a", cls: "" }]);
    expect(a.feed("c\n")).toEqual([{ text: "bc", cls: "" }]);
    expect(a.flush()).toBeNull();
    expect(a.feed("tail")).toEqual([]);
    expect(a.flush()).toEqual({ text: "tail", cls: "" });
    expect(a.answer()).toBe("a\nbc\ntail");
    // a stream cut mid-line leaves nothing for the next one
    a.feed("cut sh");
    a.reset("text");
    expect(a.feed("summary\n")).toEqual([{ text: "summary", cls: "a" }]); // the label paints
  });

  it("takes the usage sentinel aside and leaves it out of the answer", () => {
    const a = createAssembler();
    a.reset("text");
    expect(a.feed('line\n[wh:usage] {"in":10,"out":2}\n[wh:hint] x\n')).toEqual([
      { text: "line", cls: "" },
      { text: "x", cls: "o" },
    ]);
    expect(a.takeUsage()).toEqual({ in: 10, out: 2 });
    expect(a.takeUsage()).toBeNull();
    expect(a.answer()).toBe("line\n");
    expect(a.feed("[wh:usage] not json\n")).toEqual([]);
  });

  it("follows its mode", () => {
    const a = createAssembler();
    a.reset("diff");
    expect(a.feed("+x\n")[0].cls).toBe("g");
    a.mode = "branches";
    expect(a.feed("  1  main\n")[0].drop).toBe("branch:main");
  });
});
