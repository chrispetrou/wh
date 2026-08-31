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
      if (!spans) return { notes: ["these rows are not contiguous; explain one row at a time"] };
      if (!b.parent) {
        return { notes: [`row ${cmd.to} is the first commit; try explain ${cmd.from}..${cmd.to - 1}`] };
      }
      resolved = `${b.parent}..${a.sha}`;
      note = `rows ${cmd.from}..${cmd.to}: ${short(b.sha)} to ${short(a.sha)}`;
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
    if (to && !spans) {
      return {
        notes: ["these rows are not contiguous; pick them onto a branch instead: pick 2 5 onto <branch>"],
      };
    }
    if (!b.parent) {
      return { notes: [`row ${to ?? from} is the first commit; there is nothing to rebase it onto`] };
    }
    return {
      command: `rebase ${b.parent}..${a.sha}`,
      notes: [
        to
          ? `rows ${from}..${to}: ${short(b.sha)} to ${short(a.sha)}`
          : `row ${from}: ${short(a.sha)} ${a.subject}`,
      ],
    };
  }
  if (cmd.kind === "pick" && cmd.rows) {
    if (!rows) return { notes: ["run log first, then pick its rows: pick 3 5 onto <branch>"] };
    const missing = cmd.rows.find((n) => !rows[n - 1]);
    if (missing) return { notes: [count(rows)] };
    const shas = [...new Set(cmd.rows.map((n) => rows[n - 1].sha))];
    return {
      command: `pick ${shas.join(" ")} onto ${cmd.onto}`,
      notes: [`rows ${cmd.rows.join(" ")}: ${shas.map(short).join(" ")}`],
    };
  }
  return null;
}
