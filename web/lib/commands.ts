// deterministic chat grammar: a handful of intents, a small synonym
// surface, nothing fuzzy. the llm is only used to summarize, never to
// guess intent.

import { isPeriod } from "./time";

// changelog mode frames the same diff as release notes, describe mode as
// a pull request draft; a path cuts the diff down to one file or directory
export type Command = Shape & { mode?: "changelog" | "describe"; path?: string };

type Shape =
  | { kind: "last"; n: number; ref?: string }
  | { kind: "pr"; num: number }
  | { kind: "range"; base: string; head: string }
  | { kind: "branches" }
  // the ascii graph; n rows, all branches unless scoped with `on`; one
  // author and/or a window ("since yesterday", "since v1.2") draw it flat
  | { kind: "log"; n?: number; ref?: string; since?: string; author?: string }
  // one commit by sha
  | { kind: "commit"; sha: string }
  // rows of the last log, resolved to shas client-side before sending
  | { kind: "row"; from: number; to?: number }
  // a period ("yesterday", "this week", "2026-08-20") or a ref ("v1.2"),
  // optionally one author's commits only ("me" is the signed-in user)
  | { kind: "since"; period: string; author?: string }
  | { kind: "tags" }
  // pull requests: open (default), closed, or the signed-in user's
  | { kind: "prs"; state: "open" | "closed" | "mine" }
  // branches gone quiet: no commits in n weeks (default 8), or since a
  // period; never a ref
  | { kind: "stale"; weeks?: number; since?: string }
  // hotspots: the files changing most in a window, commit counts per path
  | { kind: "churn"; ref?: string; since?: string; path?: string }
  // the repo's pulse: weekly commit spark, top authors, languages. a
  // period only: the data is weekly buckets
  | { kind: "activity"; since?: string }
  // the commits touching a path, numbered like the log
  | { kind: "history"; path: string; ref?: string }
  // a file read in place: scrolling block, optionally opened at a line
  | { kind: "view"; path: string; line?: number; ref?: string }
  // a directory listing, for finding paths at all
  | { kind: "ls"; dir?: string; ref?: string }
  // who knows a file or dir: its authors ranked, recent work weighing more
  | { kind: "who"; path: string; ref?: string }
  // why a line (or a span of lines) exists: blame, then the blaming
  // commits cut to the file
  | { kind: "why"; path: string; line: number; to?: number; ref?: string }
  // a rebase plan over a linear set of commits: rows to reorder and mark,
  // the git commands to paste. never executed here
  | { kind: "plan"; source: PlanSource }
  // a cherry-pick plan: rows (of the last log), shas, or a pr's commits
  // onto a branch
  | { kind: "pick"; onto: string; shas?: string[]; rows?: number[]; pr?: number }
  // a commit message drafted from one or more commits (a plan row and
  // the rows folding into it); not in the hints, the plan block sends it
  | { kind: "message"; shas: string[] };

export type PlanSource = Extract<Shape, { kind: "range" | "pr" | "last" | "row" }>;

// "history src/git.rs", "history of src on dev"; bare history is not a
// command (the client nudges toward a path)
const HISTORY = /^(?:file\s+)?history\s+(?:of\s+|for\s+)?(\S+)(?:\s+on\s+(\S+))?$/i;
// "who src/git.rs", "who knows src on dev"; bare who is not a command
const WHO = /^who\s+(?:knows\s+|touched\s+|owns\s+)?(\S+)(?:\s+on\s+(\S+))?$/i;
// "view src/git.rs", "cat src/git.rs:42 on dev"; the lazy path plus an
// optional line mirrors why's reading
const VIEW = /^(?:view|cat)\s+(\S+?)(?::(\d{1,6}))?(?:\s+on\s+(\S+))?$/i;
// "ls", "ls src on dev"; bare root when no dir
const LS = /^ls(?:\s+(\S+))?(?:\s+on\s+(\S+))?$/i;
// "why src/git.rs:42", "why line 42 of src/git.rs", optional "on <ref>"
const WHY_COLON = /^why\s+(\S+?):(\d{1,6})(?:\s*(?:-|\.\.)\s*(\d{1,6}))?(?:\s+on\s+(\S+))?$/i;
const WHY_WORDS =
  /^why\s+lines?\s+(\d{1,6})(?:\s*(?:-|\.\.)\s*(\d{1,6}))?\s+(?:of|in)\s+(\S+)(?:\s+on\s+(\S+))?$/i;
