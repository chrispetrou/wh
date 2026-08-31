import { describe, expect, it } from "vitest";
import type { LogRow } from "../chat-store";
import { parseCommand } from "../commands";
import { resolveRows } from "./resolve";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const rows: LogRow[] = [
  { sha: A, parent: B, subject: "third" },
  { sha: B, parent: C, subject: "second" },
  { sha: C, parent: null, subject: "first" },
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
      notes: [`rows 1..2: ${"b".repeat(7)} to ${"a".repeat(7)}`],
    });
    expect(resolveRows(cmd("explain 1..2"), rows, false)).toEqual({
      notes: ["these rows are not contiguous; explain one row at a time"],
    });
    expect(resolveRows(cmd("explain 1..3"), rows, true)).toEqual({
      notes: ["row 3 is the first commit; try explain 1..2"],
    });
  });

  it("says what is missing", () => {
    expect(resolveRows(cmd("explain 2"), undefined, true)?.command).toBeUndefined();
    expect(resolveRows(cmd("explain 9"), rows, true)).toEqual({ notes: ["the log has 3 rows"] });
    expect(resolveRows(cmd("explain 9"), rows.slice(0, 1), true)).toEqual({ notes: ["the log has 1 row"] });
  });

  it("resolves a rebase over rows and a pick of rows", () => {
    expect(resolveRows(cmd("rebase 1..2"), rows, true)?.command).toBe(`rebase ${C}..${A}`);
    expect(resolveRows(cmd("rebase 1..2"), rows, false)?.command).toBeUndefined();
    expect(resolveRows(cmd("rebase 3"), rows, true)).toEqual({
      notes: ["row 3 is the first commit; there is nothing to rebase it onto"],
    });
    expect(resolveRows(cmd("pick 3 3 1 onto main"), rows, true)).toEqual({
      command: `pick ${C} ${A} onto main`,
      notes: [`rows 3 3 1: ${"c".repeat(7)} ${"a".repeat(7)}`],
    });
    expect(resolveRows(cmd("pick 3 9 onto main"), rows, true)).toEqual({ notes: ["the log has 3 rows"] });
  });

  it("leaves other commands alone", () => {
    expect(resolveRows(cmd("log"), rows, true)).toBeNull();
    expect(resolveRows(cmd("pick abc1234 onto main"), rows, true)).toBeNull();
  });
});
