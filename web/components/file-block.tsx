"use client";

// a file read in place: numbered lines in a box capped at ~24 rows that
// scrolls inside (wheel, or the arrows while the block is live). the
// block itself is only an address; the text is fetched lazily into the
// unpersisted details map, and highlight.js is imported on demand for
// known extensions only. clicking a line number prefills why <path>:<n>.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Block } from "@/lib/block";
import { Action, Skel } from "./block-bits";
import {
  chatStore,
  type Detail,
  type DetailFailure,
  type FileDetail,
} from "@/lib/chat-store";
import { highlightLines, langFor } from "@/lib/highlight";
import { signInAgain } from "@/lib/signin";

type FileBlockShape = Extract<Block, { kind: "file" }>;

function humanSize(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}b`;
}

export function FileBlock({
  block,
  line,
  storeKey,
  prefill,
  owner,
  repo,
  fresh = false,
}: {
  block: FileBlockShape;
  line: number;
  storeKey: string;
  prefill: (v: string) => void;
  owner: string;
  repo: string;
  fresh?: boolean;
}) {
  const key = `file:${block.ref}:${block.path}`;
  const live = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.live(storeKey),
    () => undefined
  );
  const details = useSyncExternalStore(
    (cb) => chatStore.subscribe(storeKey, cb),
    () => chatStore.details(storeKey),
    () => undefined
  );
  const detail = details?.get(key);
  const file = detail && typeof detail === "object" && "kind" in detail ? (detail as FileDetail) : null;

  // fetch the text once per address; on session restore this refetches
  // (the details map is never persisted)
  useEffect(() => {
    if (chatStore.detail(storeKey, key)) return;
    chatStore.setDetail(storeKey, key, "loading");
    fetch(
      `/api/detail?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&kind=file&id=${encodeURIComponent(block.path)}&ref=${encodeURIComponent(block.ref)}`
    )
      .then(async (r) => {
        if (r.ok) return (await r.json()) as Detail;
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        throw { failed: j?.error ?? `request failed (${r.status})`, auth: r.status === 401 };
      })
      .then((d) => chatStore.setDetail(storeKey, key, d))
      .catch((e: unknown) =>
        chatStore.setDetail(
          storeKey,
          key,
          typeof e === "object" && e && "failed" in e
            ? (e as DetailFailure)
            : { failed: "connection interrupted", auth: false }
        )
      );
  }, [storeKey, key, owner, repo, block.path, block.ref]);

  // highlight once per loaded text, importing hljs only when the
  // extension is known; plain text otherwise, and on any hljs failure.
  // no ref guard here: a guard that survives the cleanup skips the
  // re-run react does in dev, and the block came back plain after a
  // tab switch (the text is already in the store when this remounts)
  const [html, setHtml] = useState<string[] | null>(null);
  useEffect(() => {
    if (!file) return;
    const lang = langFor(block.path);
    if (!lang) return;
    let dead = false;
    void import("highlight.js/lib/common").then((m) => {
      if (dead) return;
      setHtml(highlightLines(file.lines.join("\n"), lang, m.default));
    });
    return () => {
      dead = true;
    };
  }, [file, block.path]);

  // land on the marked line, centered, once the text is there
  const scrollRef = useRef<HTMLDivElement>(null);
  // the last clicked line number, so shift+click makes a span
  const anchorRef = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!file || !block.mark || !el) return;
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.scrollTop = (block.mark - 1) * lineH - el.clientHeight / 2;
  }, [file, block.mark]);

  const mine = live?.line === line;

  if (!detail || detail === "loading") {
    return (
      <div className={`file-block ${fresh ? "block-in" : ""}`}>
        <div>
          <Skel w={46} />
        </div>
        <div>
          <Skel w={38} />
        </div>
        <div>
          <Skel w={42} />
        </div>
      </div>
    );
  }
  if ("failed" in detail) {
    return (
      <div className={`file-block ${fresh ? "block-in" : ""}`}>
        <div>
          <span className="text-wd-amber">error:</span>{" "}
          {detail.auth ? "your github session ended" : detail.failed}
        </div>
        {detail.auth ? (
          <Action onClick={() => signInAgain(storeKey, {})}>
            sign in again <span className="text-wd-green">→</span>
          </Action>
        ) : null}
      </div>
    );
  }

  const f = detail as FileDetail;
  const numW = `${String(f.lines.length).length + 2}ch`;
  const askWhy = (e: React.MouseEvent, n: number) => {
    // shift+click spans from the last clicked line; why is prefilled,
    // never sent, since it costs a model call
    const a = anchorRef.current;
    if (e.shiftKey && a !== null && a !== n) {
      prefill(`why ${block.path}:${Math.min(a, n)}-${Math.max(a, n)} on ${block.ref}`);
      return;
    }
    anchorRef.current = n;
    prefill(`why ${block.path}:${n} on ${block.ref}`);
  };
  return (
    <div className={`file-block ${fresh ? "block-in" : ""}`}>
      <div
        ref={scrollRef}
        className="file-scroll"
        data-file-line={line}
        style={{ "--file-numw": numW } as React.CSSProperties}
      >
        {f.lines.map((text, i) => (
          <div key={i} className={`file-line ${i + 1 === block.mark ? "file-mark" : ""}`}>
            <button
              type="button"
              className="file-num"
              data-tip="why this line · shift+click spans"
              onClick={(e) => askWhy(e, i + 1)}
            >
              {i + 1}
            </button>
            {html?.[i] !== undefined ? (
              // safe: only ever highlight.js output, which escapes the text
              <span className="file-code" dangerouslySetInnerHTML={{ __html: html[i] }} />
            ) : (
              <span className="file-code">{text}</span>
            )}
          </div>
        ))}
      </div>
      <div className="text-muted-foreground">
        {f.lines.length} lines · {humanSize(f.size)} · {f.path} on {f.ref}
      </div>
      {f.truncated ? (
        <div className="text-wd-amber">truncated: the first {f.lines.length} lines only</div>
      ) : null}
      {mine ? <div className="text-wd-faint">↑↓ scroll · esc back</div> : null}
    </div>
  );
}
