// commit graph layout from parent links alone: which lane each commit
// sits in, which lanes pass through its row, and where lines enter and
// leave. pure (no dates beyond tie-breaking, no dom), so it unit tests
// on hand-made histories. the terminal draws it as svg; `ascii` renders
// the same rows as text for /copy and /export.

export interface GraphCommit {
  sha: string;
  parents: string[];
  // committer time, iso or epoch ms; only used to break ties in topoOrder
  date?: string | number;
}

export interface Seg {
  from: number; // lane index at the top edge of the row
  to: number; // lane index at the bottom edge
  color: number;
}

export interface LaneRow {
  sha: string;
  lane: number; // column of the dot
  color: number; // thread color id of the commit
  merge: boolean;
  // lanes running straight through this row without touching the dot,
  // or sliding sideways when a lane closed to their left
  through: Seg[];
  // lines from the top edge into the dot (the commit's own thread, plus
  // any other thread waiting for this commit)
  ins: Array<{ from: number; color: number }>;
  // lines from the dot to the bottom edge (one per parent)
  outs: Array<{ to: number; color: number }>;
}

function ms(d: string | number | undefined): number {
  if (d === undefined) return 0;
  return typeof d === "number" ? d : new Date(d).getTime();
}

// children before parents, newest first among the ready ones. a union of
// several branch walks is not in git's order any more, and the lane
// algorithm needs every child drawn before its parent.
export function topoOrder(commits: GraphCommit[]): GraphCommit[] {
  const inSet = new Map(commits.map((c) => [c.sha, c]));
  const pending = new Map<string, number>(); // sha -> children still undrawn
  for (const c of commits) {
    for (const p of c.parents) {
      if (inSet.has(p)) pending.set(p, (pending.get(p) ?? 0) + 1);
    }
  }
  const ready = commits.filter((c) => !pending.get(c.sha));
  const out: GraphCommit[] = [];
  const done = new Set<string>();
  while (ready.length) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      if (ms(ready[i].date) > ms(ready[best].date)) best = i;
    }
    const [c] = ready.splice(best, 1);
    if (done.has(c.sha)) continue;
    done.add(c.sha);
    out.push(c);
    for (const p of c.parents) {
      const left = pending.get(p);
      if (left === undefined) continue;
      if (left === 1) {
        pending.delete(p);
        const pc = inSet.get(p);
        if (pc) ready.push(pc);
      } else {
        pending.set(p, left - 1);
      }
    }
  }
  return out;
}

// a lane is a thread waiting for a sha; it keeps its color for life
interface Thread {
  sha: string;
  color: number;
}

// lays out commits already in display order. a parent outside the window
// keeps its lane to the bottom and simply stops there.
export function layoutRows(ordered: GraphCommit[]): LaneRow[] {
  const lanes: Thread[] = [];
  let nextColor = 0;
  const rows: LaneRow[] = [];

  for (const c of ordered) {
    const top = lanes.slice();
    let thread = lanes.find((t) => t.sha === c.sha);
    const isHead = !thread;
    if (!thread) {
      thread = { sha: c.sha, color: nextColor++ };
      lanes.push(thread);
    }
    const lane = lanes.indexOf(thread);

    // other threads waiting for this commit join it and close
    const joined = lanes.filter((t) => t !== thread && t.sha === c.sha);
    for (const t of joined) lanes.splice(lanes.indexOf(t), 1);

    // the first parent continues the thread; a root closes it
    const [first, ...rest] = c.parents;
    const outThreads: Thread[] = [];
    if (first === undefined) {
      lanes.splice(lanes.indexOf(thread), 1);
    } else {
      thread.sha = first;
      outThreads.push(thread);
    }
    // extra parents: merge into a thread already waiting for them, or
    // open a new lane right next to this one
    for (const p of rest) {
      let t = lanes.find((x) => x.sha === p);
      if (!t) {
        t = { sha: p, color: nextColor++ };
        lanes.splice(Math.min(lane + 1, lanes.length), 0, t);
      }
      outThreads.push(t);
    }
    // indices only settle once every new lane is in place
    const outs = outThreads.map((t) => ({ to: lanes.indexOf(t), color: t.color }));

    const ins: LaneRow["ins"] = [];
    if (!isHead) ins.push({ from: lane, color: thread.color });
    for (const t of joined) ins.push({ from: top.indexOf(t), color: t.color });

    const through: Seg[] = [];
    top.forEach((t, from) => {
      if (t === thread || joined.includes(t)) return;
      const to = lanes.indexOf(t);
      if (to >= 0) through.push({ from, to, color: t.color });
    });

    rows.push({ sha: c.sha, lane, color: thread.color, merge: c.parents.length > 1, through, ins, outs });
  }
  return rows;
}

export function layout(commits: GraphCommit[]): LaneRow[] {
  return layoutRows(topoOrder(commits));
}

// widest lane count across the rows, for the column width
export function laneCount(rows: LaneRow[]): number {
  let n = 0;
  for (const r of rows) {
    n = Math.max(n, r.lane + 1);
    for (const s of r.through) n = Math.max(n, s.from + 1, s.to + 1);
    for (const s of r.ins) n = Math.max(n, s.from + 1);
    for (const s of r.outs) n = Math.max(n, s.to + 1);
  }
  return n;
}

// text rendering of the rails, `git log --graph` style, for exports. a
// join draws a `|/` row above the commit, a fork a `|\` row below it.
export function ascii(rows: LaneRow[]): Array<{ rails: string; sha?: string }> {
  const out: Array<{ rails: string; sha?: string }> = [];
  const width = laneCount(rows) * 2 - 1;
  const blank = () => new Array<string>(Math.max(width, 0)).fill(" ");
  for (const r of rows) {
    const joins = r.ins.filter((i) => i.from !== r.lane);
    if (joins.length) {
      const chars = blank();
      for (const s of r.through) if (s.from < r.lane) chars[s.from * 2] = "|";
      chars[r.lane * 2] = "|";
      for (const j of joins) chars[j.from * 2 - 1] = "/";
      // lanes sliding left past the join
      for (const s of r.through) if (s.from > r.lane && s.to < s.from) chars[s.from * 2 - 1] = "/";
      out.push({ rails: chars.join("").trimEnd() });
    }
    const chars = blank();
    for (const s of r.through) chars[s.from * 2] = "|";
    chars[r.lane * 2] = r.merge ? "@" : "*";
    out.push({ rails: chars.join("").trimEnd(), sha: r.sha });
    const forks = r.outs.filter((o) => o.to !== r.lane);
    if (forks.length) {
      const chars = blank();
      for (const s of r.through) if (s.to < r.lane) chars[s.to * 2] = "|";
      if (r.outs.some((o) => o.to === r.lane)) chars[r.lane * 2] = "|";
      for (const f of forks) chars[f.to * 2 - 1] = "\\";
      for (const s of r.through) if (s.to > r.lane && s.to > s.from) chars[s.to * 2 - 1] = "\\";
      out.push({ rails: chars.join("").trimEnd() });
    }
  }
  return out;
}
