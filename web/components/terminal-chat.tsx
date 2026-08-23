"use client";

import { useEffect, useRef, useState } from "react";
import { commandHint, parseCommand } from "@/lib/commands";

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

export function TerminalChat({ owner, repo }: { owner: string; repo: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(true); // corrected on mount
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const partialRef = useRef("");
  const initRef = useRef(false);
  const prompt = `${owner}/${repo} $`;

  const push = (rows: Line[]) => setLines((prev) => [...prev, ...rows]);
  const muted = (texts: string[]) => push(texts.map((text) => ({ text, cls: "o" as Cls })));

  useEffect(() => {
    if (initRef.current) return; // strict mode re-runs mount effects
    initRef.current = true;
    const present = readKey() !== "";
    setHasKey(present);
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

  // track the visual viewport so the input stays above soft keyboards
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);

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

  const submit = () => {
    const raw = input.trim();
    if (!raw) return;
    setInput("");

    if (raw === "key clear") {
      writeKey("");
      setHasKey(false);
      push([{ text: `${prompt} key clear`, cls: "p" }]);
      muted(["key removed from this browser."]);
      return;
    }
    if (raw.startsWith("key ")) {
      writeKey(raw.slice(4).trim());
      setHasKey(true);
      push([
        { text: `${prompt} key sk-***`, cls: "p" },
        { text: "→ key saved locally", cls: "g" },
      ]);
      return;
    }
    if (!hasKey) {
      writeKey(raw);
      setHasKey(true);
      push([
        { text: `${prompt} sk-***`, cls: "p" },
        { text: "→ key saved locally", cls: "g" },
      ]);
      muted([commandHint]);
      return;
    }

    push([{ text: `${prompt} ${raw}`, cls: "p" }]);
    if (!parseCommand(raw)) {
      muted([commandHint]);
      return;
    }
    void run(raw);
  };

  return (
    <div className="term-fill">
      <div ref={logRef} className="term-scroll">
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
          className="term-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          aria-label="command input"
        />
      </div>
    </div>
  );
}
