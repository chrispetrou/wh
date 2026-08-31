// per-repo chat state living outside react, so a streaming explain keeps
// flowing while another tab is in the foreground. persisted to
// sessionStorage (200-line cap) exactly like the old in-component state.
import type { Block } from "./block";

// the color classes a line can carry: p prompt, c command, o muted, g
// green, a amber, x accent, r removed, f faint, "" fg
export type Cls = "p" | "c" | "o" | "g" | "a" | "x" | "r" | "f" | "";

// a leading span in its own color: the green "→ verb" of a success line,
// the amber "error:" label, or the fg command column of a help table
export interface Head {
  text: string;
  cls: Cls;
}

export interface ChatLine {
  text: string;
  cls: Cls;
  prefix?: string; // muted prompt rendered before the text
  head?: Head;
  tail?: Head; // trailing span, e.g. the muted status words of a branch row
  // a structured entry (commit graph, history, prs) rendered as a grid
  block?: Block;
  // a line that is a button: sign in again, in a popup
  action?: "signin";
  // a drop target for a dragged row: "branch:<name>"
  drop?: string;
}

// the block the arrow keys drive right now. what is open in a block is
// kept apart (see `expanded`), so a command launched from a panel does
// not close the panel it came from
export interface Live {
  line: number; // index into lines
  selected: number | null;
}

// lazily fetched details for the expanded panel, keyed "commit:<sha>"
// or "pr:<num>"; never persisted
export interface CommitDetail {
  kind: "commit";
  sha: string;
  parents: string[];
  author: { login: string | null; name: string; date: string };
  committer: { name: string; date: string };
  message: string;
  url: string;
  files: Array<{ path: string; additions: number; deletions: number; status: string }>;
}
export interface PrDetail {
  kind: "pr";
  num: number;
  title: string;
  body: string;
  author: string;
  head: string;
  base: string;
  flags: string[];
  url: string;
  commits: number;
  files: Array<{ path: string; additions: number; deletions: number; status: string }>;
}
export type Detail = CommitDetail | PrDetail;

// why a detail fetch failed; `auth` means the github session is gone
export interface DetailFailure {
  failed: string;
  auth: boolean;
}
export type DetailState = Detail | "loading" | DetailFailure;

// a row of the last log, so row numbers resolve to shas client-side
export interface LogRow {
  sha: string;
  parent: string | null;
  subject: string;
}

// a row of the last prs list, for the completion menu after `pr `
export interface PrPick {
  num: number;
  title: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// a message being drafted for a plan row: which block (by line, checked
// against the plan's base sha since lines shift) and which row (by sha)
export interface PendingDraft {
  line: number;
  base: string;
  sha: string;
}

interface Entry {
  lines: ChatLine[];
  streaming: boolean;
  startedAt: number;
  loaded: boolean;
  abort?: AbortController;
  // follow-up context: alternating user/assistant, [0] is the payload
  context?: ChatMessage[];
  // branch names for completion, default branch first, then tags
  branches?: string[];
  // rows of the last log, numbered from 1
  log?: LogRow[];
  logSpans?: boolean; // the rows are contiguous, so `explain 2..5` is a range
  // rows of the last prs list
  prs?: PrPick[];
  live?: Live;
  draft?: PendingDraft;
  // open rows per block line: shas, or pr numbers as strings
  expanded?: Map<number, string[]>;
  details?: Map<string, DetailState>;
}

const NONE: string[] = [];

const MAX_CONTEXT_MESSAGES = 26;
const MAX_CONTEXT_CHARS = 400_000;

const LIMIT = 200;
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: ChatLine[] = [];

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { lines: EMPTY, streaming: false, startedAt: 0, loaded: false };
    entries.set(key, e);
  }
  return e;
}

function load(key: string): Entry {
  const e = entry(key);
  if (e.loaded) return e;
  e.loaded = true;
  try {
    const s = sessionStorage.getItem(`wd_log:${key}`);
    if (s) {
      const p = JSON.parse(s) as ChatLine[];
      if (Array.isArray(p)) e.lines = p;
    }
  } catch {
    // ignore
  }
  return e;
}

function persist(key: string) {
  try {
    const e = entry(key);
    if (e.lines.length) {
      sessionStorage.setItem(`wd_log:${key}`, JSON.stringify(e.lines.slice(-LIMIT)));
    } else {
      sessionStorage.removeItem(`wd_log:${key}`);
    }
  } catch {
    // ignore
  }
}

function emit(key: string) {
  listeners.get(key)?.forEach((f) => f());
}

