import { describe, expect, it } from "vitest";
import { ascii, laneCount, layout, topoOrder, type GraphCommit } from "./graph";

// newest first, like the api hands them out
function c(sha: string, parents: string[], date: number): GraphCommit {
  return { sha, parents, date };
}

const rails = (commits: GraphCommit[]) =>
  ascii(layout(commits)).map((r) => (r.sha ? `${r.rails}  ${r.sha}` : r.rails));

describe("layout", () => {
  it("keeps a linear history in one lane with one color", () => {
    const rows = layout([c("a", ["b"], 3), c("b", ["c"], 2), c("c", [], 1)]);
    expect(rows.map((r) => [r.sha, r.lane, r.color])).toEqual([
      ["a", 0, 0],
      ["b", 0, 0],
      ["c", 0, 0],
    ]);
    // the head has no line from above; the root none below
    expect(rows[0].ins).toEqual([]);
    expect(rows[0].outs).toEqual([{ to: 0, color: 0 }]);
    expect(rows[2].ins).toEqual([{ from: 0, color: 0 }]);
    expect(rows[2].outs).toEqual([]);
    expect(rails([c("a", ["b"], 3), c("b", ["c"], 2), c("c", [], 1)])).toEqual([
      "*  a",
      "*  b",
      "*  c",
    ]);
  });

  it("opens a second lane at a merge and joins it back", () => {
    const commits = [c("m", ["a", "b"], 5), c("a", ["c"], 4), c("b", ["c"], 3), c("c", [], 1)];
    const rows = layout(commits);
    const [m, a, b, cc] = rows;
    expect(m.merge).toBe(true);
    expect(m.outs).toEqual([
      { to: 0, color: 0 },
      { to: 1, color: 1 },
    ]);
    expect(a.lane).toBe(0);
    expect(a.through).toEqual([{ from: 1, to: 1, color: 1 }]);
    expect(b.lane).toBe(1);
    expect(b.color).toBe(1);
    expect(b.through).toEqual([{ from: 0, to: 0, color: 0 }]);
    // c is waited on by both threads: the second one joins in
    expect(cc.lane).toBe(0);
    expect(cc.ins).toEqual([
      { from: 0, color: 0 },
      { from: 1, color: 1 },
    ]);
    expect(laneCount(rows)).toBe(2);
    expect(rails(commits)).toEqual(["@  m", "|\\", "* |  a", "| *  b", "|/", "*  c"]);
  });

  it("draws two unmerged heads side by side", () => {
    const commits = [c("x", ["c"], 4), c("y", ["c"], 3), c("c", [], 1)];
    const rows = layout(commits);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].ins).toEqual([]); // a head
    expect(rails(commits)).toEqual(["*  x", "| *  y", "|/", "*  c"]);
  });

  it("keeps a lane for a parent outside the window", () => {
    const commits = [c("a", ["z"], 4), c("b", ["z2"], 3)];
    const rows = layout(commits);
    expect(rows[1].through).toEqual([{ from: 0, to: 0, color: 0 }]);
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
    const rows = layout(commits);
    expect(rows[0].outs.map((o) => o.to)).toEqual([0, 2, 1]);
    expect(laneCount(rows)).toBe(3);
    expect(rows[4].ins.map((i) => i.from)).toEqual([0, 1, 2]);
  });

  it("merges into a lane that is already waiting for the parent", () => {
    // m merges b whose parent a is m's own first parent
    const commits = [c("m", ["a", "b"], 5), c("b", ["a"], 4), c("a", [], 1)];
    const rows = layout(commits);
    expect(rows[0].outs).toEqual([
      { to: 0, color: 0 },
      { to: 1, color: 1 },
    ]);
    expect(rows[1].lane).toBe(1);
    // b's first parent a is already thread 0's target: b's line joins it
    expect(rows[1].outs).toEqual([{ to: 1, color: 1 }]);
    expect(rows[2].ins).toEqual([
      { from: 0, color: 0 },
      { from: 1, color: 1 },
    ]);
  });

  it("slides lanes left when a lane to their left closes", () => {
    // three heads; the middle one's parent is the first one's parent, so
    // when that parent is drawn the middle lane closes and lane 2 slides
    const commits = [c("x", ["p"], 5), c("y", ["p"], 4), c("z", ["q"], 3), c("p", ["r"], 2)];
    const rows = layout(commits);
    const p = rows[3];
    expect(p.ins.map((i) => i.from)).toEqual([0, 1]);
    expect(p.through).toEqual([{ from: 2, to: 1, color: 2 }]);
    // and when the commit is a root its own lane closes too
    const root = layout([c("x", ["p"], 5), c("y", ["p"], 4), c("z", ["q"], 3), c("p", [], 2)]);
    expect(root[3].outs).toEqual([]);
    expect(root[3].through).toEqual([{ from: 2, to: 0, color: 2 }]);
  });
});

describe("topoOrder", () => {
  it("puts children before parents even when dates disagree", () => {
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
