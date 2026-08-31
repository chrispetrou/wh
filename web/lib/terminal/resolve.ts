// rows of the last log become shas here; the server never sees row
// numbers. an explain of a row or a span, a rebase over a span, a pick of
// several rows: each resolves to the command to send, with the muted
// notes to show first, or to notes only when it cannot.
import type { LogRow } from "../chat-store";
import type { Command } from "../commands";

export interface Resolved {
  command?: string;
  notes: string[];
}

const short = (sha: string) => sha.slice(0, 7);

function count(rows: LogRow[]): string {
  return `the log has ${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
}

// a span is a range only when each row is the first parent of the one
// above it: a graph interleaves lanes, and a filtered log skips commits,
// so row order alone proves nothing
function chained(rows: LogRow[], from: number, to: number): boolean {
  for (let i = from - 1; i < to - 1; i++) if (rows[i].parent !== rows[i + 1].sha) return false;
  return true;
}

export function resolveRows(
  cmd: Command,
  rows: LogRow[] | undefined,
  spans: boolean
): Resolved | null {
  if (cmd.kind === "row") {
    if (!rows) return { notes: ["run log first, then explain a row: explain 3, or explain 2..5"] };
    const a = rows[cmd.from - 1];
    const b = cmd.to ? rows[cmd.to - 1] : a;
    if (!a || !b) return { notes: [count(rows)] };
    let resolved: string;
    let note: string;
    if (!cmd.to) {
      resolved = a.sha;
      note = `row ${cmd.from}: ${short(a.sha)} ${a.subject}`;
    } else {
      // a filtered log or a history skips commits between its rows, so
      // a span would pull in what is not on screen
      if (!spans || !chained(rows, cmd.from, cmd.to)) {
        return { notes: ["these rows are not contiguous; explain one row at a time"] };
      }
      if (!b.parent) {
        const hint = cmd.to > cmd.from ? `; try explain ${cmd.from}..${cmd.to - 1}` : "";
        return { notes: [`row ${cmd.to} is the first commit${hint}`] };
      }
      resolved = `${b.parent}..${a.sha}`;
      note = `rows ${cmd.from}..${cmd.to}: ${short(a.sha)} to ${short(b.sha)}`;
    }
    if (cmd.path) resolved = `${resolved} in ${cmd.path}`;
    if (cmd.mode) resolved = `${cmd.mode} ${resolved}`;
    return { command: resolved, notes: [note] };
  }
  // a rebase over rows of the last log: shas here too
  if (cmd.kind === "plan" && cmd.source.kind === "row") {
    if (!rows) return { notes: ["run log first, then rebase a row span: rebase 2..5"] };
    const { from, to } = cmd.source;
    const a = rows[from - 1];
    const b = to ? rows[to - 1] : a;
    if (!a || !b) return { notes: [count(rows)] };
    if (to && (!spans || !chained(rows, from, to))) {
      return {
        notes: ["these rows are not contiguous; pick them onto a branch instead: pick 2 5 onto <branch>"],
      };
    }
    if (!b.parent) {
      return { notes: [`row ${to ?? from} is the first commit; there is nothing to rebase it onto`] };
    }
    // the server only sees shas, so the merge check that can name a row
    // lives here
    const merge = rows.slice(from - 1, to ?? from).findIndex((r) => r.merge);
    if (merge >= 0) {
      return { notes: [`row ${from + merge} is a merge; rebase plans need a linear history`] };
    }
    // the paste rewrites a branch from its tip. a span that stops short
    // of the tip takes the rows above it into the plan as picks, so
    // nothing is dropped; a merge or a gap on the way up makes that
    // impossible, and a cherry-pick is the way out
    const nums = to ? Array.from({ length: to - from + 1 }, (_, i) => from + i).join(" ") : String(from);
    const pickHint = `pick the rows onto a branch instead: pick ${nums} onto <branch>`;
    let tip = from;
    while (!rows[tip - 1].branch) {
      const above = tip > 1 ? rows[tip - 2] : undefined;
      if (!above || above.parent !== rows[tip - 1].sha) {
        return { notes: [`row ${from} is not on a branch's first-parent line; ${pickHint}`] };
      }
      if (above.merge) {
        return { notes: [`a merge (row ${tip - 1}) sits between row ${from} and the branch tip; ${pickHint}`] };
      }
      tip--;
    }
    const branch = rows[tip - 1].branch;
    const notes = [
      to
        ? `rows ${from}..${to}: ${short(a.sha)} to ${short(b.sha)}`
        : `row ${from}: ${short(a.sha)} ${a.subject}`,
    ];
    if (tip < from) {
      const along = from - tip === 1 ? `row ${tip} rides` : `rows ${tip}..${from - 1} ride`;
      notes.push(`${along} along as picks: the paste rewrites ${branch} from its tip`);
    }
    return { command: `rebase ${b.parent}..${branch}`, notes };
  }
  if (cmd.kind === "pick" && cmd.rows) {
    if (!rows) return { notes: ["run log first, then pick its rows: pick 3 5 onto <branch>"] };
    if (cmd.rows.some((n) => !rows[n - 1])) return { notes: [count(rows)] };
    const shas = [...new Set(cmd.rows.map((n) => rows[n - 1].sha))];
    return {
      command: `pick ${shas.join(" ")} onto ${cmd.onto}`,
      notes: [`rows ${cmd.rows.join(" ")}: ${shas.map(short).join(" ")}`],
    };
  }
  return null;
}
