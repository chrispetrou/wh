"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { blockText, type Block } from "@/lib/block";
import { chatStore, type LogRow, type PrPick } from "@/lib/chat-store";
import { commandHint, parseCommand } from "@/lib/commands";
import { signInAgain, takeResume } from "@/lib/signin";
import { LogBlock } from "./log-block";
import { ModelGlyph } from "./glyph";
import { relTime } from "@/lib/utils";
import {
  DEFAULT_MODELS,
  EFFORTS,
  FREE_TIER,
  MODEL_RE,
  modelFamily,
  SUGGESTED_MODELS,
  type ProviderName,
} from "@/lib/explain/providers";
import { keyStore, type Left } from "@/lib/key-store";
import { fmtTokens, lowLine, usageParts } from "@/lib/explain/usage";
import { currentTheme, switchTheme, type Theme } from "./theme-toggle";

type Cls = "p" | "c" | "o" | "g" | "a" | "x" | "r" | "f" | "";

// a leading span in its own color: the green "→ verb" of a success line,
// the amber "error:" label, or the fg command column of a help table
interface Head {
  text: string;
  cls: Cls;
}

interface Line {
  text: string;
  cls: Cls;
  prefix?: string; // muted prompt rendered before the text
  head?: Head;
  tail?: Head; // trailing span, e.g. the muted status words of a branch row
  block?: Block; // a structured entry (log, history, prs) rendered as a grid
  action?: "signin"; // a line that is a button: sign in again, in a popup
}

const CLS: Record<Cls, string> = {
  p: "text-muted-foreground",
  c: "font-semibold",
  o: "text-muted-foreground",
  g: "text-wd-green",
  a: "text-wd-amber",
  x: "text-wd-accent",
  r: "text-destructive",
  f: "text-wd-faint",
  "": "",
};

// a line as plain text, for /copy and /export
function flat(l: Line): string {
  if (l.block) return blockText(l.block).join("\n");
  return (
    (l.prefix ? `${l.prefix} ` : "") + (l.head?.text ?? "") + l.text + (l.tail?.text ?? "")
  );
}


// a branches row: "3  feat/web_app    behind 1". like the landing picker
// and wd ls, the name is fg and the index and status words are muted
const BRANCH_ROW = /^(\s*\d+\s{2})(\S+)(.*)$/;

function branchLine(text: string): Line {
  const m = BRANCH_ROW.exec(text);
  if (!m) return { text, cls: "o" }; // the count and note lines
  return {
    head: { text: m[1], cls: "o" },
    text: m[2],
    cls: "",
    tail: { text: m[3], cls: "o" },
  };
}

// a tags row: "2\tv1.10  \ta1b2c3d\t<iso>"; the name is fg, the rest muted,
// the date relative like the picker
function tagLine(text: string): Line {
  const f = text.split("\t");
  if (f.length < 4) return { text, cls: "o" };
  const [num, name, sha, iso] = f;
  return {
    head: { text: `${num}  `, cls: "o" },
    text: name,
    cls: "",
    tail: { text: `${sha}${iso ? `  ${relTime(iso)}` : ""}`, cls: "o" },
  };
}

// the section labels of both output contracts, painted amber
const LABELS = new Set(["summary", "watch out", "added", "changed", "fixed", "removed", "why"]);

// urls in output become quiet accent links
const URL_RE = /\bhttps?:\/\/[^\s]+|\bgithub\.com\/[^\s]+/g;

function renderText(text: string) {
  const parts = text.split(URL_RE);
  const urls = text.match(URL_RE);
  if (!urls) return text;
  const out: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    out.push(part);
    const url = urls[i];
    if (url) {
      out.push(
        <a
          key={i}
          href={url.startsWith("http") ? url : `https://${url}`}
          target="_blank"
          rel="noreferrer"
          className="text-wd-accent underline decoration-wd-faint underline-offset-2 hover:decoration-wd-accent"
        >
          {url}
        </a>
      );
    }
  });
  return out;
}

const RECENT_STORE = "wd_recent";

interface ExplainMeta {
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  title: string | null;
  note: string | null;
  context?: string;
  followup?: boolean;
  branches?: boolean;
  tags?: boolean;
  block?: Block; // log, history, prs: rendered as a grid, no text follows
  rows?: LogRow[] | PrPick[]; // the block's rows for `explain 3` and `pr ` completion
  empty?: string; // "nothing since yesterday": no diff, no model call
}

// help tables: a string ending in ":" is an amber section label, any
// other string a muted note, a pair is fg command + muted description
type HelpRow = string | [string, string];

const HELP_COL = 20;

const HELP: HelpRow[] = [
  "repo commands:",
  ["explain the last N commits [on <branch>]", ""],
  ["what changed in pr #N (or in <branch>)", ""],
  ["diff main..dev (any two refs)", ""],
  ["log [N] [on <branch>]", "the commit graph, rows numbered"],
  ["explain 3, explain 2..5", "rows of the last log"],
  ["explain <sha>", "one commit"],
  ["since yesterday [by me]", "a period, a ref, one author; standup"],
  ["changelog [range]", "release notes: added, changed, fixed, removed"],
  ["history <path>", "commits touching a file or dir, numbered"],
  ["... in <path>", "any explain, cut down to a file or dir"],
  ["why <path>:<line>", "why a line exists (blame, in plain words)"],
  ["branches", "list branches with ahead/behind"],
  ["tags", "list tags, newest first"],
  ["prs [open|closed|mine]", "pull requests, recently updated first"],
  "  after an explain, plain words are follow-up questions",
  "slash commands:",
  ["/repos", "switch repo"],
  ["/key <value>", "add an llm key (/key clear [provider] removes)"],
  ["/usage", "tokens on each key since it was saved (/usage reset)"],
  ["/model <name>", "pick the model; another provider's switches to it"],
  ["/effort <level>", "reasoning effort (model support varies)"],
  ["/theme <t>", "auto, light, or dark"],
  ["/account", "who is signed in"],
  ["/info", "repo, provider, theme, font"],
  ["/font <f>", "default, fira, jetbrains, or plex"],
  ["/fontsize <n>", "11 to 18, or default"],
  ["/ligatures <t>", "on or off"],
  ["/show", "the raw payload of the last command"],
  ["/copy", "copy the last answer to the clipboard"],
  ["/export", "save this transcript as a text file"],
  ["/wd", "about the wd cli"],
  ["/stop", "stop a running explain (esc works too)"],
  ["/clear", "clear the screen"],
  ["/logout", "sign out"],
  "keys:",
  ["tab", "complete"],
  ["up/down", "history; after a log, walk its rows"],
  ["enter / esc", "open a row, step back out"],
  ["ctrl+r", "search history"],
  ["esc", "stop, or close the menu"],
  ["cmd+k / ctrl+k", "repo picker"],
  ["ctrl+t", "new tab"],
  ["ctrl+1..9", "switch tabs"],
];

