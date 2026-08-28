// a block is a structured transcript entry (the commit graph, a file's
// history, the pr list): one ChatLine carrying rows the terminal renders
// as a grid, and `blockText` flattens back to text for /copy and /export.
import { ascii, type LaneRow } from "./graph";
import { relTime } from "./utils";

export interface Ref {
  name: string;
  kind: "default" | "branch" | "tag";
}

export interface CommitRow {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  date: string; // iso
  refs: Ref[];
  graph?: Omit<LaneRow, "sha">; // absent for history rows
}

export interface PrRow {
  num: number;
  title: string;
  author: string;
  head: string;
  base: string;
  updated: string; // iso
  flags: string[]; // draft, merged, closed
}

export type Block =
  | { kind: "log"; rows: CommitRow[]; lanes: number; footer: string[] }
  | { kind: "prs"; rows: PrRow[]; footer: string[] };

// text rendering: numbered rows, rails as git log --graph glyphs
export function blockText(b: Block, now = Date.now()): string[] {
  const out: string[] = [];
  if (b.kind === "prs") {
    const w = Math.max(0, ...b.rows.map((r) => String(r.num).length)) + 1;
    for (const r of b.rows) {
      const flags = r.flags.length ? ` · ${r.flags.join(" · ")}` : "";
      out.push(
        `${`#${r.num}`.padEnd(w)} ${r.author}  ${r.title}  ${r.head} → ${r.base}  ${relTime(r.updated, now)}${flags}`
      );
    }
    return [...out, ...b.footer];
  }
  const numW = String(b.rows.length).length;
  const rails = b.lanes
    ? ascii(b.rows.map((r) => ({ sha: r.sha, ...r.graph! })))
    : b.rows.map((r) => ({ rails: "", sha: r.sha }));
  const railW = Math.max(0, ...rails.map((r) => r.rails.length));
  let n = 0;
  const bySha = new Map(b.rows.map((r) => [r.sha, r]));
  for (const rr of rails) {
    if (!rr.sha) {
      out.push(`${" ".repeat(numW)} ${rr.rails}`.trimEnd());
      continue;
    }
    const r = bySha.get(rr.sha)!;
    const refs = r.refs.length ? `${r.refs.map((x) => x.name).join(" ")} ` : "";
    out.push(
      `${String(++n).padStart(numW)} ${rr.rails.padEnd(railW)} ${r.sha.slice(0, 7)} ${refs}${r.subject}  ${r.author} ${relTime(r.date, now)}`.trimEnd()
    );
  }
  return [...out, ...b.footer];
}
