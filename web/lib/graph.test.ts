import { describe, expect, it } from "vitest";
import { graph, topoOrder, type GraphCommit } from "./graph";

// newest first, like the api hands them out
function c(sha: string, parents: string[], date: number): GraphCommit {
  return { sha, parents, date };
}

const rails = (commits: GraphCommit[]) =>
  graph(commits).map((r) => (r.sha ? `${r.rails}  ${r.sha}` : r.rails));

describe("graph", () => {
  it("draws a linear history as a single rail", () => {
    expect(rails([c("a", ["b"], 3), c("b", ["c"], 2), c("c", [], 1)])).toEqual([
      "*  a",
      "*  b",
      "*  c",
    ]);
  });

  it("opens and joins a lane around a merge", () => {
    const commits = [
      c("m", ["a", "b"], 5),
      c("a", ["c"], 4),
      c("b", ["c"], 3),
      c("c", [], 1),
    ];
    expect(rails(commits)).toEqual(["*  m", "|\\", "* |  a", "| *  b", "|/", "*  c"]);
  });

  it("draws two unmerged heads side by side", () => {
    const commits = [c("x", ["c"], 4), c("y", ["c"], 3), c("c", [], 1)];
    expect(rails(commits)).toEqual(["*  x", "| *  y", "|/", "*  c"]);
  });

  it("keeps a rail for a parent outside the window without a dangling glyph", () => {
    const commits = [c("a", ["z"], 4), c("b", ["z2"], 3)];
    expect(rails(commits)).toEqual(["*  a", "| *  b"]);
  });

  it("handles an octopus merge", () => {
    const commits = [
      c("m", ["a", "b", "c"], 9),
      c("a", ["r"], 8),
      c("b", ["r"], 7),
      c("c", ["r"], 6),
      c("r", [], 1),
    ];
    expect(rails(commits)).toEqual([
      "*  m",
      "|\\",
      "|\\ \\",
      "* | |  a",
      "| | *  b",
      "| * |  c",
      "| |/",
      "|/",
      "*  r",
    ]);
  });

  it("does not open a second lane for a parent already waited on", () => {
    // m merges b whose parent a is m's own first parent: git draws
    // `|\` then `| *` then `|/` since a is shared
    const commits = [c("m", ["a", "b"], 5), c("b", ["a"], 4), c("a", [], 1)];
    expect(rails(commits)).toEqual(["*  m", "|\\", "| *  b", "|/", "*  a"]);
  });
});

describe("topoOrder", () => {
  it("puts children before parents even when dates disagree", () => {
    // a rebased commit can carry an older date than its parent
    const ordered = topoOrder([c("p", [], 5), c("k", ["p"], 2)]).map((x) => x.sha);
    expect(ordered).toEqual(["k", "p"]);
  });

  it("orders independent heads newest first", () => {
    const ordered = topoOrder([c("old", [], 1), c("new", [], 3), c("mid", [], 2)]).map(
      (x) => x.sha
    );
    expect(ordered).toEqual(["new", "mid", "old"]);
  });
});
