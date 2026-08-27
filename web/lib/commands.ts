// deterministic chat grammar: a handful of intents, a small synonym
// surface, nothing fuzzy. the llm is only used to summarize, never to
// guess intent.

import { isPeriod } from "./time";

// changelog mode frames the same diff as release notes
export type Command = Shape & { mode?: "changelog" };

type Shape =
  | { kind: "last"; n: number; ref?: string }
  | { kind: "pr"; num: number }
  | { kind: "range"; base: string; head: string }
  | { kind: "branches" }
  // the ascii graph; n rows, all branches unless scoped with `on`
  | { kind: "log"; n?: number; ref?: string }
  // one commit by sha
  | { kind: "commit"; sha: string }
  // rows of the last log, resolved to shas client-side before sending
  | { kind: "row"; from: number; to?: number }
  // a period ("yesterday", "this week", "2026-08-20") or a ref ("v1.2"),
  // optionally one author's commits only ("me" is the signed-in user)
  | { kind: "since"; period: string; author?: string }
  | { kind: "tags" };

// "changelog", "changelog v1.1..v1.2", "release notes for pr 42",
// "changelog since v1.2"; bare means since the latest tag
const CHANGELOG = /^(?:changelog|release\s+notes)(?:\s+(?:for|of))?(?:\s+(.*))?$/i;
export const LATEST_TAG = "latest tag";

// lookups have no diff to frame
function isDiff(c: Command): boolean {
  return c.kind !== "branches" && c.kind !== "log" && c.kind !== "tags";
}

// log rows shown by default and at most
export const LOG_DEFAULT = 40;
export const LOG_MAX = 200;

// leading verbs people naturally type before any of the three shapes
const VERB = /^(?:(?:explain|summarize|show)(?:\s+me)?|what\s+changed\s+in)\s+/i;
// "last N commits", "last commit", "the last 5 commits on dev", ...
const LAST =
  /^(?:the\s+)?last(?:\s+(\d{1,3}))?(\s+commits?)?(?:\s+on\s+(\S+))?$/i;
// "pr 42", "pull request #42", "#42"
const PR = /^(?:the\s+)?(?:pr|pull\s+request)\s*#?\s*(\d{1,6})$/i;
const HASH = /^#(\d{1,6})$/;
// lazy match splits at the first run of 2+ dots; git forbids ".." inside
// refnames, so dotted branch names like v1.2 parse correctly. the head
// side may be empty (cli-style open ranges like HEAD~3..)
const RANGE = /^(\S+?)\.{2,3}(\S*)$/;
// "log", "git log 50", "graph on dev", bare "history"
const LOG = /^(?:git\s+)?(?:log|graph|history)(?:\s+(\d{1,3}))?(?:\s+on\s+(\S+))?$/i;
// an abbreviated or full sha
const SHA = /^[0-9a-f]{7,40}$/i;
// a row of the last log, or a span of rows
const ROW = /^(\d{1,3})$/;
const ROWS = /^(\d{1,3})\.\.(\d{1,3})$/;
// "since yesterday by me", "what did i do this week", "my commits since
// monday", "commits since v1.2", "standup"
const BY = /\s+by\s+(\S+)$/i;
const MINE = /^(?:what\s+did\s+i\s+do|my\s+commits|my\s+changes)(?:\s+|$)/i;
const COMMITS = /^(?:what\s+happened|what\s+changed|commits|changes)\s+/i;

function sinceCommand(phrase: string): Command | null {
  let p = phrase;
  let author: string | undefined;
  const by = BY.exec(p);
  if (by) {
    author = by[1];
    p = p.slice(0, by.index);
  }
  if (MINE.test(p)) {
    author = "me";
    p = p.replace(MINE, "");
  } else {
    p = p.replace(COMMITS, "");
  }
  if (/^standup$/i.test(p)) return { kind: "since", period: "standup", author: "me" };
  const since = /^since\s+(.+)$/i.exec(p);
  let period: string;
  if (since) {
    period = since[1];
    // a ref: "since v1.2", never a range or a period typo like "the merge"
    if (!isPeriod(period) && (period.includes(" ") || period.includes(".."))) return null;
  } else if (p && isPeriod(p)) {
    period = p; // bare "yesterday", "this week"
  } else {
    return null;
  }
  const out: Command = { kind: "since", period: period.toLowerCase() };
  if (author) out.author = author.toLowerCase();
  return out;
}

