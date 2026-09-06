"use client";

import { useEffect, useState } from "react";
import { chatStore } from "@/lib/chat-store";
import { FileBlock } from "@/components/file-block";
import type { Theme } from "@/lib/terminal/prefs";
import { applyPreviewTheme } from "../theme";

const KEY = "preview/wh";
const PATH = "web/lib/graph.ts";
const REF = "main";

// a small typescript source exercising comments, strings, keywords, a
// template string spanning lines, and numbers
const SOURCE = `// the pure lane-layout engine behind the log graph: rows in, lanes and
// curved segments out. no react, no colors, just geometry.

export interface Seg {
  from: number;
  to: number;
  color: number;
}

const LANE_W = 14;

/* a multi-line comment, so the span-repair path
   has something to prove: it must reopen this
   color on every line it crosses */
export function laneCount(rows: Array<{ lane: number }>): number {
  return rows.reduce((n, r) => Math.max(n, r.lane + 1), 0);
}

export function label(name: string, lanes: number): string {
  return \`\${name} spans \${lanes} \${lanes === 1 ? "lane" : "lanes"}
  across \${lanes * LANE_W}px of rail\`;
}

export function ascii(rows: string[]): string {
  // quiet fallback: the same rows as git log --graph text
  return rows.join("\\n");
}
`;

export function PreviewView({
  theme,
  loading,
  mark,
}: {
  theme: Theme;
  loading: boolean;
  mark?: number;
}) {
  // seed the store during the first render, before the block's fetch
  // effect looks for the detail; "loading" pins the skeleton state
  useState(() => {
    if (loading) {
      chatStore.setDetail(KEY, `file:${REF}:${PATH}`, "loading");
      return true;
    }
    const lines = SOURCE.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    chatStore.setDetail(KEY, `file:${REF}:${PATH}`, {
      kind: "file",
      path: PATH,
      ref: REF,
      lines,
      size: SOURCE.length,
      truncated: false,
    });
    return true;
  });
  useEffect(() => {
    applyPreviewTheme(theme);
  }, [theme]);
  return (
    <div className="app-main p-4">
      <div className="text-muted-foreground">
        chrispetrou/wh ${" "}
        <span className="font-semibold text-foreground">
          view {PATH}
          {mark ? `:${mark}` : ""}
        </span>
      </div>
      <FileBlock
        block={{ kind: "file", path: PATH, ref: REF, ...(mark ? { mark } : {}) }}
        line={0}
        storeKey={KEY}
        owner="chrispetrou"
        repo="wh"
        prefill={() => {}}
      />
    </div>
  );
}
