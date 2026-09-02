"use client";

import { useEffect } from "react";
import type { Block } from "@/lib/block";
import { StatBlock } from "@/components/stat-block";

type Stat = Extract<Block, { kind: "stat" }>;

// a year of weekly commits: a long quiet stretch, then a launch push
// (the sparse shape a young repo shows)
const weeks = Array.from({ length: 52 }, (_, i) => {
  if (i > 44) return 12 + ((i * 7) % 9);
  if (i > 38) return (i * 5) % 7;
  return i % 13 === 0 ? 1 : 0;
});

const activity: Stat = {
  kind: "stat",
  spark: { values: weeks, label: "commits per week, last 52 weeks" },
  footer: ["214 commits in the last 52 weeks · 3 contributors"],
  rows: [
    { label: "chrispetrou", value: "182 commits", share: 0.85, group: "authors" },
    { label: "alice", value: "24 commits", share: 0.11, group: "authors" },
    { label: "bot", value: "8 commits", share: 0.04, group: "authors" },
    { label: "rust", value: "61%", share: 0.61, group: "languages" },
    { label: "typescript", value: "35%", share: 0.35, group: "languages" },
    { label: "css", value: "4%", share: 0.04, group: "languages" },
  ],
};

const who: Stat = {
  kind: "stat",
  footer: ["4 authors over 63 commits touching src/git.rs", "(recent work weighs more)"],
  rows: [
    { label: "chrispetrou", value: "41 commits", share: 0.65, note: "last touched 2d" },
    { label: "alice", value: "14 commits", share: 0.22, note: "last touched 12 jun" },
    { label: "bob", value: "6 commits", share: 0.1, note: "last touched 3 may" },
    { label: "bot", value: "2 commits", share: 0.03, note: "last touched 1 feb" },
  ],
};

export function PreviewStat({ dark }: { dark: boolean }) {
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, [dark]);
  return (
    <div className="app-main p-4">
      <div className="text-muted-foreground">
        chrispetrou/wh $ <span className="font-semibold text-foreground">activity</span>
      </div>
      <StatBlock block={activity} fresh={false} />
      <div className="mt-4 text-muted-foreground">
        chrispetrou/wh $ <span className="font-semibold text-foreground">who src/git.rs</span>
      </div>
      <StatBlock block={who} fresh={false} />
    </div>
  );
}
