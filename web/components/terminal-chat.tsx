"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { commandHint, parseCommand } from "@/lib/commands";
import { applyTheme, currentTheme, type Theme } from "./theme-toggle";

type Cls = "p" | "c" | "o" | "g" | "a" | "x" | "r" | "";

interface Line {
  text: string;
  cls: Cls;
  prefix?: string; // muted prompt rendered before the text
}

const CLS: Record<Cls, string> = {
  p: "text-muted-foreground",
  c: "font-semibold",
  o: "text-muted-foreground",
  g: "text-wd-green",
  a: "text-wd-amber",
  x: "text-wd-accent",
  r: "text-destructive",
  "": "",
};

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

const KEY_STORE = "wd_key";
const RECENT_STORE = "wd_recent";
const LOG_LIMIT = 200;

const HELP = [
  "repo commands:",
  "  explain the last N commits",
  "  what changed in pr #N",
  "  diff base..head",
  "slash commands:",
  "  /repos            switch repo",
  "  /key <value>      set the llm key (/key clear removes it)",
  "  /model <name>     pick the model (/model default resets)",
  "  /theme <t>        auto, light, or dark",
  "  /account          who is signed in",
  "  /info             repo, provider, theme, font",
  "  /font <f>         default, fira, jetbrains, or plex",
  "  /fontsize <n>     11 to 18, or default",
  "  /ligatures <t>    on or off",
  "  /show             the raw payload of the last command",
  "  /export           save this transcript as a text file",
  "  /wd               about the wd cli",
  "  /stop             stop a running explain (esc works too)",
  "  /clear            clear the screen",
  "  /logout           sign out",
  "keys: tab completes, up/down history, ctrl+r searches it,",
  "esc stops, cmd+k (or ctrl+k) jumps to the repo picker.",
];

const WD_HELP = [
  "wd is also a cli: one tiny binary, no telemetry.",
  "  wd new <branch>     worktree in a sibling dir, copies .env*",
  "  wd ls               worktrees with dirty and ahead/behind status",
  "  wd switch [query]   picker that cd's via a shell wrapper",
  "  wd rm [name]        prune worktrees whose branches are merged",
  "  wd explain [range]  this, in your terminal, on the same key",
  "  wd init zsh         the shell wrapper for switch",
  "source: github.com/chrispetrou/wd",
];

const FONTS = ["default", "fira", "jetbrains", "plex"];

// the completion menu: commands, their descriptions, and their options
interface CmdSpec {
  name: string;
  desc: string;
  args?: string[];
}

const COMMANDS: CmdSpec[] = [
  { name: "/help", desc: "all commands and keys" },
  { name: "/repos", desc: "switch repo" },
  { name: "/key", desc: "set the llm key", args: ["clear"] },
  {
    name: "/model",
    desc: "pick the model",
    args: [
      "default",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-5-mini",
      "gpt-5",
    ],
  },
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
  { name: "/export", desc: "save the transcript" },
  { name: "/wd", desc: "about the wd cli" },
  { name: "/stop", desc: "stop a running explain" },
  { name: "/clear", desc: "clear the screen" },
  { name: "/logout", desc: "sign out" },
];

interface Menu {
  stage: "cmd" | "arg";
  rows: string[];
  spec?: CmdSpec;
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
  const partial = input.slice(sp + 1).toLowerCase();
  const rows = spec.args.filter((a) => a.startsWith(partial));
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

function readKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}

