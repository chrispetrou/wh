// the first line of every /api/explain response is one json object: what
// the diff is (a DiffMeta) or, for lookups, what kind of thing follows
// (a block, a branches or tags listing, an empty window). the route
// writes it, the terminal reads it.
import type { Block } from "../block";
import type { LogRow, PrPick } from "../chat-store";
import type { PromptMode } from "./prompt";

export interface DiffMeta {
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  title: string | null;
  note: string | null;
  mode: PromptMode;
}

// the meta line as received: a proxy can hand the client a 200 whose
// first line is not our json, so parsing must not throw mid-stream
export function parseMeta(line: string): ExplainMeta | null {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as ExplainMeta) : null;
  } catch {
    return null;
  }
}

export interface ExplainMeta extends Partial<DiffMeta> {
  context?: string; // the payload, kept client-side for follow-ups
  followup?: boolean;
  branches?: boolean;
  tags?: boolean;
  ls?: boolean;
  block?: Block; // log, history, prs: rendered as a grid, no text follows
  rows?: LogRow[] | PrPick[]; // the block's rows for `explain 3` and `pr ` completion
  spans?: boolean; // false when the rows are not contiguous (a filtered log, a history)
  empty?: string; // "nothing since yesterday": no diff, no model call
}