// "<diff command> in <path>"
const IN_PATH = /^(.+?)\s+in\s+(\S+)$/i;
// "what changed in <path> since v1.2", "explain <path> main..dev"
const PATH_FIRST =
  /^(?:what\s+changed\s+in|changes\s+in|explain|show)\s+(\S+)\s+((?:since\s+.+)|\S+\.{2,3}\S*)$/i;

// "prs", "open prs", "closed pull requests", "my prs", "prs mine"
const PRS =
  /^(?:list\s+)?(?:(open|closed|my)\s+)?(?:prs|pull\s+requests)(?:\s+(open|closed|mine))?$/i;

// "stale", "stale 12w", "stale since 2026-06-01"
const STALE = /^(?:stale|stale\s+branches)(?:\s+(?:(\d{1,3})\s*w(?:eeks?)?|since\s+(.+)))?$/i;

// "activity", "activity since this week"
const ACTIVITY = /^activity(?:\s+since\s+(.+))?$/i;

// "churn", "hotspots since v1.2", "churn on dev in src": the filters come
// last, in any order, peeled like the log's
function churnCommand(input: string): Command | null {
  let p = input;
  let path: string | undefined;
  let ref: string | undefined;
  let since: string | undefined;
  for (;;) {
    const inm = path ? null : /\s+in\s+(\S+)$/i.exec(p);
    if (inm) {
      path = inm[1];
      p = p.slice(0, inm.index);
      continue;
    }
    const onm = ref ? null : /\s+on\s+(\S+)$/i.exec(p);
    if (onm) {
      ref = onm[1];
      p = p.slice(0, onm.index);
      continue;
    }
    const s = since ? null : LOG_SINCE.exec(p);
    if (s) {
      since = s[1];
      p = p.slice(0, s.index);
      continue;
    }
    break;
  }
  if (!/^(?:churn|hotspots)$/i.test(p)) return null;
  // a ref: "since v1.2", never a range or a period typo like "the merge"
  if (since && !isPeriod(since) && (since.includes(" ") || since.includes(".."))) return null;
  const out: Command = { kind: "churn" };
  if (ref) out.ref = ref;
  if (since) out.since = since.toLowerCase();
  if (path) out.path = path;
  return out;
}

// "changelog", "changelog v1.1..v1.2", "release notes for pr 42",
// "changelog since v1.2"; bare means since the latest tag
const CHANGELOG = /^(?:changelog|release\s+notes)(?:\s+(?:for|of))?(?:\s+(.*))?$/i;
export const LATEST_TAG = "latest tag";

// "describe pr 42", "describe feat/auth", "draft pr for main..dev",
// "pr description for #42"; a bare ref is the branch against the default.
// no bare form: the web has no current branch
const DESCRIBE = /^(?:describe|draft\s+(?:a\s+)?pr|pr\s+description)(?:\s+(?:for|of))?(?:\s+(.*))?$/i;

// "rebase feat/x", "rebase main..feat/x", "rebase pr #42", "rebase last 3
// on feat/x", "rebase 2..5" (rows of the last log)
const REBASE = /^rebase(?:\s+(.*))?$/i;
// "pick 3 5 onto release/1.x", "cherry-pick a1b2c3d onto main", "pick pr
// #42 onto release/1.x", "backport pr #42 to release/1.x"
const PICK = /^(?:cherry-)?pick\s+(.+?)\s+onto\s+(\S+)$/i;
const BACKPORT = /^backport\s+(.+?)\s+to\s+(\S+)$/i;
const MESSAGE = /^message\s+(.+)$/i;
export const MESSAGE_CAP = 10;

