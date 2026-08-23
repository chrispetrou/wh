"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { commandHint, parseCommand } from "@/lib/commands";
import { applyTheme, currentTheme, type Theme } from "./theme-toggle";

type Cls = "p" | "c" | "o" | "g" | "a" | "";

interface Line {
  text: string;
  cls: Cls;
}

const CLS: Record<Cls, string> = {
  p: "text-muted-foreground",
  c: "font-semibold",
  o: "text-muted-foreground",
  g: "text-wd-green",
  a: "text-wd-amber",
  "": "",
};

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
  "  /theme <t>        auto, light, or dark",
  "  /account          who is signed in",
  "  /info             repo, provider, theme",
  "  /stop             stop a running explain (esc works too)",
  "  /clear            clear the screen",
  "  /logout           sign out",
];

const SLASH_CMDS = [
  "/help",
  "/repos",
  "/key",
  "/theme",
  "/account",
  "/info",
  "/stop",
  "/clear",
  "/logout",
];

function commonPrefix(items: string[]): string {
  let p = items[0] ?? "";
  for (const s of items) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
  }
  return p;
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

function providerInfo(): string {
  const key = readKey();
  if (!key) return "no key set";
  return key.startsWith("sk-ant-")
    ? "anthropic · claude-opus-5"
    : "openai · gpt-5-mini";
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
  const prompt = `${owner}/${repo} $`;

  const push = (rows: Line[]) => setLines((prev) => [...prev, ...rows]);
  const muted = (texts: string[]) =>
    push(texts.map((text) => ({ text, cls: "o" as Cls })));
  const echo = (text: string) => push([{ text: `${prompt} ${text}`, cls: "p" }]);

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

  const classify = (text: string): Line => {
    const t = text.trimEnd();
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

  const run = async (command: string) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wd-provider-key": readKey(),
        },
        body: JSON.stringify({ owner, repo, input: command }),
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
    switch (cmd) {
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
      case "theme": {
        echo(raw);
        if (arg === "auto" || arg === "light" || arg === "dark") {
          applyTheme(arg as Theme);
          muted([`theme set to ${arg}`]);
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
        ]);
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

  const submit = () => {
    const raw = input.trim();
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
      muted([commandHint]);
      return;
    }
    void run(raw);
  };

  // slash autocomplete: matches while typing a bare /command
  const slashMatches =
    input.startsWith("/") && !input.includes(" ")
      ? SLASH_CMDS.filter((c) => c.startsWith(input))
      : [];
  const showMatches =
    slashMatches.length > 0 && !(slashMatches.length === 1 && slashMatches[0] === input);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab" && slashMatches.length > 0) {
      e.preventDefault();
      const target =
        slashMatches.length === 1 ? slashMatches[0] : commonPrefix(slashMatches);
      if (target.length > input.length) setInput(target);
      return;
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
          <div key={i} className={CLS[l.cls]}>
            {l.text}
          </div>
        ))}
        {busy ? <span className="cursor" /> : null}
      </div>
      <div className="flex items-baseline gap-2 pt-2">
        <span className="shrink-0 text-muted-foreground">{prompt}</span>
        <input
          ref={inputRef}
          className="term-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          aria-label="command input"
        />
      </div>
      {showMatches ? (
        <div className="pt-1 text-wd-faint">{slashMatches.join("  ")}</div>
      ) : null}
    </div>
  );
}