const WD_HELP: HelpRow[] = [
  "wd is also a cli: one tiny binary, no telemetry.",
  ["wd new <branch>", "worktree in a sibling dir, copies .env*"],
  ["wd ls", "worktrees with dirty and ahead/behind status"],
  ["wd switch [query]", "picker that cd's via a shell wrapper"],
  ["wd rm [name]", "prune worktrees whose branches are merged"],
  ["wd explain [range]", "this, in your terminal, on the same key"],
  ["wd init zsh", "the shell wrapper for switch"],
  "source: github.com/chrispetrou/wd",
];

function helpLines(rows: HelpRow[]): Line[] {
  return rows.map((row) => {
    if (typeof row === "string") {
      return { text: row, cls: row.endsWith(":") ? "a" : "o" };
    }
    const [cmd, desc] = row;
    return {
      head: { text: `  ${cmd}`.padEnd(HELP_COL), cls: "" },
      text: desc,
      cls: "o",
    };
  });
}

const FONTS = ["default", "fira", "jetbrains", "plex"];

const PROVIDERS = Object.keys(SUGGESTED_MODELS) as ProviderName[];

// every provider's models, the active provider's first. no "default"
// row: each provider's default is labeled, and picking it resets the
// override (typing /model default still works)
function modelArgs(): string[] {
  const a = keyStore.active();
  const order = a ? [a, ...PROVIDERS.filter((p) => p !== a)] : PROVIDERS;
  return order.flatMap((p) => SUGGESTED_MODELS[p]);
}

function effortArgs(): string[] {
  const a = keyStore.active();
  const levels = a ? EFFORTS[a] : [...new Set(Object.values(EFFORTS).flat())];
  return ["default", ...levels];
}

function keyArgs(): string[] {
  return ["clear", ...keyStore.providers().map((p) => `clear ${p}`)];
}

function usageArgs(): string[] {
  return ["reset", ...keyStore.providers().map((p) => `reset ${p}`)];
}

// the completion menu: commands, their descriptions, and their options
interface CmdSpec {
  name: string;
  desc: string;
  args?: string[] | (() => string[]);
}

const COMMANDS: CmdSpec[] = [
  { name: "/help", desc: "all commands and keys" },
  { name: "/repos", desc: "switch repo" },
  { name: "/key", desc: "add an llm key", args: keyArgs },
  { name: "/usage", desc: "tokens per key", args: usageArgs },
  { name: "/model", desc: "pick the model", args: modelArgs },
  { name: "/effort", desc: "reasoning effort", args: effortArgs },
  { name: "/theme", desc: "light or dark", args: ["auto", "light", "dark"] },
  { name: "/font", desc: "terminal font", args: FONTS },
  {
    name: "/fontsize",
    desc: "11 to 18",
    args: ["default", "11", "12", "13", "14", "15", "16", "17", "18"],
  },
  { name: "/ligatures", desc: "fira and jetbrains only", args: ["on", "off"] },
  { name: "/account", desc: "who is signed in" },
  { name: "/info", desc: "repo, provider, theme, font" },
  { name: "/show", desc: "raw payload of the last command" },
  { name: "/copy", desc: "copy the last answer" },
  { name: "/export", desc: "save the transcript" },
  { name: "/wd", desc: "about the wd cli" },
  { name: "/stop", desc: "stop a running explain" },
  { name: "/clear", desc: "clear the screen" },
  { name: "/logout", desc: "sign out" },
];

interface Menu {
  stage: "cmd" | "arg" | "branch" | "row" | "pr";
  rows: string[];
  spec?: CmdSpec;
  prefix?: string; // branch and row stages: the text before the slot
}

// where a branch name belongs in a repo command being typed
interface BranchSlot {
  prefix: string;
  partial: string;
}

function branchSlot(input: string): BranchSlot | null {
  if (!input || input.startsWith("/")) return null;
  let m = /^((?:wd\s+)?what\s+changed\s+(?:in|on)\s+)(\S*)$/i.exec(input);
  if (m && !/^pr\b|^#/i.test(m[2])) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:explain\s+(?:the\s+)?)?last\s+\d{1,3}(?:\s+commits?)?\s+on\s+)(\S*)$/i.exec(
    input
  );
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:git\s+)?(?:log|graph|history)(?:\s+\S+)?\s+on\s+)(\S*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?why\s+\S+:\d+\s+on\s+)(\S*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  // "since <ref>" anywhere at the end, and the first side of a changelog range
  m = /^((?:wd\s+)?(?:.*\s)?since\s+)([^\s.]*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:changelog|release\s+notes)\s+)([^\s.]*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:(?:wd\s+)?(?:diff|compare|explain)\s+)?\S*?\.{2,3})(\S*)$/i.exec(input);
  if (m && m[1].includes("..")) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:diff|compare)\s+)([^\s.]*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  return null;
}

// "explain " with a log on screen offers its row numbers
function rowSlot(input: string): BranchSlot | null {
  const m = /^((?:wd\s+)?(?:explain|show)\s+)(\d{0,3})$/i.exec(input);
  return m ? { prefix: m[1], partial: m[2] } : null;
}

// "pr " with a prs list on screen offers its numbers
function prSlot(input: string): BranchSlot | null {
  const m =
    /^((?:wd\s+)?(?:(?:explain|changelog|release\s+notes)\s+(?:for\s+)?|what\s+changed\s+in\s+)?(?:pr|pull\s+request)\s*#?)(\d{0,6})$/i.exec(
      input
    );
  return m ? { prefix: m[1], partial: m[2] } : null;
}

function menuFor(input: string): Menu | null {
  if (!input.startsWith("/")) return null;
  const sp = input.indexOf(" ");
  if (sp < 0) {
    const q = input.toLowerCase();
    const rows = COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => c.name);
    return rows.length ? { stage: "cmd", rows } : null;
  }
  const spec = COMMANDS.find((c) => c.name === input.slice(0, sp).toLowerCase());
  if (!spec?.args) return null;
  const args = typeof spec.args === "function" ? spec.args() : spec.args;
  const partial = input.slice(sp + 1).toLowerCase();
  const rows = args.filter((a) => a.startsWith(partial));
  if (rows.length === 1 && rows[0] === partial) return null; // fully typed
  return rows.length ? { stage: "arg", rows, spec } : null;
}