// lookups have no diff to frame; plans are edited, not explained
export function isDiff(c: Command): boolean {
  return ![
    "branches",
    "log",
    "tags",
    "prs",
    "stale",
    "churn",
    "activity",
    "history",
    "who",
    "view",
    "ls",
    "why",
    "plan",
    "pick",
    "message",
  ].includes(c.kind);
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
// "log", "git log 50", "graph on dev" (history is a file's story, see below)
const LOG = /^(?:git\s+)?(?:log|graph)(?:\s+(\d{1,3}))?(?:\s+on\s+(\S+))?$/i;
// "log since yesterday", "log 50 since this week by me": the filters come
// last, in either order, after `on`
const LOG_SINCE = /\s+since\s+(.+)$/i;
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

function logCommand(phrase: string): Command | null {
  let p = phrase;
  let author: string | undefined;
  let since: string | undefined;
  for (;;) {
    const by = author ? null : BY.exec(p);
    if (by) {
      author = by[1];
      p = p.slice(0, by.index);
      continue;
    }
    const s = since ? null : LOG_SINCE.exec(p);
    if (s) {
      since = s[1];
      p = p.slice(0, s.index);
      continue;
    }
    break;
  }
  const log = LOG.exec(p);
  if (!log) return null;
  // a ref: "since v1.2", never a range or a period typo like "the merge"
  if (since && !isPeriod(since) && (since.includes(" ") || since.includes(".."))) return null;
  const out: Command = { kind: "log" };
  if (log[1]) out.n = Math.min(Math.max(parseInt(log[1], 10), 1), LOG_MAX);
  if (log[2]) out.ref = log[2];
  if (since) out.since = since.toLowerCase();
  if (author) out.author = author.toLowerCase();
  return out;
}

function clampN(s: string): number {
  return Math.min(Math.max(parseInt(s, 10), 1), 250);
}

export function parseCommand(raw: string): Command | null {
  let input = raw.trim().replace(/\s+/g, " ");
  if (!input) return null;
  // the worktree commands belong to the cli; parsing "wh ls" here would
  // shadow the hint that says so
  if (/^wh\s+(?:new|switch|rm|ls)\b/i.test(input)) return null;
  // cli muscle memory ("wh explain HEAD~3..") and trailing question marks
  input = input.replace(/^wh\s+/i, "").replace(/\s*\?+$/, "");
  if (/^explain$/i.test(input)) return { kind: "last", n: 1 }; // cli default
  if (/^(?:list\s+)?branches$/i.test(input)) return { kind: "branches" };
  if (/^(?:list\s+)?tags$/i.test(input)) return { kind: "tags" };
  const prs = PRS.exec(input);
  if (prs) {
    const w = (prs[1] ?? prs[2] ?? "open").toLowerCase();
    return { kind: "prs", state: w === "my" || w === "mine" ? "mine" : (w as "open" | "closed") };
  }

  const stale = STALE.exec(input);
  if (stale) {
    if (stale[2]) {
      // a period only: a branch cutoff wants a date, never a ref
      if (!isPeriod(stale[2])) return null;
      return { kind: "stale", since: stale[2].toLowerCase() };
    }
    if (stale[1]) return { kind: "stale", weeks: Math.min(Math.max(parseInt(stale[1], 10), 1), 999) };
    return { kind: "stale" };
  }

  const churn = churnCommand(input);
  if (churn) return churn;

  const view = VIEW.exec(input);
  if (view) {
    const out: Command = { kind: "view", path: view[1] };
    if (view[2]) out.line = parseInt(view[2], 10);
    if (view[3]) out.ref = view[3];
    return out;
  }

  const ls = LS.exec(input);
  if (ls) {
    const out: Command = { kind: "ls" };
    if (ls[1]) out.dir = ls[1];
    if (ls[2]) out.ref = ls[2];
    return out;
  }

  const activity = ACTIVITY.exec(input);
  if (activity) {
    if (activity[1]) {
      // weekly buckets only cut on a period, never a ref
      if (!isPeriod(activity[1])) return null;
      return { kind: "activity", since: activity[1].toLowerCase() };
    }
    return { kind: "activity" };
  }

  const changelog = CHANGELOG.exec(input);
  if (changelog) {
    const rest = (changelog[1] ?? "").trim();
    if (!rest) return { kind: "since", period: LATEST_TAG, mode: "changelog" };
    const inner = parseCommand(rest);
    return inner && isDiff(inner) ? { ...inner, mode: "changelog" } : null;
  }

  const describe = DESCRIBE.exec(input);
  if (describe) {
    const rest = (describe[1] ?? "").trim();
    if (!rest) return null;
    const inner = parseCommand(rest);
    if (inner) return isDiff(inner) ? { ...inner, mode: "describe" } : null;
    if (/^\S+$/.test(rest) && !rest.includes("..")) {
      return { kind: "range", base: "", head: rest, mode: "describe" };
    }
    return null;
  }

  const rebase = REBASE.exec(input);
  if (rebase) {
    const rest = (rebase[1] ?? "").trim();
    if (!rest) return null;
    const inner = parseCommand(rest);
    if (inner) {
      if (inner.mode || inner.path) return null;
      if (["range", "pr", "last", "row"].includes(inner.kind)) {
        return { kind: "plan", source: inner as PlanSource };
      }
      return null;
    }
    if (/^\S+$/.test(rest) && !rest.includes("..")) {
      return { kind: "plan", source: { kind: "range", base: "", head: rest } };
    }
    return null;
  }

  const pick = PICK.exec(input) ?? BACKPORT.exec(input);
  if (pick) {
    const what = pick[1].trim();
    const onto = pick[2];
    if (onto.includes("..")) return null;
    const pr = PR.exec(what) ?? HASH.exec(what);
    if (pr) return { kind: "pick", onto, pr: parseInt(pr[1], 10) };
    const tokens = what.split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) return null;
    if (tokens.every((t) => ROW.test(t))) {
      return { kind: "pick", onto, rows: tokens.map((t) => parseInt(t, 10)) };
    }
    if (tokens.every((t) => SHA.test(t))) {
      return { kind: "pick", onto, shas: tokens.map((t) => t.toLowerCase()) };
    }
    return null;
  }

  const message = MESSAGE.exec(input);
  if (message) {
    const tokens = message[1].split(/[\s,]+/).filter(Boolean);
    if (!tokens.length || tokens.length > MESSAGE_CAP) return null;
    if (!tokens.every((t) => SHA.test(t))) return null;
    return { kind: "message", shas: tokens.map((t) => t.toLowerCase()) };
  }

  // a span reads low to high whichever way it was typed
  const whySpan = (path: string, a: string, b?: string, ref?: string): Command => {
    const from = parseInt(a, 10);
    const to = b ? parseInt(b, 10) : undefined;
    const out: Command =
      to !== undefined && to !== from
        ? { kind: "why", path, line: Math.min(from, to), to: Math.max(from, to) }
        : { kind: "why", path, line: from };
    if (ref) out.ref = ref;
    return out;
  };
  const why = WHY_COLON.exec(input);
  if (why) return whySpan(why[1], why[2], why[3], why[4]);
  const whyWords = WHY_WORDS.exec(input);
  if (whyWords) return whySpan(whyWords[3], whyWords[1], whyWords[2], whyWords[4]);

  // a path cut: only diff commands take one, and "in pr" or "in <branch>"
  // keep their meaning because their remainder is not a command
  const inPath = IN_PATH.exec(input);
  if (inPath) {
    const inner = parseCommand(inPath[1]);
    if (inner && isDiff(inner) && !inner.path && !/^(?:pr|#\d+)$/i.test(inPath[2])) {
      return { ...inner, path: inPath[2] };
    }
  }
  // "show log since yesterday" is a filtered log, not a path called log
  const pathFirst = PATH_FIRST.exec(input);
  if (pathFirst && !/^(?:log|graph)$/i.test(pathFirst[1])) {
    const inner = parseCommand(pathFirst[2]);
    if (inner && isDiff(inner)) return { ...inner, path: pathFirst[1] };
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

  const log = logCommand(phrase);
  if (log) return log;

  const history = HISTORY.exec(phrase);
  if (history) {
    const out: Command = { kind: "history", path: history[1] };
    if (history[2]) out.ref = history[2];
    return out;
  }

  const who = WHO.exec(phrase);
  if (who) {
    const out: Command = { kind: "who", path: who[1] };
    if (who[2]) out.ref = who[2];
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
  "  log [N] [on <branch>] [since <period>] [by <login>], then explain 3",
  "  explain <sha>",
  "  since yesterday | this week | v1.2 [by <login>], standup",
  "  changelog [v1.1..v1.2 | since v1.2 | pr #N] (release notes)",
  "  describe pr #N | <branch> | main..dev (a pr title and description to paste)",
  "  history <path>, why <path>:<line>[-<line>], who <path>, any command + in <path>",
  "  view <path>[:<line>] [on <branch>] (read a file; cat works), ls [<dir>]",
  "  rebase <branch> | main..feat | pr #N | 2..5 (a rebase plan to paste)",
  "  pick 3 5 onto <branch>, backport pr #N to <branch> (a cherry-pick plan)",
  "  branches, tags, prs [open | closed | mine], stale [8w]",
  "  churn [since <period | ref>] [on <branch>] [in <path>] (the files changing most)",
  "  activity [since <period>] (commit spark, authors, languages)",
  "  cli-style works too: wh explain HEAD~3..",
  "  /help for everything else: keys and mouse too",
].join("\n");
