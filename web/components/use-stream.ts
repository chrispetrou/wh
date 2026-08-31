// the streaming pipeline of the terminal: one fetch loop for commands,
// /show, and follow-up turns, the meta line that opens every answer,
// the cost line that closes a model answer, and the two ways an answer
// lands somewhere other than the transcript (a drafted message into a
// plan row, a dropped row into a plan).

import { useRef } from "react";
import type { Block, PlanRow } from "@/lib/block";
import { chatStore, type LogRow, type PrPick } from "@/lib/chat-store";
import { parseCommand } from "@/lib/commands";
import { parseMeta, type ExplainMeta } from "@/lib/explain/meta";
import { lowLine, usageParts } from "@/lib/explain/usage";
import { keyStore } from "@/lib/key-store";
import { insertRow, messageText, parseMessage, setText, type PlanBlock as Plan } from "@/lib/plan";
import type { Emit } from "@/lib/terminal/emit";
import { activeEffort, activeModel, modelName, seconds } from "@/lib/terminal/info";
import { createAssembler, type Assembler } from "@/lib/terminal/lines";
import { prefs } from "@/lib/terminal/prefs";

export function useStream({
  storeKey,
  owner,
  repo,
  emit,
}: {
  storeKey: string;
  owner: string;
  repo: string;
  emit: Emit;
}) {
  const { push, enter, muted, err, ok } = emit;
  // the assembler outlives renders: a stream keeps feeding it while the
  // component re-renders on every pushed line
  const asmRef = useRef<Assembler | null>(null);
  if (!asmRef.current) asmRef.current = createAssembler();
  const asm = asmRef.current;

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
    asm.reset(opts.raw ? "diff" : "text");
    chatStore.setStreaming(storeKey, true, abort);
    const t0 = Date.now();
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
          const meta = parseMeta(buf.slice(0, nl));
          if (!meta) {
            // a proxy handed us a 200 that is not ours: stop reading
            await reader.cancel().catch(() => undefined);
            err("unexpected response from server");
            return null;
          }
          opts.onMeta?.(meta);
          buf = buf.slice(nl + 1);
          metaDone = true;
        }
        if (buf) {
          const rows = asm.feed(buf);
          if (rows.length) push(rows);
          buf = "";
        }
      }
      const rest = asm.flush();
      if (rest) push([rest]);
      done = true;
      if (opts.metrics) {
        // count first, then push: the pushed line is what re-renders the
        // footer, which reads the count
        const u = asm.takeUsage();
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
        asm.mode = "text";
        chatStore.setStreaming(storeKey, false);
      }
    }
    return done ? asm.answer() : null;
  };

  // the drafted message lands in the plan row that asked for it. the
  // block is looked up by line and checked by its base sha, since lines
  // shift as the transcript grows
  const applyDraft = (full: string | null) => {
    const d = chatStore.draft(storeKey);
    chatStore.setDraft(storeKey, undefined);
    if (!d || !full?.trim()) return;
    const all = chatStore.lines(storeKey);
    const isIt = (l: { block?: Block } | undefined) =>
      l?.block?.kind === "plan" && l.block.base.sha === d.base;
    const line = isIt(all[d.line]) ? d.line : all.findIndex(isIt);
    const block = line >= 0 ? (all[line].block as Plan) : null;
    const i = block ? block.rows.findIndex((r) => r.sha === d.sha) : -1;
    if (!block || i < 0) {
      muted(["the plan is no longer on screen; the message is above, /copy takes it"]);
      return;
    }
    const text = messageText(parseMessage(full));
    if (!text) return;
    chatStore.setBlock(storeKey, line, { ...block, rows: setText(block.rows, i, text) });
    ok("message set", `on row ${i + 1}`);
  };

  const run = async (command: string, raw = false) => {
    const kind = parseCommand(command)?.kind;
    const lookup = ["branches", "log", "tags", "prs", "history", "plan", "pick"].includes(kind ?? "");
    // a message drafted for a plan row is a side quest: it neither starts
    // nor ends a conversation
    const draft = kind === "message";
    // a new diff command starts a new context; lookups leave it alone
    if (!raw && !lookup && !draft) chatStore.clearContext(storeKey);
    let context = "";
    let empty = false;
    const full = await stream(
      { owner, repo, input: command, raw },
      {
        raw,
        metrics: !raw && !lookup,
        onMeta: (meta) => {
          if (meta.branches) {
            asm.mode = "branches";
            return;
          }
          if (meta.tags) {
            asm.mode = "tags";
            return;
          }
          if (meta.block) {
            // the grid goes in as one line; the arrow keys drive it until
            // the next command
            enter([{ text: "", cls: "", block: meta.block }]);
            if (meta.block.kind === "prs") {
              chatStore.setPrRows(storeKey, (meta.rows as PrPick[] | undefined) ?? []);
            } else if (meta.block.kind === "log") {
              chatStore.setLogRows(
                storeKey,
                (meta.rows as LogRow[] | undefined) ?? [],
                meta.spans !== false
              );
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
    if (draft) {
      applyDraft(full);
      return;
    }
    if (empty) return;
    if (!raw && context && full?.trim()) {
      chatStore.setContext(storeKey, context, full.trim());
      if (!prefs.get("wd_fu_hint")) {
        prefs.set("wd_fu_hint", "seen");
        muted(["(ask follow-ups in plain words, or run another command)"]);
      }
    }
  };

  // a row dropped into a plan joins the rows where it landed, after a
  // fetch for its files and clashes against the target
  const addToPlan = async (line: number, base: string, sha: string, onto: string, at: number) => {
    const res = await fetch(
      `/api/detail?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&kind=planrow&id=${encodeURIComponent(sha)}&onto=${encodeURIComponent(onto)}`
    );
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      err(j?.error ?? `request failed (${res.status})`);
      return;
    }
    const row = (await res.json()) as PlanRow;
    // the plan may have moved while the fetch ran: found by its base sha
    const all = chatStore.lines(storeKey);
    const isIt = (l: { block?: Block } | undefined) =>
      l?.block?.kind === "plan" && l.block.base.sha === base;
    const where = isIt(all[line]) ? line : all.findIndex(isIt);
    if (where < 0) {
      muted(["the plan is no longer on screen"]);
      return;
    }
    const block = all[where].block as Plan;
    const rows = insertRow(block.rows, row, at);
    if (rows === block.rows) return;
    chatStore.setBlock(storeKey, where, { ...block, rows });
    ok("added", `${sha.slice(0, 7)} to the plan as row ${Math.min(at, block.rows.length) + 1}`);
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

  return { stream, run, runFollowup, applyDraft, addToPlan };
}
