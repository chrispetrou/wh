// a block is a structured transcript entry (the commit graph, a file's
// history, the pr list): one ChatLine carrying rows the terminal renders
// as a grid, and `blockText` flattens back to text for /copy and /export.
import { ascii, type LaneRow } from "./graph";
import { paste, warnings } from "./plan";
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

// what a rebase todo can do with a commit. pick plans (cherry-pick) only
// know pick and drop
export type PlanAction = "pick" | "reword" | "squash" | "fixup" | "drop" | "edit";

export interface PlanRow extends CommitRow {
  idx: number; // original position, for reset and reorder clashes
  message: string; // the full commit message
  files: string[]; // paths the commit touches
  clash: string[]; // of those, the ones also changed on the target
  action: PlanAction;
  text?: string; // an edited or drafted message, replacing `message`
}

// a ranked stat line: the label, a preformatted value, and a 0..1 share
// that draws the bar, so the renderer stays dumb
export interface StatRow {
  label: string; // path, author login, language
  value: string; // "14 commits", "38%"
  share: number; // 0..1
  note?: string; // "last touched 3w ago"
  group?: string; // amber section label, rendered once per run
}

export type Block =
  | { kind: "log"; rows: CommitRow[]; lanes: number; footer: string[] }
  | { kind: "prs"; rows: PrRow[]; footer: string[] }
  // label/value rows with bars (who, churn, activity), optionally opened
  // by a sparkline of weekly counts; read-only, nothing expands
  | {
      kind: "stat";
      spark?: { values: number[]; label: string };
      rows: StatRow[];
      footer: string[];
    }
  // a file read in place. the content is never here: lines are persisted
  // whole to sessionStorage on every push, so the block is an address
  // and the text loads lazily (see FileDetail in chat-store)
  | { kind: "file"; path: string; ref: string; mark?: number }
  // a rebase or cherry-pick plan: rows newest first like the log, edited
  // in place, flattened to the commands to paste
  | {
      kind: "plan";
      mode: "rebase" | "pick";
      base: { sha: string; ref?: string }; // the rebase target (its tip)
      head?: string; // the branch holding the rows, when known
      onto?: string; // the cherry-pick target
      rows: PlanRow[];
      footer: string[];
    };

// the blocks with a plain list of rows (the log and prs renderers)
export type ListBlock = Extract<Block, { kind: "log" | "prs" }>;

// text rendering: numbered rows, rails as git log --graph glyphs; a plan
// flattens to its paste block
const SPARK = "▁▂▃▄▅▆▇█";
const BAR_W = 20; // the text bar budget, in cells

export function blockText(b: Block, now = Date.now()): string[] {
  if (b.kind === "plan") return [...warnings(b), ...paste(b)];
  // the content lives in the unpersisted details map, so a transcript
  // export carries the address only; file text is copied by selecting it
  if (b.kind === "file") return [`view ${b.path}${b.mark ? `:${b.mark}` : ""} on ${b.ref}`];
  const out: string[] = [];
  if (b.kind === "stat") {
    if (b.spark) {
      const max = Math.max(1, ...b.spark.values);
      out.push(
        b.spark.values
          .map((v) => (v ? SPARK[Math.min(7, Math.ceil((v / max) * 8) - 1)] : SPARK[0]))
          .join("")
      );
      out.push(b.spark.label);
    }
    const labelW = Math.max(0, ...b.rows.map((r) => r.label.length)) + 2;
    let group: string | undefined;
    for (const r of b.rows) {
      if (r.group && r.group !== group) {
        group = r.group;
        out.push(group);
      }
      const bar = "█".repeat(Math.max(r.share > 0 ? 1 : 0, Math.round(r.share * BAR_W)));
      out.push(
        `${r.label.padEnd(labelW)}${bar.padEnd(BAR_W + 2)}${r.value}${r.note ? `  ${r.note}` : ""}`.trimEnd()
      );
    }
    return [...out, ...b.footer];
  }
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
