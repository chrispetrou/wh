import { describe, expect, it } from "vitest";
import { blockText, type Block } from "./block";
import { layout } from "./graph";

const NOW = Date.parse("2026-08-27T12:00:00Z");
const T = "2026-08-27T09:00:00Z";

describe("blockText", () => {
  it("flattens a log block to git log --graph style text", () => {
    const rows = layout([
      { sha: "m", parents: ["a", "b"], date: 3 },
      { sha: "a", parents: ["c"], date: 2 },
      { sha: "b", parents: ["c"], date: 1 },
    ]);
    const b: Block = {
      kind: "log",
      lanes: 2,
      footer: ["3 commits · 2 branches"],
      rows: rows.map(({ sha, ...graph }) => ({
        sha: sha.repeat(7),
        parents: [],
        subject: `commit ${sha}`,
        author: "chris",
        date: T,
        refs: sha === "m" ? [{ name: "main", kind: "default" }] : [],
        graph,
      })),
    };
    expect(blockText(b, NOW)).toEqual([
      "1 @   mmmmmmm main commit m  chris 3h",
      "  |\\",
      "2 * | aaaaaaa commit a  chris 3h",
      "3 | * bbbbbbb commit b  chris 3h",
      "3 commits · 2 branches",
    ]);
  });

  it("flattens a prs block", () => {
    const b: Block = {
      kind: "prs",
      footer: ["1 open pr"],
      rows: [
        { num: 12, title: "fix", author: "alice", head: "f", base: "main", updated: T, flags: ["draft"] },
      ],
    };
    expect(blockText(b, NOW)).toEqual(["#12 alice  fix  f → main  3h · draft", "1 open pr"]);
  });
});

describe("blockText for a plan", () => {
  it("flattens to the warnings and the paste block", () => {
    const b: Block = {
      kind: "plan",
      mode: "pick",
      base: { sha: "0".repeat(40) },
      onto: "release/1.x",
      footer: [],
      rows: [
        {
          sha: "c".repeat(40),
          parents: [],
          subject: "fix typo",
          author: "chris",
          date: T,
          refs: [],
          idx: 0,
          message: "fix typo",
          files: [],
          clash: [],
          action: "pick",
        },
      ],
    };
    expect(blockText(b, NOW)).toEqual(["git switch release/1.x", `git cherry-pick -x ${"c".repeat(40)}`]);
  });
});
