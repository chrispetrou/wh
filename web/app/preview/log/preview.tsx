"use client";

import { useEffect } from "react";
import type { CommitRow, ListBlock } from "@/lib/block";
import { chatStore } from "@/lib/chat-store";
import { layout, laneCount } from "@/lib/graph";
import { LogBlock } from "@/components/log-block";

const KEY = "preview/wd";
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

// the wd repo's shape: two merged feature branches and one unmerged
const history: Array<[string, string[], string, number, string[]]> = [
  ["f1a2b3c", ["e005fd9"], "Log graph polish: box-drawing rails, solid dots", 0.2, ["feat/more_git_features"]],
  ["e005fd9", ["c5ad6f2"], "File history, path cuts, and why <path>:<line>", 0.5, []],
  ["c5ad6f2", ["6ea2154"], "prs list, pr-number completion, and pr state", 0.8, []],
  ["6ea2154", ["d279b71"], "Changelog mode in both implementations, and tags", 1, []],
  ["d279b71", ["ec23652"], "Log graph, explain <sha>, and time grammar", 1.2, []],
  ["ec23652", ["d7cebfc", "40cce0c"], "Merge pull request #2 from chrispetrou/feat/multi_turn", 2, ["main", "v0.2.0"]],
  ["40cce0c", ["434298d"], "Terminal color roles, command blocks, /copy, and a guide", 3, ["feat/multi_turn"]],
  ["434298d", ["968491a"], "Groq provider, per-provider web keys, and the /effort header fix", 5, []],
  ["968491a", ["2580b7a"], "Keep the menu selection visible while arrowing", 30, []],
  ["2580b7a", ["5cc2c0d"], "Branch completion menu in repo commands", 70, []],
  ["5cc2c0d", ["a942270"], "Number the branches listing and show the total", 71, []],
  ["b1b1b1b", ["a942270"], "Experiment: split panes", 40, ["feat/split_panes"]],
  ["a942270", ["d7cebfc"], "Chat grammar meets cli muscle memory", 72, []],
  ["d7cebfc", ["747df4b", "afbca91"], "Merge pull request #1 from chrispetrou/feat/web_app", 73, []],
  ["afbca91", ["2c280a3"], "Add ci and release workflows", 74, ["feat/web_app"]],
  ["2c280a3", ["747df4b"], "Add web app: github sign-in, repo picker, terminal chat", 80, []],
  ["747df4b", ["48be449"], "Add wd explain: plain-english diff summaries, BYO llm key", 96, ["v0.1.0"]],
  ["48be449", ["2c22b93"], "Add shared explain spec and golden fixtures", 97, []],
  ["2c22b93", [], "Setting up repo", 100, []],
];

function build(): ListBlock {
  const laid = layout(history.map(([sha, parents, , h]) => ({ sha, parents, date: NOW - h * 3600_000 })));
  const bySha = new Map(history.map((h) => [h[0], h]));
  const rows: CommitRow[] = laid.map(({ sha, ...graph }) => {
    const [, parents, subject, h, refs] = bySha.get(sha)!;
    return {
      sha: sha + "0".repeat(33),
      parents,
      subject,
      author: "chrispetrou",
      date: ago(h),
      refs: refs.map((name) => ({
        name,
        kind: name === "main" ? "default" : name.startsWith("v") ? "tag" : "branch",
      })),
    graph,
    };
  });
  return { kind: "log", rows, lanes: laneCount(laid), footer: ["19 commits · 4 branches"] };
}

const prs: ListBlock = {
  kind: "prs",
  footer: ["2 open prs"],
  rows: [
    { num: 3, title: "More git features on the web", author: "chrispetrou", head: "feat/more_git_features", base: "main", updated: ago(0.3), flags: [] },
    { num: 4, title: "Split panes", author: "chrispetrou", head: "feat/split_panes", base: "main", updated: ago(40), flags: ["draft"] },
  ],
};

export function PreviewLog({ dark, open, loading }: { dark: boolean; open: boolean; loading: boolean }) {
  const block = build();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
    if (open && block.kind === "log") {
      const rows = block.rows;
      const sha = rows[5].sha;
      if (loading) {
        // the skeleton: a panel whose fetch never lands
        chatStore.setDetail(KEY, `commit:${sha}`, "loading");
        chatStore.setExpanded(KEY, 0, [sha]);
        chatStore.setLive(KEY, { line: 0, selected: 5 });
        return;
      }
      chatStore.setDetail(KEY, `commit:${sha}`, {
        kind: "commit",
        sha,
        parents: [rows[13].sha, rows[6].sha],
        author: { login: "chrispetrou", name: "Christoforos Petrou", date: ago(2) },
        committer: { name: "GitHub", date: ago(2) },
        message:
          "Merge pull request #2 from chrispetrou/feat/multi_turn\n\nTerminal color roles, command blocks, /copy, and a terminal-vs-web guide",
        url: "https://github.com/chrispetrou/wd/commit/ec23652",
        files: [
          { path: "README.md", additions: 41, deletions: 6, status: "modified" },
          { path: "web/components/terminal-chat.tsx", additions: 88, deletions: 23, status: "modified" },
          { path: "web/lib/commands.ts", additions: 12, deletions: 2, status: "modified" },
        ],
      });
      chatStore.setExpanded(KEY, 0, [sha]);
      chatStore.setLive(KEY, { line: 0, selected: 5 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, open, loading]);
  return (
    <div className="app-main p-4">
      <div className="text-muted-foreground">chrispetrou/wd $ <span className="font-semibold text-foreground">log</span></div>
      <LogBlock block={block} line={0} storeKey={KEY} owner="chrispetrou" repo="wd" submit={() => {}} />
      <div className="mt-4 text-muted-foreground">chrispetrou/wd $ <span className="font-semibold text-foreground">prs</span></div>
      <LogBlock block={prs} line={1} storeKey={KEY} owner="chrispetrou" repo="wd" submit={() => {}} />
    </div>
  );
}
