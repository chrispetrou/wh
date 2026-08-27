import { describe, expect, it } from "vitest";
import { LOG_COLS, logLine, prLine, type LogLayout } from "./log-line";

const NOW = Date.parse("2026-08-27T12:00:00Z");
const T = "2026-08-27T09:00:00Z"; // 3h before

const flat = (l: ReturnType<typeof logLine>) =>
  l.spans ? l.spans.map((s) => s.text).join("") : l.text;

describe("logLine", () => {
  it("numbers commit rows, leaves connectors blank, keeps footers muted", () => {
    const st: LogLayout = { n: 0, width: 2, rails: 3 };
    const a = logLine(`*\ta1b2c3d\tmain v1\tmerge feat\tchris\t${T}`, st, NOW);
    const con = logLine("|\\\t\t\t\t\t", st, NOW);
    const b = logLine(`* |\t40cce0c\t\tsecond\tchris\t${T}`, st, NOW);
    const foot = logLine("2 commits · 2 branches", st, NOW);

    expect(a.pre).toBe(true);
    expect(flat(a).startsWith(" 1 *   a1b2c3d main v1 merge feat")).toBe(true);
    expect(flat(a).trimEnd().endsWith(" chris 3h")).toBe(true);
    expect(flat(a).length).toBe(LOG_COLS);
    expect(flat(con)).toBe("   |\\ ");
    expect(flat(b).startsWith(" 2 * | 40cce0c second")).toBe(true);
    expect(foot).toEqual({ text: "2 commits · 2 branches", cls: "o" });
    expect(st.n).toBe(2);
  });

  it("colors the columns: number and sha muted, rails faint, refs accent", () => {
    const l = logLine(`*\ta1b2c3d\tmain\tsubject\tme\t${T}`, { n: 0, width: 1, rails: 1 }, NOW);
    expect(l.spans!.map((s) => s.cls)).toEqual(["o", "f", "o", "x", "", "o"]);
  });

  it("truncates a long subject to keep the date column aligned", () => {
    const long = "x".repeat(200);
    const l = logLine(`*\ta1b2c3d\t\t${long}\tme\t${T}`, { n: 0, width: 1, rails: 1 }, NOW);
    const s = flat(l);
    expect(s.length).toBe(LOG_COLS);
    expect(s).toContain("…");
    expect(s.trimEnd().endsWith("me 3h")).toBe(true);
  });

  it("lays out a pr row with an accent number and muted state", () => {
    const l = prLine(`#12 \talice\tfix the thing\tfeat/x → main\t${T}\tdraft`, NOW);
    expect(l.spans!.map((s) => s.cls)).toEqual(["x", "o", "", "o"]);
    const s = flat(l);
    expect(s.startsWith("#12  alice fix the thing")).toBe(true);
    expect(s.trimEnd().endsWith("feat/x → main 3h · draft")).toBe(true);
    expect(s.length).toBe(LOG_COLS);
    expect(prLine("2 open prs", NOW)).toEqual({ text: "2 open prs", cls: "o" });
  });

  it("lets a row run on instead of squeezing the subject under 12 columns", () => {
    const refs = "r".repeat(90);
    const l = logLine(`*\ta1b2c3d\t${refs}\tsubject\tme\t${T}`, { n: 0, width: 1, rails: 1 }, NOW);
    expect(flat(l)).toContain("subject me 3h");
  });
});
