import { describe, expect, it } from "vitest";
import type { LogRow } from "../chat-store";
import { parseCommand } from "../commands";
import { resolveRows } from "./resolve";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const rows: LogRow[] = [
  { sha: A, parent: B, merge: false, branch: "main", subject: "third" },
  { sha: B, parent: C, merge: false, subject: "second" },
  { sha: C, parent: null, merge: false, subject: "first" },
];

const cmd = (s: string) => parseCommand(s)!;

describe("resolveRows", () => {
  it("resolves one row to its sha with a note", () => {
    expect(resolveRows(cmd("explain 2"), rows, true)).toEqual({
      command: B,
      notes: [`row 2: ${"b".repeat(7)} second`],
    });
    expect(resolveRows(cmd("changelog 1 in src"), rows, true)?.command).toBe(`changelog ${A} in src`);
  });

  it("resolves a span through the older row's parent", () => {
    expect(resolveRows(cmd("explain 1..2"), rows, true)).toEqual({
      command: `${C}..${A}`,
      notes: [`rows 1..2: ${"a".repeat(7)} to ${"b".repeat(7)}`],
    });
    expect(resolveRows(cmd("explain 1..2"), rows, false)).toEqual({
      notes: ["these rows are not contiguous; explain one row at a time"],
    });
    expect(resolveRows(cmd("explain 1..3"), rows, true)).toEqual({
      notes: ["row 3 is the first commit; try explain 1..2"],
    });
    expect(resolveRows(cmd("explain 3..3"), rows, true)).toEqual({
      notes: ["row 3 is the first commit"],
    });
  });

  it("refuses a span whose rows are not a first-parent chain", () => {
    // a graph: row 2 sits on another lane, row 1's parent is row 3
    const lanes: LogRow[] = [
      { sha: A, parent: C, merge: false, branch: "main", subject: "third" },
      { sha: B, parent: C, merge: false, branch: "feat", subject: "side" },
      { sha: C, parent: null, merge: false, subject: "first" },
    ];
    expect(resolveRows(cmd("explain 1..2"), lanes, true)).toEqual({
      notes: ["these rows are not contiguous; explain one row at a time"],
    });
    expect(resolveRows(cmd("rebase 1..2"), lanes, true)?.command).toBeUndefined();
    expect(resolveRows(cmd("rebase 2"), lanes, true)?.command).toBe(`rebase ${C}..feat`);
  });

  it("refuses an interior span under a merge or off the first-parent line", () => {
    // main = tip > merge > old: reordering old means replaying the merge
    const under: LogRow[] = [
      { sha: A, parent: B, merge: false, branch: "main", subject: "tip" },
      { sha: B, parent: C, merge: true, subject: "merge feat" },
      { sha: C, parent: "0".repeat(40), merge: false, subject: "old" },
    ];
    expect(resolveRows(cmd("rebase 3"), under, true)).toEqual({
      notes: [
        "a merge (row 2) sits between row 3 and the branch tip; pick the rows onto a branch instead: pick 3 onto <branch>",
      ],
    });
    // row 2 is another lane's child of row 3, not the tip's line
    const forked: LogRow[] = [
      { sha: A, parent: C, merge: false, branch: "main", subject: "tip" },
      { sha: B, parent: C, merge: false, subject: "side" },
      { sha: C, parent: "0".repeat(40), merge: false, subject: "old" },
    ];
    expect(resolveRows(cmd("rebase 3"), forked, true)).toEqual({
      notes: [
        "row 3 is not on a branch's first-parent line; pick the rows onto a branch instead: pick 3 onto <branch>",
      ],
    });
  });

  it("says what is missing", () => {
    expect(resolveRows(cmd("explain 2"), undefined, true)?.command).toBeUndefined();
    expect(resolveRows(cmd("explain 9"), rows, true)).toEqual({ notes: ["the log has 3 rows"] });
    expect(resolveRows(cmd("explain 9"), rows.slice(0, 1), true)).toEqual({ notes: ["the log has 1 row"] });
  });

  it("resolves a rebase over rows and a pick of rows", () => {
    expect(resolveRows(cmd("rebase 1..2"), rows, true)).toEqual({
      command: `rebase ${C}..main`,
      notes: [`rows 1..2: ${"a".repeat(7)} to ${"b".repeat(7)}`],
    });
    expect(resolveRows(cmd("rebase 1..2"), rows, false)?.command).toBeUndefined();
    // an interior span: the rows above ride along, the branch is the tip
    expect(resolveRows(cmd("rebase 2"), rows, true)).toEqual({
      command: `rebase ${C}..main`,
      notes: [
        `row 2: ${"b".repeat(7)} second`,
        "row 1 rides along as picks: the paste rewrites main from its tip",
      ],
    });
    const merged = rows.map((r, i) => (i === 1 ? { ...r, merge: true } : r));
    expect(resolveRows(cmd("rebase 1..2"), merged, true)).toEqual({
      notes: ["row 2 is a merge; rebase plans need a linear history"],
    });
    expect(resolveRows(cmd("rebase 1"), merged, true)?.command).toBe(`rebase ${B}..main`);
    expect(resolveRows(cmd("rebase 3"), rows, true)).toEqual({
      notes: ["row 3 is the first commit; there is nothing to rebase it onto"],
    });
    expect(resolveRows(cmd("pick 3 3 1 onto main"), rows, true)).toEqual({
      command: `pick ${C} ${A} onto main`,
      notes: [`rows 3 3 1: ${"c".repeat(7)} ${"a".repeat(7)}`],
    });
    expect(resolveRows(cmd("pick 3 9 onto main"), rows, true)).toEqual({ notes: ["the log has 3 rows"] });
    expect(resolveRows(cmd("pick 0 onto main"), rows, true)).toEqual({ notes: ["the log has 3 rows"] });
  });

  it("leaves other commands alone", () => {
    expect(resolveRows(cmd("log"), rows, true)).toBeNull();
    expect(resolveRows(cmd("pick abc1234 onto main"), rows, true)).toBeNull();
  });
});