function pref(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function setPref(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function applyFont(font: string) {
  const root = document.documentElement;
  if (font === "default") root.removeAttribute("data-font");
  else root.setAttribute("data-font", font);
  setPref("wd_font", font === "default" ? "" : font);
}

function applyFontSize(size: string) {
  const root = document.documentElement;
  if (size === "default") root.style.removeProperty("--wd-font-size");
  else root.style.setProperty("--wd-font-size", `${size}px`);
  setPref("wd_fontsize", size === "default" ? "" : size);
}

function applyLigatures(on: boolean) {
  const root = document.documentElement;
  if (on) root.removeAttribute("data-lig");
  else root.setAttribute("data-lig", "off");
  setPref("wd_lig", on ? "" : "off");
}

function modelList(p: ProviderName): string {
  const [first, ...rest] = SUGGESTED_MODELS[p];
  return [`${first} (default)`, ...rest].join(", ");
}

// one line per provider; the ones without a key say so
function modelSuggestionLines(): string[] {
  return PROVIDERS.map(
    (p) =>
      `${p}${FREE_TIER.includes(p) ? " (free tier)" : ""}: ${modelList(p)}${keyStore.hasKey(p) ? "" : " · no key"}`
  );
}

// one line per provider for /key
function keyLines(): string[] {
  const a = keyStore.active();
  return PROVIDERS.map((p) => {
    const state = keyStore.hasKey(p)
      ? p === a
        ? "set (active)"
        : "set"
      : FREE_TIER.includes(p)
        ? "none (free tier at console.groq.com)"
        : "none";
    return `${p.padEnd(10)}${state}`;
  });
}

function activeModel(): string {
  const a = keyStore.active();
  return a ? keyStore.model(a) : "";
}

function activeEffort(): string {
  const a = keyStore.active();
  return a ? keyStore.effort(a) : "";
}

// true when the active provider takes no effort level
function effortIgnored(): boolean {
  const a = keyStore.active();
  return a !== null && EFFORTS[a].length === 0;
}

function providerInfo(): string {
  const a = keyStore.active();
  if (!a) return "no key set";
  const override = keyStore.model(a);
  return `${a} · ${override || DEFAULT_MODELS[a]}`;
}

// the model a request goes to right now
function modelName(): string {
  const a = keyStore.active();
  return a ? keyStore.model(a) || DEFAULT_MODELS[a] : "";
}

// "aug 27"
function monthDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
}

// the footer's " · 12.4k tokens": in + out on the active key since it
// was saved; nothing at 0
function usageInfo(): string {
  const a = keyStore.active();
  const u = a ? keyStore.usage(a) : null;
  const total = u ? u.in + u.out : 0;
  return total ? ` · ${fmtTokens(total)} tokens` : "";
}

// the /info row
function usageInfoRow(): string {
  const a = keyStore.active();
  const u = a ? keyStore.usage(a) : null;
  if (!u) return "nothing counted yet";
  return `${fmtTokens(u.in + u.out)} tokens on ${a} since ${monthDay(u.since)}, /usage for the breakdown`;
}

// the /usage table: one row per provider, then the last headroom
function usageLines(): string[] {
  const a = keyStore.active();
  const rows = PROVIDERS.map((p) => {
    if (!keyStore.hasKey(p)) return `${p.padEnd(11)}no key`;
    const u = keyStore.usage(p);
    if (!u) return `${p.padEnd(11)}nothing yet${p === a ? " (active)" : ""}`;
    const n = u.answers === 1 ? "answer" : "answers";
    return `${p.padEnd(11)}${fmtTokens(u.in)} in · ${fmtTokens(u.out)} out · ${u.answers} ${n} · since ${monthDay(u.since)}${p === a ? " (active)" : ""}`;
  });
  const left = a ? keyStore.usage(a)?.left : undefined;
  if (left) {
    const parts = [
      left.tokens ? `${fmtTokens(left.tokens.left)} tokens` : "",
      left.requests ? `${fmtTokens(left.requests.left)} requests` : "",
    ].filter(Boolean);
    if (parts.length) rows.push(`${"headroom".padEnd(11)}${parts.join(" · ")} left (as of the last answer)`);
  }
  return rows;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

interface Note {
  text: string;
  cls?: string;
}

// notes beside a completion row: for /model, the provider, whether it
// is free, whether the row is that provider's default, and a warning
// when no key for it is stored
function argNotes(spec: CmdSpec | undefined, row: string): Note[] {
  if (row === "default") return [{ text: "provider default" }];
  if (spec?.name !== "/model") return [];
  const p = modelFamily(row);
  if (!p) return [];
  const notes: Note[] = [{ text: p }];
  if (FREE_TIER.includes(p)) notes.push({ text: "free", cls: "text-wd-green" });
  if (DEFAULT_MODELS[p] === row) notes.push({ text: "default", cls: "text-muted-foreground" });
  if (!keyStore.hasKey(p)) notes.push({ text: "no key", cls: "text-wd-amber" });
  return notes;
}

export function TerminalChat({
  owner,
  repo,
  login,
}: {
  owner: string;
  repo: string;
  login?: string;
}) {
  const router = useRouter();
  const storeKey = `${owner}/${repo}`;
  // chat state lives in the store so streams keep flowing on other tabs
  const lines = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.lines(storeKey) as Line[],
    () => chatStore.emptyLines() as Line[]
  );
  const busy = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.streaming(storeKey),
    () => false
  );
  const ctxLen = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.context(storeKey)?.length ?? 0,
    () => 0
  );
  const [input, setInput] = useState("");
  const [hasKey, setHasKey] = useState(true); // corrected on mount
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const partialRef = useRef("");
  const initRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [search, setSearch] = useState<{ q: string; idx: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const lastCmdRef = useRef("");
  const streamModeRef = useRef<"text" | "diff" | "branches" | "tags">("text");
  const prompt = `${owner}/${repo} $`;

  const push = (rows: Line[]) => chatStore.push(storeKey, rows);
  // lines that mark a state change (not streamed text, not the echo)
  // enter with a short fade; restored lines never animate
  const freshRef = useRef(new WeakSet<Line>());
  const enter = (rows: Line[]) => {
    rows.forEach((r) => freshRef.current.add(r));
    push(rows);
  };
  const muted = (texts: string[]) =>
    enter(texts.map((text) => ({ text, cls: "o" as Cls })));
  const echo = (text: string) =>
    push([{ prefix: prompt, text, cls: text.startsWith("/") ? "x" : "c" }]);
  // the landing's success line: green arrow and verb, muted detail
  const ok = (verb: string, detail = "") =>
    enter([
      {
        head: { text: `→ ${verb}`, cls: "g" },
        text: detail ? ` ${detail}` : "",
        cls: "o",
      },
    ]);
  // errors are warnings-colored, never red: amber label, fg message
  const err = (msg: string) =>
    enter([{ head: { text: "error:", cls: "a" }, text: ` ${msg}`, cls: "" }]);

  useEffect(() => {
    if (initRef.current) return; // strict mode re-runs mount effects
    initRef.current = true;
    const present = keyStore.providers().length > 0;
    setHasKey(present);
    // remember this repo for the picker's recent-first ordering
    try {
      const recent: string[] = JSON.parse(localStorage.getItem(RECENT_STORE) ?? "[]");
      const next = [storeKey, ...recent.filter((r) => r !== storeKey)].slice(0, 5);
      localStorage.setItem(RECENT_STORE, JSON.stringify(next));
    } catch {
      // ignore
    }
    // back from a sign-in that a dead session forced: say so under the
    // error, drop the button, and pick up where it stopped
    const resume = takeResume(storeKey);
    if (resume) {
      chatStore.setAll(
        storeKey,
        chatStore.lines(storeKey).filter((l) => (l as Line).action !== "signin")
      );
      ok("signed in", login ? `as ${login}` : "");
      if (resume.line !== undefined && resume.open) {
        chatStore.setExpanded(storeKey, resume.line, [resume.open]);
        chatStore.setLive(storeKey, { line: resume.line, selected: null });
      }
      if (resume.cmd) {
        lastCmdRef.current = resume.cmd;
        submit(resume.cmd);
      }
      return;
    }
    // a restored or still-live log means no boot lines
    if (chatStore.lines(storeKey).length) return;
    push([{ text: `▜ wd · ${owner}/${repo}`, cls: "o" }]);
    if (!present) {
      muted([
        "paste an api key to enable explanations: anthropic, openai, or groq (free tier at console.groq.com).",
        "it is stored only in this browser and sent per request.",
      ]);
    } else {
      muted([commandHint]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // elapsed ticker for the streaming cursor
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const iv = setInterval(
      () => setElapsed(Date.now() - chatStore.startedAt(storeKey)),
      100
    );
    return () => clearInterval(iv);
  }, [busy, storeKey]);

  // follow new output only while the view is pinned to the bottom, so
  // scrolling up to read earlier lines is never yanked back mid-stream.
  // a submit re-pins
  const pinnedRef = useRef(true);
  const onLogScroll = () => {
    const el = logRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    if (pinnedRef.current) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    }
  }, [lines, busy]);

  // cmd+k / ctrl+k jumps back to the repo picker
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        router.push("/repos");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [router]);

  const classify = (text: string): Line => {
    const t = text.trimEnd();
    if (streamModeRef.current === "branches") return branchLine(t);
    if (streamModeRef.current === "tags") return tagLine(t);
    if (streamModeRef.current === "diff") {
      if (t.startsWith("diff --git")) return { text, cls: "c" };
      if (t.startsWith("- ")) return { text, cls: "o" }; // payload commit list
      if (t.startsWith("+++") || t.startsWith("---")) return { text, cls: "o" };
      if (t.startsWith("@@")) return { text, cls: "x" };
      if (t.startsWith("+")) return { text, cls: "g" };
      if (t.startsWith("-")) return { text, cls: "r" };
      if (t.startsWith("...")) return { text, cls: "o" };
      return { text, cls: "" };
    }
    if (LABELS.has(t)) return { text, cls: "a" };
    if (t.startsWith("[wd:error] "))
      return { head: { text: "error:", cls: "a" }, text: ` ${t.slice(11)}`, cls: "" };
    if (t.startsWith("[wd:hint] ")) return { text: t.slice(10), cls: "o" };
    return { text, cls: "" };
  };

  // the answer's own lines, for the follow-up context; the [wd:...]
  // sentinel lines the route appends are not part of it
  const answerRef = useRef("");
  // what the route said the answer cost, parsed from its [wd:usage] line
  const usageRef = useRef<{ in?: number; out?: number; left?: Left | null } | null>(null);

  // every complete line passes here: sentinels are taken aside (nothing
  // to show), the rest is kept for the context and returned to show
  const sink = (line: string, complete: boolean): Line | null => {
    if (line.startsWith("[wd:usage] ")) {
      try {
        usageRef.current = JSON.parse(line.slice(11));
      } catch {
        // a bad sentinel is nothing to show
      }
      return null;
    }
    if (!line.startsWith("[wd:")) answerRef.current += complete ? `${line}\n` : line;
    return classify(line);
  };

  const takeUsage = () => {
    const u = usageRef.current;
    usageRef.current = null;
    return u;
  };

  const appendChunk = (chunk: string) => {
    partialRef.current += chunk;
    const parts = partialRef.current.split("\n");
    partialRef.current = parts.pop() ?? "";
    const rows = parts.map((p) => sink(p, true)).filter((l): l is Line => l !== null);
    if (rows.length) push(rows);
  };

  const flushPartial = () => {
    if (partialRef.current) {
      const row = sink(partialRef.current, false);
      if (row) push([row]);
      partialRef.current = "";
    }
  };

  // one streaming pipeline for commands, /show, and follow-up turns
  const stream = async (
    body: object,
    opts: {
      raw?: boolean;
      metrics?: boolean; // close with "· 3.2s · model" (model answers only)
      onMeta?: (meta: ExplainMeta) => void;
    }
  ): Promise<string | null> => {
    chatStore.abort(storeKey);
    const abort = new AbortController();
    streamModeRef.current = opts.raw ? "diff" : "text";
    chatStore.setStreaming(storeKey, true, abort);
    const t0 = Date.now();
    answerRef.current = "";
    usageRef.current = null;
    let done = false;
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wd-provider-key": keyStore.activeKey(),
          "x-wd-model": activeModel(),
          "x-wd-effort": activeEffort(),
          "x-wd-tz": String(new Date().getTimezoneOffset()),
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const fail = (await res.json().catch(() => null)) as {
          error?: string;
          hint?: string | null;
        } | null;
        if (res.status === 401 && fail?.error?.includes("sign in")) {
          // the github session ended: say so, offer to sign in without
          // leaving the page, and rerun what failed once it is back
          err("your github session ended");
          enter([{ text: "", cls: "", action: "signin" }]);
          return null;
        }
        err(fail?.error ?? `request failed (${res.status})`);
        if (fail?.hint) muted([fail.hint]);
        return null;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let metaDone = false;
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (!metaDone) {
          const nl = buf.indexOf("\n");
          if (nl < 0) continue;
          opts.onMeta?.(JSON.parse(buf.slice(0, nl)) as ExplainMeta);
          buf = buf.slice(nl + 1);
          metaDone = true;
        }
        if (buf) {
          appendChunk(buf);
          buf = "";
        }
      }
      flushPartial();
      done = true;
      if (opts.metrics) {
        // count first, then push: the pushed line is what re-renders the
        // footer, which reads the count
        const u = takeUsage();
        const active = keyStore.active();
        const counted = u && typeof u.in === "number" ? { in: u.in, out: u.out ?? 0 } : null;
        if (active) keyStore.addUsage(active, counted?.in ?? 0, counted?.out ?? 0, u?.left);
        const cost = usageParts(counted);
        muted([`· ${seconds(Date.now() - t0)} · ${modelName()}${cost ? ` · ${cost}` : ""}`]);
        const low = active ? lowLine(active, u?.left) : null;
        if (low) enter([{ text: low, cls: "a" }]);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        err("connection interrupted");
      } else if (chatStore.owns(storeKey, abort)) {
        // esc or /stop; a stream superseded by a new command stays silent
        muted([`· stopped after ${seconds(Date.now() - t0)}`]);
      }
    } finally {
      if (chatStore.owns(storeKey, abort)) {
        streamModeRef.current = "text";
        chatStore.setStreaming(storeKey, false);
      }
    }
    return done ? answerRef.current : null;
  };

  const run = async (command: string, raw = false) => {
    const kind = parseCommand(command)?.kind;
    const lookup = ["branches", "log", "tags", "prs", "history"].includes(kind ?? "");
    // a new diff command starts a new context; lookups leave it alone
    if (!raw && !lookup) chatStore.clearContext(storeKey);
    let context = "";
    let empty = false;
    const full = await stream(
      { owner, repo, input: command, raw },
      {
        raw,
        metrics: !raw && !lookup,
        onMeta: (meta) => {
          if (meta.branches) {
            streamModeRef.current = "branches";
            return;
          }
          if (meta.tags) {
            streamModeRef.current = "tags";
            return;
          }
          if (meta.block) {
            // the grid goes in as one line; the arrow keys drive it until
            // the next command
            enter([{ text: "", cls: "", block: meta.block }]);
            if (meta.block.kind === "prs") {
              chatStore.setPrRows(storeKey, (meta.rows as PrPick[] | undefined) ?? []);
            } else {
              chatStore.setLogRows(storeKey, (meta.rows as LogRow[] | undefined) ?? []);
            }
            if (meta.block.rows.length) {
              chatStore.setLive(storeKey, {
                line: chatStore.lines(storeKey).length - 1,
                selected: null,
              });
            }
            return;
          }
          if (meta.empty) {
            empty = true;
            muted([meta.empty]);
            return;
          }
          context = meta.context ?? "";
          const rows = [
            `reading ${meta.commits} ${meta.commits === 1 ? "commit" : "commits"} · ${meta.files} ${meta.files === 1 ? "file" : "files"} · +${meta.additions} −${meta.deletions}`,
          ];
          if (meta.title) rows.push(`pr: ${meta.title}`);
          if (meta.note) rows.push(meta.note);
          if (meta.truncated) rows.push("comparison truncated by github");
          muted(rows);
          if (meta.files === 0) muted(["no changes in range"]);
        },
      }
    );
    if (empty) return;
    if (!raw && context && full?.trim()) {
      chatStore.setContext(storeKey, context, full.trim());
      if (!pref("wd_fu_hint")) {
        setPref("wd_fu_hint", "seen");
        muted(["(ask follow-ups in plain words, or run another command)"]);
      }
    }
  };

  const runFollowup = async (question: string) => {
    const history = chatStore.context(storeKey);
    if (!history) return;
    const full = await stream(
      { owner, repo, followup: { history, question } },
      { metrics: true }
    );
    if (full?.trim()) chatStore.appendExchange(storeKey, question, full.trim());
  };

  // sign in again via github and come back here; the command that hit
  // the wall reruns on return (see the mount effect)
  const reauth = () => signInAgain(storeKey, { cmd: lastCmdRef.current || undefined });

  const saveKey = (value: string, echoText: string) => {
    const { provider, replaced } = keyStore.addKey(value);
    setHasKey(true);
    echo(echoText);
    ok(
      "key saved",
      `${provider}${replaced ? ", replaced" : ""}, now active, stored in this browser only`
    );
  };

  const slash = (raw: string) => {
    const [cmd, ...rest] = raw.slice(1).split(" ");
    const arg = rest.join(" ").trim();
    switch (cmd.toLowerCase()) {
      case "help":
        echo(raw);
        push(helpLines(HELP));
        break;
      case "repos":
        echo(raw);
        router.push("/repos");
        break;
      case "clear":
        chatStore.setAll(storeKey, []);
        chatStore.clearContext(storeKey);
        chatStore.setLogRows(storeKey, undefined); // row numbers left with the screen
        chatStore.setPrRows(storeKey, undefined);
        chatStore.setLive(storeKey, undefined);
        chatStore.clearExpanded(storeKey);
        break;
      case "usage": {
        echo(raw);
        const [verb, which] = arg.split(/\s+/);
        const how = "usage: /usage reset [provider] starts the count over";
        if (!arg) {
          muted(
            keyStore.providers().length
              ? [...usageLines(), how]
              : ["no key set; the count starts when one is saved."]
          );
        } else if (verb !== "reset") {
          muted([how]);
        } else if (!which) {
          keyStore.resetUsage();
          ok("usage", "count started over for every key");
        } else {
          const target = PROVIDERS.find((p) => p === which);
          if (!target) {
            muted([how]);
          } else if (!keyStore.hasKey(target)) {
            muted([`no ${target} key stored.`]);
          } else {
            keyStore.resetUsage(target);
            ok("usage", `count started over for ${target}`);
          }
        }
        break;
      }
      case "key": {
        const usage = "usage: /key <value> adds or replaces, /key clear [provider] removes";
        const [verb, which] = arg.split(/\s+/);
        if (!arg) {
          echo(raw);
          muted([...keyLines(), usage]);
        } else if (verb === "clear" && !which) {
          keyStore.removeKey();
          setHasKey(false);
          echo(raw);
          muted(["all keys removed from this browser."]);
        } else if (verb === "clear") {
          echo(raw);
          const target = PROVIDERS.find((p) => p === which);
          if (!target) {
            muted([usage]);
          } else if (!keyStore.hasKey(target)) {
            muted([`no ${target} key stored.`]);
          } else {
            keyStore.removeKey(target);
            setHasKey(keyStore.providers().length > 0);
            muted([`${target} key removed from this browser.`, `now: ${providerInfo()}`]);
          }
        } else {
          saveKey(arg, "/key ***");
        }
        break;
      }
      case "model": {
        echo(raw);
        const m = arg.trim();
        const active = keyStore.active();
        if (!m) {
          muted([
            `model: ${providerInfo()}`,
            "usage: /model <name> or /model default; another provider's model switches to it",
            ...modelSuggestionLines(),
          ]);
        } else if (!active) {
          muted(["paste an api key first."]);
        } else if (m.toLowerCase() === "default") {
          keyStore.setModel(active, "");
          ok("model", `${modelName()} (${active} default)`);
        } else if (!MODEL_RE.test(m)) {
          muted(["that does not look like a model id."]);
        } else {
          // ids of unknown family (llama-*, mixtral-*) stay on the active provider
          const target = modelFamily(m) ?? active;
          if (!keyStore.hasKey(target)) {
            muted([`no ${target} key yet; /key <value> adds one.`]);
          } else {
            keyStore.setActive(target);
            keyStore.setModel(target, m === DEFAULT_MODELS[target] ? "" : m);
            ok("model", `${m}${target !== active ? ` (switched to ${target})` : ""}`);
            const lines: string[] = [];
            // said once; after that the green line is the whole story
            if (!pref("wd_model_hint")) {
              setPref("wd_model_hint", "seen");
              lines.push("it is sent per request, like the key.");
            }
            // providers with effort levels get the /effort menu right away,
            // so model and effort are one flow; esc keeps the current level
            if (EFFORTS[target].length) {
              lines.push(
                `effort: ${keyStore.effort(target) || "provider default"} · pick a level below, esc keeps it`
              );
              changeInput("/effort ");
              inputRef.current?.focus();
            }
            if (lines.length) muted(lines);
          }
        }
        break;
      }
      case "effort": {
        echo(raw);
        const level = arg.toLowerCase();
        const levels = effortArgs().slice(1);
        const active = keyStore.active();
        if (!active) {
          muted(["paste an api key first."]);
        } else if (effortIgnored() && level !== "default") {
          muted([`your key is ${active}: its models take no effort level.`]);
        } else if (!level) {
          muted([
            `effort: ${keyStore.effort(active) || "provider default"} (${active})`,
            `usage: /effort ${levels.join("|")} or /effort default`,
            "higher levels think longer; not every model accepts effort.",
          ]);
        } else if (level === "default") {
          keyStore.setEffort(active, "");
          ok("effort", `${active} default`);
        } else if (levels.includes(level)) {
          keyStore.setEffort(active, level);
          ok("effort", `${level} for ${active}`);
        } else {
          muted([`usage: /effort ${levels.join("|")} or /effort default`]);
        }
        break;
      }
      case "theme": {
        echo(raw);
        const t = arg.toLowerCase();
        if (t === "auto" || t === "light" || t === "dark") {
          switchTheme(t as Theme);
          ok("theme", t);
        } else {
          muted([`theme is ${currentTheme()}. usage: /theme auto|light|dark`]);
        }
        break;
      }
      case "account":
        echo(raw);
        muted(
          login
            ? [`signed in as ${login}`, `github.com/${login}`]
            : ["not signed in"]
        );
        break;
      case "info": {
        echo(raw);
        const ctx = chatStore.context(storeKey);
        muted([
          `repo      ${owner}/${repo}`,
          `provider  ${providerInfo()}`,
          `keys      ${keyStore.providers().join(", ") || "none"}`,
          `usage     ${usageInfoRow()}`,
          `theme     ${currentTheme()}`,
          `font      ${pref("wd_font") || "default"} · ${pref("wd_fontsize") || "13"}px · ligatures ${pref("wd_lig") === "off" ? "off" : "on"}`,
          `context   ${ctx ? `active (${ctx.length} messages), follow-ups on` : "none, run a command first"}`,
        ]);
        break;
      }
      case "font":
        echo(raw);
        if (FONTS.includes(arg.toLowerCase())) {
          applyFont(arg.toLowerCase());
          ok("font", arg.toLowerCase());
        } else {
          muted([
            `font is ${pref("wd_font") || "default"}. usage: /font ${FONTS.join("|")}`,
          ]);
        }
        break;
      case "fontsize": {
        echo(raw);
        const n = parseInt(arg, 10);
        if (arg === "default") {
          applyFontSize("default");
          ok("font size", "default");
        } else if (n >= 11 && n <= 18) {
          applyFontSize(String(n));
          ok("font size", `${n}px`);
        } else {
          muted(["usage: /fontsize 11..18 or default"]);
        }
        break;
      }
      case "ligatures": {
        echo(raw);
        const lig = arg.toLowerCase();
        if (lig === "on" || lig === "off") {
          applyLigatures(lig === "on");
          ok("ligatures", `${lig} (visible with fira or jetbrains)`);
        } else {
          muted(["usage: /ligatures on|off"]);
        }
        break;
      }
      case "show":
        echo(raw);
        if (!lastCmdRef.current) {
          muted(["nothing to show yet, run a repo command first."]);
        } else {
          muted([`payload for: ${lastCmdRef.current}`]);
          void run(lastCmdRef.current, true);
        }
        break;
      case "copy": {
        // the last answer: everything after the last prompt line, minus
        // status chatter (the muted lines), so a paste is just the text
        let start = lines.length;
        while (start > 0 && !lines[start - 1].prefix) start--;
        const answer = lines
          .slice(start)
          .filter((l) => l.cls !== "o")
          .map(flat);
        echo(raw);
        if (!answer.length) {
          muted(["nothing to copy yet."]);
          break;
        }
        navigator.clipboard
          .writeText(answer.join("\n") + "\n")
          .then(() => ok("copied", `${answer.length} ${answer.length === 1 ? "line" : "lines"}`))
          .catch(() => err("clipboard unavailable, select the text instead"));
        break;
      }
      case "export": {
        echo(raw);
        const text = lines.map(flat).join("\n");
        const blob = new Blob([text + "\n"], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `wd-${owner}-${repo}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
        ok("saved", a.download);
        break;
      }
      case "wd":
        echo(raw);
        push(helpLines(WD_HELP));
        break;
      case "stop":
        echo(raw);
        if (busy) chatStore.abort(storeKey);
        else muted(["nothing running."]);
        break;
      case "logout":
        echo(raw);
        muted(["signing out..."]);
        void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
          window.location.href = "/";
        });
        break;
      default:
        echo(raw);
        muted([`unknown command: /${cmd}. try /help`]);
    }
  };

  const submit = (given?: string) => {
    const raw = (given ?? input).trim();
    if (!raw) return;
    setInput("");
    setHistPos(-1);
    pinnedRef.current = true;
    chatStore.setLive(storeKey, undefined); // a new command takes the keys back

    if (raw.startsWith("/")) {
      if (!raw.startsWith("/key ")) historyRef.current.unshift(raw);
      slash(raw);
      return;
    }

    if (!hasKey) {
      // gated: whatever was typed is the key; never store or echo it
      saveKey(raw, "***");
      muted([commandHint]);
      return;
    }

    historyRef.current.unshift(raw);
    echo(raw);
    const cmd = parseCommand(raw);
    if (!cmd) {
      if (/^wd\s/i.test(raw)) {
        muted(["the worktree commands (new, ls, switch, rm) live in the cli: /wd"]);
        muted([commandHint]);
        return;
      }
      // plain words after an explain are a follow-up question
      if (chatStore.context(storeKey)) {
        void runFollowup(raw);
        return;
      }
      if (/\bpr\b/i.test(raw) && !/\d/.test(raw)) {
        muted(["name the pr by number, e.g. what changed in pr #42"]);
      }
      if (/^(?:file\s+)?history(?:\s+on\s+\S+)?$/i.test(raw)) {
        muted(["history takes a path: history src/git.rs [on <branch>]. log draws the graph"]);
        return;
      }
      muted([commandHint]);
      return;
    }
    // the docs placeholder typed literally
    if (
      cmd.kind === "range" &&
      cmd.base.toLowerCase() === "base" &&
      ["head", ""].includes(cmd.head.toLowerCase())
    ) {
      muted([
        "base..head is a placeholder: use real refs, e.g. diff main..feat/x",
        "(run branches to see what exists)",
      ]);
      return;
    }
    // rows of the last log become shas here; the server never sees numbers
    if (cmd.kind === "row") {
      const rows = chatStore.logRows(storeKey);
      if (!rows) {
        muted(["run log first, then explain a row: explain 3, or explain 2..5"]);
        return;
      }
      const a = rows[cmd.from - 1];
      const b = cmd.to ? rows[cmd.to - 1] : a;
      if (!a || !b) {
        muted([`the log has ${rows.length} ${rows.length === 1 ? "row" : "rows"}`]);
        return;
      }
      let resolved: string;
      if (!cmd.to) {
        resolved = a.sha;
        muted([`row ${cmd.from}: ${a.sha.slice(0, 7)} ${a.subject}`]);
      } else {
        if (!b.parent) {
          muted([`row ${cmd.to} is the first commit; try explain ${cmd.from}..${cmd.to - 1}`]);
          return;
        }
        resolved = `${b.parent}..${a.sha}`;
        muted([`rows ${cmd.from}..${cmd.to}: ${b.sha.slice(0, 7)} to ${a.sha.slice(0, 7)}`]);
      }
      if (cmd.path) resolved = `${resolved} in ${cmd.path}`;
      if (cmd.mode === "changelog") resolved = `changelog ${resolved}`;
      lastCmdRef.current = resolved;
      void run(resolved);
      return;
    }
    lastCmdRef.current = raw;
    void run(raw);
  };

  // ctrl+r reverse history search
  const searchMatch = (q: string, from: number): number => {
    const h = historyRef.current;
    for (let i = from; i < h.length; i++) {
      if (h[i].includes(q)) return i;
    }
    return -1;
  };

  // completion menu (fx-style dropdown for commands, options, branches)
  const [menuSel, setMenuSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const branchList = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.branchList(storeKey),
    () => undefined
  );
  const branchFetchRef = useRef(false);
  const logRows = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.logRows(storeKey),
    () => undefined
  );

  const slot = menuDismissed ? null : branchSlot(input);
  const slashMenu = menuDismissed ? null : menuFor(input);
  const branchRows =
    slot && branchList
      ? branchList
          .filter(
            (b) =>
              b.toLowerCase().startsWith(slot.partial.toLowerCase()) &&
              b !== slot.partial
          )
          .slice(0, 12)
      : [];
  const rslot = menuDismissed || !logRows?.length ? null : rowSlot(input);
  const rowRows = rslot
    ? logRows!
        .map((_, i) => String(i + 1))
        .filter((r) => r.startsWith(rslot.partial) && r !== rslot.partial)
        .slice(0, 12)
    : [];
  const prRows = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.prRows(storeKey),
    () => undefined
  );
  const pslot = menuDismissed || !prRows?.length ? null : prSlot(input);
  const prNums = pslot
    ? prRows!
        .map((p) => String(p.num))
        .filter((n) => n.startsWith(pslot.partial) && n !== pslot.partial)
        .slice(0, 12)
    : [];
  const menu: Menu | null =
    slashMenu ??
    (slot && branchRows.length
      ? { stage: "branch", rows: branchRows, prefix: slot.prefix }
      : rslot && rowRows.length
        ? { stage: "row", rows: rowRows, prefix: rslot.prefix }
        : pslot && prNums.length
          ? { stage: "pr", rows: prNums, prefix: pslot.prefix }
          : null);

  // one name column per menu, wide enough for its longest row
  const menuCol = menu ? Math.max(...menu.rows.map((r) => r.length)) : 0;

  // keep the keyboard selection visible inside the scrolling menu
  useEffect(() => {
    menuRef.current
      ?.querySelector(".row-sel")
      ?.scrollIntoView({ block: "nearest" });
  }, [menuSel]);

  // branch names load lazily the first time a slot appears
  useEffect(() => {
    if (!slot || branchList || branchFetchRef.current) return;
    branchFetchRef.current = true;
    fetch(`/api/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`)
      .then((r) => r.json())
      .then((j: { branches?: string[]; tags?: string[] }) =>
        chatStore.setBranches(storeKey, [...(j.branches ?? []), ...(j.tags ?? [])])
      )
      .catch(() => chatStore.setBranches(storeKey, []));
  }, [slot, branchList, owner, repo, storeKey]);

  const stageOf = (v: string): Menu["stage"] | undefined =>
    menuFor(v)?.stage ??
    (branchSlot(v) ? "branch" : rowSlot(v) ? "row" : prSlot(v) ? "pr" : undefined);

  const changeInput = (v: string) => {
    setInput(v);
    setMenuDismissed(false);
    // value stages default to "what you typed" so custom refs are never
    // hijacked by a listed suggestion; arrows opt into the list
    const st = stageOf(v);
    setMenuSel(st === "cmd" || st === undefined ? 0 : -1);
  };

  const applyMenuRow = (m: Menu, row: string) => {
    if (m.stage === "cmd") {
      const spec = COMMANDS.find((c) => c.name === row);
      if (spec?.args) {
        changeInput(`${row} `);
        inputRef.current?.focus();
      } else {
        changeInput("");
        submit(row);
      }
    } else if (m.stage === "row" || m.stage === "pr") {
      changeInput("");
      submit(`${m.prefix ?? ""}${row}`);
    } else if (m.stage === "branch") {
      const full = `${m.prefix ?? ""}${row}`;
      if (parseCommand(full)) {
        changeInput("");
        submit(full);
      } else {
        // an incomplete expression (e.g. the first side of a range)
        changeInput(full);
        inputRef.current?.focus();
      }
    } else {
      changeInput("");
      submit(`${m.spec?.name} ${row}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (search) {
      e.preventDefault();
      if (e.key === "Escape") {
        setSearch(null);
      } else if (e.key === "Enter") {
        const i = searchMatch(search.q, search.idx);
        if (i >= 0) setInput(historyRef.current[i]);
        setSearch(null);
      } else if (e.key === "r" && e.ctrlKey) {
        const i = searchMatch(search.q, search.idx);
        setSearch({ q: search.q, idx: i >= 0 ? i + 1 : 0 });
      } else if (e.key === "Backspace") {
        setSearch({ q: search.q.slice(0, -1), idx: 0 });
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setSearch({ q: search.q + e.key, idx: 0 });
      }
      return;
    }
    if (e.ctrlKey && e.key === "r") {
      e.preventDefault();
      setSearch({ q: "", idx: 0 });
      return;
    }
    // an empty prompt after a log, history, or prs block: the arrows walk
    // its rows, enter opens one, esc steps back out (then history again)
    const live = chatStore.live(storeKey);
    const liveBlock = live ? lines[live.line]?.block : undefined;
    if (live && liveBlock && input === "" && !menu) {
      const n = liveBlock.rows.length;
      const idAt = (i: number) =>
        liveBlock.kind === "log" ? liveBlock.rows[i].sha : String(liveBlock.rows[i].num);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        chatStore.setLive(storeKey, { ...live, selected: Math.min((live.selected ?? -1) + 1, n - 1) });
        return;
      }
      if (e.key === "ArrowUp" && live.selected !== null) {
        e.preventDefault();
        chatStore.setLive(storeKey, { ...live, selected: live.selected > 0 ? live.selected - 1 : null });
        return;
      }
      const expanded = chatStore.expanded(storeKey, live.line);
      if (e.key === "Enter" && live.selected !== null) {
        e.preventDefault();
        const id = idAt(live.selected);
        chatStore.setExpanded(
          storeKey,
          live.line,
          expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id]
        );
        return;
      }
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        if (expanded.length) chatStore.setExpanded(storeKey, live.line, []);
        else chatStore.setLive(storeKey, undefined);
        return;
      }
    }
    if (menu) {
      const minSel = menu.stage === "cmd" ? 0 : -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuSel(Math.min(menuSel + 1, menu.rows.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuSel(Math.max(menuSel - 1, minSel));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const row = menu.rows[Math.max(menuSel, 0)];
        if (menu.stage === "cmd") {
          const spec = COMMANDS.find((c) => c.name === row);
          changeInput(spec?.args ? `${row} ` : row);
        } else if (menu.stage === "branch" || menu.stage === "row" || menu.stage === "pr") {
          changeInput(`${menu.prefix ?? ""}${row}`);
        } else {
          changeInput(`${menu.spec?.name} ${row}`);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
      if (e.key === "Enter" && !(menu.stage !== "cmd" && menuSel < 0)) {
        e.preventDefault();
        applyMenuRow(menu, menu.rows[Math.max(menuSel, 0)]);
        return;
      }
      // enter with no selection in the arg stage submits the typed text
    }
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp") {
      const h = historyRef.current;
      if (h.length === 0) return;
      e.preventDefault();
      const next = Math.min(histPos + 1, h.length - 1);
      setHistPos(next);
      setInput(h[next]);
    } else if (e.key === "ArrowDown") {
      if (histPos < 0) return;
      e.preventDefault();
      const next = histPos - 1;
      setHistPos(next);
      setInput(next < 0 ? "" : historyRef.current[next]);
    } else if (e.key === "Escape") {
      chatStore.abort(storeKey);
    }
  };

  const focusInput = () => {
    // a real terminal focuses on click, but never steal a text selection
    if (!window.getSelection()?.toString()) inputRef.current?.focus();
  };

  return (
    <div className="page-in flex min-h-0 flex-1 flex-col" onClick={focusInput}>
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        className="term-scroll"
        onScroll={onLogScroll}
      >
        {lines.map((l, i) => (
          // a prompt line opens a block: command and its output read as one
          <div
            key={i}
            className={`${l.prefix && i > 0 ? "mt-3" : ""} ${
              !l.block && freshRef.current.has(l) ? "line-in" : ""
            }`}
          >
            {l.prefix ? (
              <span className="text-muted-foreground">{l.prefix} </span>
            ) : null}
            {l.block ? (
              <LogBlock
                block={l.block}
                line={i}
                storeKey={storeKey}
                owner={owner}
                repo={repo}
                submit={(c) => submit(c)}
                fresh={freshRef.current.has(l)}
              />
            ) : l.action === "signin" ? (
              <button type="button" className="log-action" onClick={reauth}>
                sign in again <span className="text-wd-green">→</span>
              </button>
            ) : (
              <>
                {l.head ? <span className={CLS[l.head.cls]}>{l.head.text}</span> : null}
                <span className={CLS[l.cls]}>{renderText(l.text)}</span>
                {l.tail ? <span className={CLS[l.tail.cls]}>{l.tail.text}</span> : null}
              </>
            )}
          </div>
        ))}
        {busy ? (
          <div>
            <span className="cursor" />
            <span className="text-muted-foreground"> {seconds(elapsed)}</span>
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-2 pt-3">
        <span className="shrink-0 text-muted-foreground">{prompt}</span>
        <input
          ref={inputRef}
          className={`term-input ${input.startsWith("/") ? "text-wd-accent" : ""}`}
          style={input.startsWith("/") ? { color: "var(--wd-accent)" } : undefined}
          value={input}
          onChange={(e) => changeInput(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          aria-label="command input"
        />
      </div>
      {search ? (
        <div className="pt-1 text-muted-foreground">
          (reverse-i-search) &apos;{search.q}&apos;:{" "}
          {(() => {
            const i = searchMatch(search.q, search.idx);
            return i >= 0 ? historyRef.current[i] : "";
          })()}
        </div>
      ) : menu ? (
        <div className="mt-2 border-t border-border pt-1.5">
          <div ref={menuRef} className="max-h-56 overflow-y-auto">
            {menu.rows.map((row, i) => {
              const spec =
                menu.stage === "cmd"
                  ? COMMANDS.find((c) => c.name === row)
                  : undefined;
              const sel = i === menuSel;
              return (
                <button
                  key={row}
                  type="button"
                  onClick={() => applyMenuRow(menu, row)}
                  onMouseEnter={() => setMenuSel(i)}
                  className={`flex w-full cursor-pointer items-baseline gap-2 rounded-[3px] px-1.5 py-0.5 text-left ${
                    sel ? "row-sel" : ""
                  }`}
                >
                  {/* the landing picker's marker, and one column width for
                      the whole menu so descriptions line up */}
                  <span className="shrink-0 text-muted-foreground">{sel ? "›" : " "}</span>
                  <span
                    className={`shrink-0 ${sel ? "font-semibold" : "text-wd-accent"}`}
                    style={{ minWidth: `${menuCol}ch` }}
                  >
                    {row}
                  </span>
                  {spec ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {spec.desc}
                    </span>
                  ) : menu.stage === "arg" && argNotes(menu.spec, row).length ? (
                    <span className="text-muted-foreground">
                      {argNotes(menu.spec, row).map((n, j) => (
                        <span key={n.text}>
                          {j ? " · " : ""}
                          <span className={n.cls}>{n.text}</span>
                        </span>
                      ))}
                    </span>
                  ) : menu.stage === "branch" && row === branchList?.[0] ? (
                    <span className="text-muted-foreground">default branch</span>
                  ) : menu.stage === "row" ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {logRows?.[Number(row) - 1]?.subject}
                    </span>
                  ) : menu.stage === "pr" ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {prRows?.find((p) => String(p.num) === row)?.title}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="pt-1 text-wd-faint">
            ↑↓ navigate · tab complete · enter use · esc close
          </div>
        </div>
      ) : null}
      <div
        className="pt-1.5 text-muted-foreground"
        data-tip="the model runs on your key; /model changes it. tokens are counted here since the key was saved; /usage for the breakdown"
      >
        {/* localStorage reads must wait for mount or hydration breaks */}
        {mounted && keyStore.active() ? <ModelGlyph /> : null}
        {mounted ? providerInfo() : " "}
        {mounted && activeEffort() && !effortIgnored() ? ` · effort ${activeEffort()}` : ""}
        {mounted ? usageInfo() : ""}
      </div>
    </div>
  );
}
