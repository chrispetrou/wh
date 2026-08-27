// ascii commit graph in the `git log --graph` style, computed from parent
// links alone. pure: no dates, no github, no dom, so it unit tests on
// hand-made histories.
//
// rows come back in display order. a row with a sha is a commit row (`*`
// on its lane); a row without one is a connector (`|\` opening a merge
// lane, `|/` joining a branch back). lanes are two columns wide, so the
// rail string for k lanes is 2k-1 chars.

export interface GraphCommit {
  sha: string;
  parents: string[];
  // committer time, iso or epoch ms; only used to break ties in topoOrder
  date?: string | number;
}

export interface GraphRow {
  rails: string;
  sha?: string;
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

// draw the rails. `lanes[k]` is the sha the lane is waiting for; null is a
// lane that ended on a root commit. a parent outside the window keeps its
// rail to the bottom and simply stops there.
export function graphRows(ordered: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  // lanes from `hideFrom` on draw no `|`: on a connector row they are the
  // ones sliding sideways, drawn by the overlay instead
  const rail = (overlay: Map<number, string>, hideFrom = Infinity): string => {
    const width = Math.max(lanes.length * 2 - 1, 0);
    const chars = new Array<string>(width).fill(" ");
    lanes.forEach((sha, k) => {
      if (sha !== null && k < hideFrom) chars[k * 2] = "|";
    });
    overlay.forEach((ch, pos) => {
      if (pos >= 0 && pos < width) chars[pos] = ch;
    });
    return chars.join("").trimEnd();
  };

  for (const c of ordered) {
    let i = lanes.indexOf(c.sha);
    if (i < 0) {
      // a branch head: opens a new lane on the right
      i = lanes.length;
      lanes.push(c.sha);
    }

    // other lanes waiting for this same commit join in, rightmost first,
    // one `|/` row each; lanes to their right shift left with them
    for (;;) {
      const j = lanes.lastIndexOf(c.sha);
      if (j === i) break;
      const overlay = new Map<number, string>();
      for (let k = j; k < lanes.length; k++) overlay.set(k * 2 - 1, "/");
      rows.push({ rails: rail(overlay, j) });
      lanes.splice(j, 1);
    }

    const commit = new Map<number, string>([[i * 2, "*"]]);
    rows.push({ rails: rail(commit), sha: c.sha });

    const [first, ...rest] = c.parents;
    lanes[i] = first ?? null;
    if (first === undefined) {
      // root: the lane ends here; trailing empty lanes are dropped
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    }

    // extra parents open lanes right next to this one (`|\`), unless a
    // lane is already waiting for that parent
    for (const p of rest) {
      if (lanes.includes(p)) continue;
      lanes.splice(i + 1, 0, p);
      const overlay = new Map<number, string>();
      for (let k = i + 1; k < lanes.length; k++) overlay.set(k * 2 - 1, "\\");
      rows.push({ rails: rail(overlay, i + 1) });
    }
  }
  return rows;
}

export function graph(commits: GraphCommit[]): GraphRow[] {
  return graphRows(topoOrder(commits));
}
