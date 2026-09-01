"use client";

// the repo terminal: a transcript of lines and blocks, one prompt, and
// the keys that drive it (history, ctrl+r search, the arrow keys over a
// live block, the completion menu). what a command does lives in the
// hooks and modules beside this file; what it prints lives in the store.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { PlanAction, PlanRow } from "@/lib/block";
import { chatStore, type ChatLine } from "@/lib/chat-store";
import { commandHint, parseCommand } from "@/lib/commands";
import { move, setAction } from "@/lib/plan";
import { signInAgain, takeResume } from "@/lib/signin";
import { keyStore } from "@/lib/key-store";
import { createEmit } from "@/lib/terminal/emit";
import { activeEffort, effortIgnored, providerInfo, seconds, usageInfo } from "@/lib/terminal/info";
import { COMMANDS, type Menu } from "@/lib/terminal/menu";
import { rememberRecent } from "@/lib/terminal/prefs";
import { resolveRows } from "@/lib/terminal/resolve";
import { FileBlock } from "./file-block";
import { LogBlock } from "./log-block";
import { PlanBlock } from "./plan-block";
import { StatBlock } from "./stat-block";
import { DragLayer, type Drop } from "./drag-layer";
import { ModelGlyph } from "./glyph";
import { LineText } from "./terminal-line";
import { CompletionMenu } from "./terminal-menu";
import { runSlash } from "./terminal-slash";
import { useCompletion } from "./use-completion";
import { useStream } from "./use-stream";

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
    () => chatStore.lines(storeKey),
    () => chatStore.emptyLines()
  );
  const busy = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.streaming(storeKey),
    () => false
  );
  const [input, setInput] = useState("");
  const [hasKey, setHasKey] = useState(true); // corrected on mount
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const initRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [search, setSearch] = useState<{ q: string; idx: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const lastCmdRef = useRef("");
  const prompt = `${owner}/${repo} $`;

  // lines that mark a state change (not streamed text, not the echo)
  // enter with a short fade; restored lines never animate
  const freshRef = useRef(new WeakSet<ChatLine>());
  const emit = createEmit({ storeKey, prompt, fresh: freshRef.current });
  const { push, muted, echo, ok } = emit;

  const { menu, menuSel, setMenuSel, changeInput, dismiss, branchList, logRows, prRows, menuKey } =
    useCompletion({ storeKey, owner, repo, input, setInput });
  const { run, runFollowup, addToPlan } = useStream({ storeKey, owner, repo, emit });

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

  const slash = (raw: string) =>
    runSlash(
      {
        owner,
        repo,
        login,
        storeKey,
        lines,
        busy,
        lastCmd: () => lastCmdRef.current,
        emit,
        router,
        setHasKey,
        saveKey,
        run,
        changeInput,
        focusInput: () => inputRef.current?.focus(),
      },
      raw
    );

  const submit = (given?: string) => {
    const raw = (given ?? input).trim();
    if (!raw) return;
    setInput("");
    setHistPos(-1);
    pinnedRef.current = true;
    chatStore.setLive(storeKey, undefined); // a new command takes the keys back

    if (raw.startsWith("/")) {
      if (!/^\/key\s/i.test(raw)) historyRef.current.unshift(raw);
      slash(raw);
      return;
    }

    if (!hasKey) {
      // gated: what was typed is the key; never store or echo it. a
      // command typed here instead is told what the gate wants
      if (/\s/.test(raw) || raw.length < 20) {
        muted(["paste an api key to start: anthropic (sk-ant-), groq (gsk_), or openai"]);
        return;
      }
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
    const rows = resolveRows(cmd, chatStore.logRows(storeKey), chatStore.logSpans(storeKey));
    if (rows) {
      muted(rows.notes);
      if (!rows.command) return;
      lastCmdRef.current = rows.command;
      void run(rows.command);
      return;
    }
    lastCmdRef.current = raw;
    void run(raw);
  };

  // a row dropped on a branch line is a cherry-pick plan onto it; dropped
  // into a plan it joins the rows where it landed (a fetch for its files
  // and clashes first)
  const onDrop = ({ target, payload, row }: Drop) => {
    const colon = target.indexOf(":");
    const kind = target.slice(0, colon);
    const rest = target.slice(colon + 1);
    if (kind === "branch") {
      submit(payload.kind === "pr" ? `pick pr #${payload.id} onto ${rest}` : `pick ${payload.id} onto ${rest}`);
      return;
    }
    if (kind !== "plan") return;
    const line = Number(rest);
    const block = chatStore.lines(storeKey)[line]?.block;
    if (!block || block.kind !== "plan") return;
    if (payload.kind === "pr") {
      muted(["a pr goes onto a branch: drop it on one, or pick pr #N onto <branch>"]);
      return;
    }
    if (block.rows.some((r) => r.sha === payload.id)) {
      muted([`${payload.id.slice(0, 7)} is already in the plan`]);
      return;
    }
    void addToPlan(line, block.base.sha, payload.id, block.onto ?? block.base.sha, row ?? block.rows.length);
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

  useEffect(() => {
    if (initRef.current) return; // strict mode re-runs mount effects
    initRef.current = true;
    const present = keyStore.providers().length > 0;
    setHasKey(present);
    // remember this repo for the picker's recent-first ordering
    rememberRecent(storeKey);
    // back from a sign-in that a dead session forced: say so under the
    // error, drop the button, and pick up where it stopped
    const resume = takeResume(storeKey);
    if (resume) {
      chatStore.setAll(
        storeKey,
        chatStore.lines(storeKey).filter((l) => l.action !== "signin")
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
  // blocks also grow without a new line (a file's text or a panel's
  // detail landing after its skeleton); while pinned, any growth keeps
  // the bottom pinned, so content above only ever shifts, never hides
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  // ctrl+r reverse history search
  const searchMatch = (q: string, from: number): number => {
    const h = historyRef.current;
    for (let i = from; i < h.length; i++) {
      if (h[i].includes(q)) return i;
    }
    return -1;
  };

  // a recalled command goes through the menu state (so a stale selection
  // cannot pick a row) but opens no menu of its own
  const recall = (v: string) => {
    changeInput(v);
    dismiss();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (search) {
      e.preventDefault();
      if (e.key === "Escape") {
        setSearch(null);
      } else if (e.key === "Enter") {
        const i = searchMatch(search.q, search.idx);
        if (i >= 0) recall(historyRef.current[i]);
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
    // a live file block has no rows: the arrows scroll it in place. the
    // position is ephemeral dom state, never written to the store; keys
    // not handled here fall through to history and submit
    if (live && liveBlock?.kind === "file" && input === "" && !menu) {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) {
        e.preventDefault();
        const el = document.querySelector<HTMLElement>(`[data-file-line="${live.line}"]`);
        if (el) {
          // the step follows /fontsize, so never a hard-coded pixel count
          const lineH = parseFloat(getComputedStyle(el).lineHeight) || 22;
          const step = e.key.startsWith("Page") ? el.clientHeight : lineH;
          el.scrollTop += e.key.endsWith("Down") ? step : -step;
        }
        return;
      }
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        chatStore.setLive(storeKey, undefined);
        return;
      }
    }
    // a stat block is never live (nothing to walk), so its guard is for
    // the type only; the file check narrows past the branch above
    else if (
      live &&
      liveBlock &&
      liveBlock.kind !== "stat" &&
      liveBlock.kind !== "file" &&
      input === "" &&
      !menu
    ) {
      const n = liveBlock.rows.length;
      const idAt = (i: number) => {
        const r = liveBlock.rows[i];
        return "num" in r ? String(r.num) : r.sha;
      };
      // a plan row under the cursor takes its action from a letter and
      // moves with shift+arrows; with no row selected the letters type
      if (liveBlock.kind === "plan" && live.selected !== null && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const i = live.selected;
        const rows = liveBlock.rows;
        const set = (next: PlanRow[]) =>
          chatStore.setBlock(storeKey, live.line, { ...liveBlock, rows: next });
        if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          const to = e.key === "ArrowUp" ? i - 1 : i + 1;
          if (to >= 0 && to < n) {
            set(move(rows, i, to));
            chatStore.setLive(storeKey, { ...live, selected: to });
          }
          return;
        }
        const keys: Record<string, PlanAction> =
          liveBlock.mode === "pick"
            ? { p: "pick", d: "drop" }
            : { p: "pick", r: "reword", s: "squash", f: "fixup", d: "drop", e: "edit" };
        const action = keys[e.key];
        if (action && !e.shiftKey) {
          e.preventDefault();
          set(setAction(rows, i, action));
          return;
        }
      }
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
    if (menuKey(e, applyMenuRow)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp") {
      const h = historyRef.current;
      if (h.length === 0) return;
      e.preventDefault();
      const next = Math.min(histPos + 1, h.length - 1);
      setHistPos(next);
      recall(h[next]);
    } else if (e.key === "ArrowDown") {
      if (histPos < 0) return;
      e.preventDefault();
      const next = histPos - 1;
      setHistPos(next);
      recall(next < 0 ? "" : historyRef.current[next]);
    } else if (e.key === "Escape") {
      chatStore.abort(storeKey);
    }
  };

  const focusInput = (e: React.MouseEvent) => {
    // a real terminal focuses on click, but never steal a text selection
    // or a message being edited in a plan row
    if ((e.target as HTMLElement).closest?.("textarea")) return;
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
        <div ref={contentRef}>
          {lines.map((l, i) => (
            // a prompt line opens a block: command and its output read as one
            <div
              key={l.id ?? i}
              className={`${l.prefix && i > 0 ? "mt-3" : ""} ${
                !l.block && freshRef.current.has(l) ? "line-in" : ""
              }`}
              data-drop={l.drop}
            >
              {l.prefix ? (
                <span className="text-muted-foreground">{l.prefix} </span>
              ) : null}
              {l.block ? (
                l.block.kind === "plan" ? (
                  <PlanBlock
                    block={l.block}
                    line={i}
                    storeKey={storeKey}
                    submit={(c) => submit(c)}
                    fresh={freshRef.current.has(l)}
                  />
                ) : l.block.kind === "stat" ? (
                  <StatBlock block={l.block} fresh={freshRef.current.has(l)} />
                ) : l.block.kind === "file" ? (
                  <FileBlock
                    block={l.block}
                    line={i}
                    storeKey={storeKey}
                    owner={owner}
                    repo={repo}
                    prefill={(v) => {
                      recall(v);
                      inputRef.current?.focus();
                    }}
                    fresh={freshRef.current.has(l)}
                  />
                ) : (
                  <LogBlock
                    block={l.block}
                    line={i}
                    storeKey={storeKey}
                    owner={owner}
                    repo={repo}
                    submit={(c) => submit(c)}
                    fresh={freshRef.current.has(l)}
                  />
                )
              ) : l.action === "signin" ? (
                <button type="button" className="log-action" onClick={reauth}>
                  sign in again <span className="text-wd-green">→</span>
                </button>
              ) : (
                <LineText line={l} />
              )}
            </div>
          ))}
          <DragLayer onDrop={onDrop} />
          {busy ? (
            <div>
              <span className="cursor" />
              <span className="text-muted-foreground"> {seconds(elapsed)}</span>
            </div>
          ) : null}
        </div>
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
        <CompletionMenu
          menu={menu}
          sel={menuSel}
          onSel={setMenuSel}
          onPick={(row) => applyMenuRow(menu, row)}
          branchList={branchList}
          logRows={logRows}
          prRows={prRows}
        />
      ) : null}
      <div
        className="pt-1.5 text-muted-foreground"
        data-tip="the model runs on your key; /model changes it. tokens are counted here since the key was saved; /usage for the breakdown"
      >
        {/* localStorage reads must wait for mount or hydration breaks */}
        {mounted && keyStore.active() ? <ModelGlyph /> : null}
        {mounted ? providerInfo() : " "}
        {mounted && activeEffort() && !effortIgnored() ? ` · effort ${activeEffort()}` : ""}
        {mounted ? usageInfo() : ""}
      </div>
    </div>
  );
}