export const chatStore = {
  subscribe(key: string, cb: () => void): () => void {
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  },
  lines(key: string): ChatLine[] {
    return load(key).lines;
  },
  emptyLines(): ChatLine[] {
    return EMPTY;
  },
  push(key: string, rows: ChatLine[]) {
    const e = load(key);
    e.lines = [...e.lines, ...rows].slice(-LIMIT);
    persist(key);
    emit(key);
  },
  setAll(key: string, lines: ChatLine[]) {
    const e = load(key);
    e.lines = lines;
    persist(key);
    emit(key);
  },
  // a block edited in place (a plan's rows): the line keeps its place
  setBlock(key: string, line: number, block: Block) {
    const e = load(key);
    if (!e.lines[line]?.block) return;
    e.lines = e.lines.map((l, i) => (i === line ? { ...l, block } : l));
    persist(key);
    emit(key);
  },
  draft(key: string): PendingDraft | undefined {
    return entry(key).draft;
  },
  setDraft(key: string, d: PendingDraft | undefined) {
    entry(key).draft = d;
  },
  streaming(key: string): boolean {
    return entry(key).streaming;
  },
  startedAt(key: string): number {
    return entry(key).startedAt;
  },
  setStreaming(key: string, on: boolean, abort?: AbortController) {
    const e = entry(key);
    e.streaming = on;
    e.startedAt = on ? Date.now() : 0;
    e.abort = on ? abort : undefined;
    emit(key);
  },
  abort(key: string) {
    entry(key).abort?.abort();
  },
  // whether this controller still belongs to the live stream: a superseded
  // stream must not clear the state of the one that replaced it
  owns(key: string, abort: AbortController): boolean {
    return entry(key).abort === abort;
  },
  context(key: string): ChatMessage[] | undefined {
    return entry(key).context;
  },
  branchList(key: string): string[] | undefined {
    return entry(key).branches;
  },
  setBranches(key: string, branches: string[]) {
    entry(key).branches = branches;
    emit(key);
  },
  logRows(key: string): LogRow[] | undefined {
    return entry(key).log;
  },
  logSpans(key: string): boolean {
    return entry(key).logSpans ?? true;
  },
  setLogRows(key: string, rows: LogRow[] | undefined, spans = true) {
    const e = entry(key);
    e.log = rows;
    e.logSpans = spans;
    emit(key);
  },
  prRows(key: string): PrPick[] | undefined {
    return entry(key).prs;
  },
  setPrRows(key: string, rows: PrPick[] | undefined) {
    entry(key).prs = rows;
    emit(key);
  },
  live(key: string): Live | undefined {
    return entry(key).live;
  },
  setLive(key: string, live: Live | undefined) {
    entry(key).live = live;
    emit(key);
  },
  expanded(key: string, line: number): string[] {
    return entry(key).expanded?.get(line) ?? NONE;
  },
  setExpanded(key: string, line: number, ids: string[]) {
    const e = entry(key);
    e.expanded = new Map(e.expanded ?? []);
    e.expanded.set(line, ids);
    emit(key);
  },
  clearExpanded(key: string) {
    entry(key).expanded = undefined;
    emit(key);
  },
  detail(key: string, id: string): DetailState | undefined {
    return entry(key).details?.get(id);
  },
  details(key: string): Map<string, DetailState> | undefined {
    return entry(key).details;
  },
  setDetail(key: string, id: string, d: DetailState) {
    const e = entry(key);
    e.details = new Map(e.details ?? []);
    e.details.set(id, d);
    emit(key);
  },
  setContext(key: string, firstUser: string, firstAnswer: string) {
    entry(key).context = [
      { role: "user", content: firstUser },
      { role: "assistant", content: firstAnswer },
    ];
    emit(key);
  },
  clearContext(key: string) {
    entry(key).context = undefined;
    emit(key);
  },
  appendExchange(key: string, question: string, answer: string) {
    const e = entry(key);
    if (!e.context) return;
    let next = [
      ...e.context,
      { role: "user" as const, content: question },
      { role: "assistant" as const, content: answer },
    ];
    // trim middle pairs first; the payload pair at [0..1] must survive
    const size = () => next.reduce((n, m) => n + m.content.length, 0);
    while (next.length > MAX_CONTEXT_MESSAGES || size() > MAX_CONTEXT_CHARS) {
      if (next.length <= 4) break;
      next = [...next.slice(0, 2), ...next.slice(4)];
    }
    e.context = next;
    emit(key);
  },
};