function writeKey(v: string) {
  try {
    if (v) localStorage.setItem(KEY_STORE, v);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    // private windows may block storage; the key just won't persist
  }
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MODEL_SUGGESTIONS = [
  "anthropic: claude-opus-5 (default), claude-sonnet-5, claude-haiku-4-5",
  "openai: gpt-5-mini (default), gpt-5",
];

function providerInfo(): string {
  const key = readKey();
  if (!key) return "no key set";
  const provider = key.startsWith("sk-ant-") ? "anthropic" : "openai";
  const fallback = provider === "anthropic" ? "claude-opus-5" : "gpt-5-mini";
  const override = pref("wd_model");
  return `${provider} · ${override || fallback}${override ? " (custom)" : ""}`;
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
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(true); // corrected on mount
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const partialRef = useRef("");
  const initRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [search, setSearch] = useState<{ q: string; idx: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const lastCmdRef = useRef("");
  const streamModeRef = useRef<"text" | "diff">("text");
  const prompt = `${owner}/${repo} $`;

  const push = (rows: Line[]) => setLines((prev) => [...prev, ...rows]);
  const muted = (texts: string[]) =>
    push(texts.map((text) => ({ text, cls: "o" as Cls })));
  const echo = (text: string) =>
    push([{ prefix: prompt, text, cls: text.startsWith("/") ? "x" : "c" }]);

  const logStore = `wd_log:${owner}/${repo}`;

  useEffect(() => {
    if (initRef.current) return; // strict mode re-runs mount effects
    initRef.current = true;
    const present = readKey() !== "";
    setHasKey(present);
    // remember this repo for the picker's recent-first ordering
    try {
      const recent: string[] = JSON.parse(localStorage.getItem(RECENT_STORE) ?? "[]");
      const name = `${owner}/${repo}`;
      const next = [name, ...recent.filter((r) => r !== name)].slice(0, 5);
      localStorage.setItem(RECENT_STORE, JSON.stringify(next));
    } catch {
      // ignore
    }
    // restore this repo's log from the session, if any
    try {
      const stored = JSON.parse(sessionStorage.getItem(logStore) ?? "[]") as Line[];
      if (Array.isArray(stored) && stored.length) {
        setLines(stored);
        return;
      }
    } catch {
      // ignore
    }
    push([{ text: `▜ wd · ${owner}/${repo}`, cls: "o" }]);
    if (!present) {
      muted([
        "paste an anthropic or openai api key to enable explanations.",
        "it is stored only in this browser and sent per request.",
      ]);
    } else {
      muted([commandHint]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist the log so a refresh or repo switch does not wipe it
  useEffect(() => {
    try {
      if (lines.length) {
        sessionStorage.setItem(logStore, JSON.stringify(lines.slice(-LOG_LIMIT)));
      } else {
        sessionStorage.removeItem(logStore);
      }
    } catch {
      // ignore
    }
  }, [lines, logStore]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

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
    if (t === "summary" || t === "watch out") return { text, cls: "a" };
    if (t.startsWith("[wd:error] "))
      return { text: `error: ${t.slice(11)}`, cls: "o" };
    return { text, cls: "" };
  };

  const appendChunk = (chunk: string) => {
    partialRef.current += chunk;
    const parts = partialRef.current.split("\n");
    partialRef.current = parts.pop() ?? "";
    if (parts.length) push(parts.map(classify));
  };

  const flushPartial = () => {
    if (partialRef.current) {
      push([classify(partialRef.current)]);
      partialRef.current = "";
    }
  };

  const run = async (command: string, raw = false) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    streamModeRef.current = raw ? "diff" : "text";
    setBusy(true);
    setElapsed(0);
    const t0 = Date.now();
    const ticker = setInterval(() => setElapsed(Date.now() - t0), 100);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wd-provider-key": readKey(),
          "x-wd-model": pref("wd_model"),
        },
        body: JSON.stringify({ owner, repo, input: command, raw }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        muted([`error: ${body?.error ?? `request failed (${res.status})`}`]);
        if (res.status === 401 && body?.error?.includes("sign in")) {
          window.location.href = "/api/auth/reset";
        }
        return;
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
          const meta = JSON.parse(buf.slice(0, nl)) as {
            commits: number;
            files: number;
            additions: number;
            deletions: number;
            truncated: boolean;
            title: string | null;
            note: string | null;
          };
          buf = buf.slice(nl + 1);
          metaDone = true;
          const rows = [
            `reading ${meta.commits} ${meta.commits === 1 ? "commit" : "commits"} · ${meta.files} ${meta.files === 1 ? "file" : "files"} · +${meta.additions} −${meta.deletions}`,
          ];
          if (meta.title) rows.push(`pr: ${meta.title}`);
          if (meta.note) rows.push(meta.note);
          if (meta.truncated) rows.push("comparison truncated by github");
          muted(rows);
          if (meta.files === 0) muted(["no changes in range"]);
        }
        if (buf) {
          appendChunk(buf);
          buf = "";
        }
      }
      flushPartial();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        muted(["error: connection interrupted"]);
      }
    } finally {
      clearInterval(ticker);
      streamModeRef.current = "text";
      setBusy(false);
    }
  };

  const saveKey = (value: string, echoText: string) => {
    writeKey(value);
    setHasKey(true);
    push([
      { text: `${prompt} ${echoText}`, cls: "p" },
      { text: "→ key saved locally", cls: "g" },
    ]);
  };

  const slash = (raw: string) => {
    const [cmd, ...rest] = raw.slice(1).split(" ");
    const arg = rest.join(" ").trim();
    switch (cmd.toLowerCase()) {
      case "help":
        echo(raw);
        muted(HELP);
        break;
      case "repos":
        echo(raw);
        router.push("/repos");
        break;
      case "clear":
        setLines([]);
        try {
          sessionStorage.removeItem(logStore);
        } catch {
          // ignore
        }
        break;
      case "key":
        if (!arg) {
          echo(raw);
          muted([hasKey ? `key set (${providerInfo()})` : "no key set", "usage: /key <value> or /key clear"]);
        } else if (arg === "clear") {
          writeKey("");
          setHasKey(false);
          echo(raw);
          muted(["key removed from this browser."]);
        } else {
          saveKey(arg, "/key sk-***");
        }
        break;
      case "model": {
        echo(raw);
        const m = arg.trim();
        if (!m) {
          muted([`model: ${providerInfo()}`, "usage: /model <name> or /model default", ...MODEL_SUGGESTIONS]);
        } else if (m.toLowerCase() === "default") {
          setPref("wd_model", "");
          muted([`model reset to the provider default (${providerInfo()})`]);
        } else if (MODEL_RE.test(m)) {
          setPref("wd_model", m);
          muted([`model set to ${m}`, "it is sent per request, like the key."]);
        } else {
          muted(["that does not look like a model id."]);
        }
        break;
      }
      case "theme": {
        echo(raw);
        const t = arg.toLowerCase();
        if (t === "auto" || t === "light" || t === "dark") {
          applyTheme(t as Theme);
          muted([`theme set to ${t}`]);
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
      case "info":
        echo(raw);
        muted([
          `repo      ${owner}/${repo}`,
          `provider  ${providerInfo()}`,
          `theme     ${currentTheme()}`,
          `font      ${pref("wd_font") || "default"} · ${pref("wd_fontsize") || "13"}px · ligatures ${pref("wd_lig") === "off" ? "off" : "on"}`,
        ]);
        break;
      case "font":
        echo(raw);
        if (FONTS.includes(arg.toLowerCase())) {
          applyFont(arg.toLowerCase());
          muted([`font set to ${arg.toLowerCase()}`]);
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
          muted(["font size reset."]);
        } else if (n >= 11 && n <= 18) {
          applyFontSize(String(n));
          muted([`font size set to ${n}px`]);
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
          muted([`ligatures ${lig} (visible with fira or jetbrains)`]);
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
      case "export": {
        echo(raw);
        const text = lines
          .map((l) => (l.prefix ? `${l.prefix} ` : "") + l.text)
          .join("\n");
        const blob = new Blob([text + "\n"], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `wd-${owner}-${repo}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
        muted(["transcript saved."]);
        break;
      }
      case "wd":
        echo(raw);
        muted(WD_HELP);
        break;
      case "stop":
        echo(raw);
        if (busy) abortRef.current?.abort();
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

    if (raw.startsWith("/")) {
      if (!raw.startsWith("/key ")) historyRef.current.unshift(raw);
      slash(raw);
      return;
    }

    if (!hasKey) {
      // gated: whatever was typed is the key; never store or echo it
      saveKey(raw, "sk-***");
      muted([commandHint]);
      return;
    }

    historyRef.current.unshift(raw);
    echo(raw);
    if (!parseCommand(raw)) {
      if (/^wd\s/i.test(raw)) {
        muted(["the worktree commands (new, ls, switch, rm) live in the cli: /wd"]);
      }
      muted([commandHint]);
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

  // completion menu (fx-style dropdown for commands and their options)
  const [menuSel, setMenuSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menu = menuDismissed ? null : menuFor(input);

  const changeInput = (v: string) => {
    setInput(v);
    setMenuDismissed(false);
    // arg stage defaults to "what you typed" so custom values are never
    // hijacked by a listed suggestion; arrows opt into the list
    setMenuSel(menuFor(v)?.stage === "arg" ? -1 : 0);
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
    if (menu) {
      const minSel = menu.stage === "arg" ? -1 : 0;
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
      if (e.key === "Enter" && !(menu.stage === "arg" && menuSel < 0)) {
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
      abortRef.current?.abort();
    }
  };

  const focusInput = () => {
    // a real terminal focuses on click, but never steal a text selection
    if (!window.getSelection()?.toString()) inputRef.current?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onClick={focusInput}>
      <div ref={logRef} role="log" aria-live="polite" className="term-scroll">
        {lines.map((l, i) => (
          <div key={i}>
            {l.prefix ? (
              <span className="text-muted-foreground">{l.prefix} </span>
            ) : null}
            <span className={CLS[l.cls]}>{renderText(l.text)}</span>
          </div>
        ))}
        {busy ? (
          <div>
            <span className="cursor" />
            <span className="text-wd-faint"> {(elapsed / 1000).toFixed(1)}s</span>
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-2 pt-2">
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
          <div className="max-h-56 overflow-y-auto">
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
                  className={`flex w-full cursor-pointer items-baseline gap-4 rounded-[3px] px-1.5 py-0.5 text-left ${
                    sel ? "row-sel" : ""
                  }`}
                >
                  <span className={sel ? "font-semibold" : "text-wd-accent"}>
                    {row}
                  </span>
                  {spec ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {spec.desc}
                    </span>
                  ) : menu.stage === "arg" && row === "default" ? (
                    <span className="text-wd-faint">provider default</span>
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
    </div>
  );
}