function clampN(s: string): number {
  return Math.min(Math.max(parseInt(s, 10), 1), 250);
}

export function parseCommand(raw: string): Command | null {
  let input = raw.trim().replace(/\s+/g, " ");
  if (!input) return null;
  // cli muscle memory ("wd explain HEAD~3..") and trailing question marks
  input = input.replace(/^wd\s+/i, "").replace(/\s*\?+$/, "");
  if (/^explain$/i.test(input)) return { kind: "last", n: 1 }; // cli default
  if (/^(?:list\s+)?branches$/i.test(input)) return { kind: "branches" };
  if (/^(?:list\s+)?tags$/i.test(input)) return { kind: "tags" };

  const changelog = CHANGELOG.exec(input);
  if (changelog) {
    const rest = (changelog[1] ?? "").trim();
    if (!rest) return { kind: "since", period: LATEST_TAG, mode: "changelog" };
    const inner = parseCommand(rest);
    return inner && isDiff(inner) ? { ...inner, mode: "changelog" } : null;
  }

  const phrase = input.replace(VERB, "");

  // a number, or the singular "last commit"; bare plural is too ambiguous
  const last = LAST.exec(phrase);
  if (last) {
    const n = last[1] ? clampN(last[1]) : /^\s+commit$/i.test(last[2] ?? "") ? 1 : 0;
    if (n) {
      return last[3] ? { kind: "last", n, ref: last[3] } : { kind: "last", n };
    }
  }

  const pr = PR.exec(phrase) ?? HASH.exec(phrase);
  if (pr) return { kind: "pr", num: parseInt(pr[1], 10) };

  const log = LOG.exec(phrase);
  if (log) {
    const out: Command = { kind: "log" };
    if (log[1]) out.n = Math.min(Math.max(parseInt(log[1], 10), 1), LOG_MAX);
    if (log[2]) out.ref = log[2];
    return out;
  }

  if (SHA.test(phrase)) return { kind: "commit", sha: phrase.toLowerCase() };

  const since = sinceCommand(phrase);
  if (since) return since;

  const row = ROW.exec(phrase);
  if (row) return { kind: "row", from: parseInt(row[1], 10) };
  const rows = ROWS.exec(phrase);
  if (rows) {
    const a = parseInt(rows[1], 10);
    const b = parseInt(rows[2], 10);
    return { kind: "row", from: Math.min(a, b), to: Math.max(a, b) };
  }

  // "what changed in <branch>": the branch's changes vs the default
  const wc = /^what\s+changed\s+(?:in|on)\s+(\S+)$/i.exec(input);
  if (wc && !/^pr$/i.test(wc[1]) && !wc[1].includes("..")) {
    return { kind: "range", base: "", head: wc[1] };
  }

  const rangeInput = input
    .replace(/^(?:diff|compare|explain|summarize|show)\s+/i, "")
    .replace(/\s+and\s+(?:summarize|explain)(?:\s+it)?$/i, "");
  const range = RANGE.exec(rangeInput);
  if (range) {
    const base = range[1];
    // empty head (or literal HEAD) means the repo's default branch tip
    const head = /^head$/i.test(range[2]) ? "" : range[2];
    const lastN = /^head~(\d{1,3})$/i.exec(base);
    if (lastN && head === "") return { kind: "last", n: clampN(lastN[1]) };
    return { kind: "range", base, head };
  }

  return null;
}

export const commandHint = [
  "commands:",
  "  explain the last N commits [on <branch>]",
  "  what changed in pr #N (or in <branch>)",
  "  diff main..dev (any two refs)",
  "  log [N] [on <branch>], then explain 3 or explain 2..5",
  "  explain <sha>",
  "  since yesterday | this week | v1.2 [by <login>], standup",
  "  changelog [v1.1..v1.2 | since v1.2 | pr #N] (release notes)",
  "  branches, tags",
  "  cli-style works too: wd explain HEAD~3..",
  "  /help for everything else",
].join("\n");
