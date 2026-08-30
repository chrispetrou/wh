"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlanRow } from "@/lib/block";
import { chatStore } from "@/lib/chat-store";
import { setAction, setText, type PlanBlock as Plan } from "@/lib/plan";
import { PlanBlock } from "@/components/plan-block";

const KEY = "preview/wd";
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

// six commits on feat/plan, newest first; main moved README.md and
// web/lib/commands.ts under them
const history: Array<[string, string, number, string[], string[]]> = [
  ["f1a2b3c", "fix typo in the hint", 0.2, ["web/lib/commands.ts"], []],
  ["e005fd9", "plan block: drag to reorder", 0.5, ["web/components/plan-block.tsx", "web/app/globals.css"], []],
  ["c5ad6f2", "wip", 0.8, ["web/components/plan-block.tsx"], []],
  ["6ea2154", "rebase and pick grammar", 1, ["web/lib/commands.ts", "web/lib/commands.test.ts"], ["web/lib/commands.ts"]],
  ["d279b71", "README: the compose section", 1.2, ["README.md"], ["README.md"]],
  ["ec23652", "plan.ts: the paste block and its tests", 2, ["web/lib/plan.ts", "web/lib/plan.test.ts"], []],
];

function build(): Plan {
  let rows: PlanRow[] = history.map(([sha, subject, h, files, clash], idx) => ({
    sha: sha + "0".repeat(33),
    parents: [],
    subject,
    author: "chrispetrou",
    date: ago(h),
    refs: idx === 0 ? [{ name: "feat/plan", kind: "branch" }] : [],
    idx,
    message: `${subject}\n\nthe body of ${sha}`,
    files,
    clash,
    action: "pick",
  }));
  rows = setAction(rows, 0, "fixup");
  rows = setText(rows, 1, "plan block: drag to reorder\n\nrows ride the pointer; siblings step aside");
  rows = setAction(rows, 2, "drop");
  return {
    kind: "plan",
    mode: "rebase",
    base: { sha: "a942270" + "0".repeat(33), ref: "main" },
    head: "feat/plan",
    rows,
    footer: ["6 commits, feat/plan onto main"],
  };
}

export function PreviewPlan({ dark, open }: { dark: boolean; open: boolean }) {
  const block = build();
  // the ages are relative to now, so the block is drawn on the client only
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
    chatStore.setAll(KEY, [{ text: "", cls: "", block }]);
    if (open) {
      chatStore.setExpanded(KEY, 0, [block.rows[1].sha]);
      chatStore.setLive(KEY, { line: 0, selected: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, open]);
  const lines = useSyncExternalStore(
    (cb) => chatStore.subscribe(KEY, cb),
    () => chatStore.lines(KEY),
    () => chatStore.emptyLines()
  );
  const live = lines[0]?.block;
  const shown = live && live.kind === "plan" ? live : block;
  if (!ready) return null;
  return (
    <div className="app-main p-4">
      <div className="text-muted-foreground">
        chrispetrou/wd $ <span className="font-semibold text-foreground">rebase feat/plan</span>
      </div>
      <PlanBlock block={shown} line={0} storeKey={KEY} submit={(c) => console.log("submit", c)} />
    </div>
  );
}
