// the /help and /wh tables. a string ending in ":" is an amber section
// label, any other string a muted note, a pair is fg command + muted
// description, aligned on one column.
import type { ChatLine } from "../chat-store";

export type HelpRow = string | [string, string];

export const HELP_COL = 20;

export const HELP: HelpRow[] = [
  "repo commands:",
  ["explain the last N commits [on <branch>]", ""],
  ["what changed in pr #N (or in <branch>)", ""],
  ["diff main..dev (any two refs)", ""],
  ["log [N] [on <branch>]", "the commit graph, rows numbered"],
  ["log since <period> [by <login>]", "the same, filtered: one window, one author, drawn flat"],
  ["explain 3, explain 2..5", "rows of the last log"],
  ["explain <sha>", "one commit"],
  ["since yesterday [by me]", "a period, a ref, one author; standup"],
  ["changelog [range]", "release notes: added, changed, fixed, removed"],
  ["describe pr #N | <branch> | range", "a pr title and description, ready to paste (/copy)"],
  ["rebase <branch> | main..feat | pr #N | 2..5", "a rebase plan: reorder, squash, reword, drop; paste the commands"],
  ["pick 3 5 onto <branch>", "a cherry-pick plan (backport pr #N to <branch> works too)"],
  ["history <path>", "commits touching a file or dir, numbered"],
  ["... in <path>", "any explain, cut down to a file or dir"],
  ["why <path>:<line>[-<line>]", "why a line or a span exists (blame, in plain words)"],
  ["who <path>", "who knows a file or dir: authors ranked, recent work weighs more"],
  ["view <path>[:<line>] [on <branch>]", "read a file in place (cat works); a line number asks why"],
  ["ls [<dir>] [on <branch>]", "directory listing, dirs first"],
  ["churn [since <ref>] [in <path>]", "hotspots: the files changing most, commit counts per path"],
  ["activity [since <period>]", "weekly commit spark, top authors, languages"],
  ["branches", "list branches with ahead/behind"],
  ["stale [8w | since <date>]", "branches with no commits in n weeks"],
  ["tags", "list tags, newest first"],
  ["prs [open|closed|mine]", "pull requests, recently updated first"],
  "  after an explain, plain words are follow-up questions",
  "slash commands:",
  ["/repos", "switch repo"],
  ["/key <value>", "add an llm key (/key clear [provider] removes)"],
  ["/usage", "tokens on each key since it was saved (/usage reset)"],
  ["/model <name>", "pick the model; /model sync refreshes the list"],
  ["/effort <level>", "reasoning effort (model support varies)"],
  ["/theme <t>", "auto, light, dark, vintage, or amber"],
  ["/account", "who is signed in"],
  ["/info", "repo, provider, theme, font"],
  ["/font <f>", "default, fira, jetbrains, or plex"],
  ["/fontsize <n>", "11 to 18, or default"],
  ["/ligatures <t>", "on or off"],
  ["/show", "the raw payload of the last command"],
  ["/copy", "copy the last answer to the clipboard"],
  ["/export", "save this transcript as a text file"],
  ["/wh", "about the wh cli"],
  ["/stop", "stop a running explain (esc works too)"],
  ["/clear", "clear the screen"],
  ["/logout", "sign out"],
  "keys:",
  ["tab", "complete"],
  ["right", "take the gray suggestion (your history)"],
  ["up/down", "history; after a log, walk its rows; on a file, scroll"],
  ["enter / esc", "open a row, step back out"],
  ["p r s f d e, shift+up/down", "on a plan row: set its action, move it (drag works too)"],
  ["ctrl+r", "search history"],
  ["esc", "stop, or close the menu"],
  ["cmd+k / ctrl+k", "repo picker"],
  ["ctrl+t", "new tab"],
  ["ctrl+1..9", "switch tabs"],
  "mouse:",
  ["drag a log row", "onto a branch line for a cherry-pick plan, or into a plan"],
  ["drag a pr row", "onto a branch line to backport it"],
  ["click a sha", "copy it"],
  ["click a line number", "why that line (shift+click spans)"],
  ["hover an age", "the absolute date"],
];

export const WH_HELP: HelpRow[] = [
  "wh is also a cli: one tiny binary, no telemetry.",
  ["wh new <branch>", "worktree in a sibling dir, copies .env*"],
  ["wh ls", "worktrees with dirty and ahead/behind status"],
  ["wh switch [query]", "picker that cd's via a shell wrapper"],
  ["wh rm [name]", "prune worktrees whose branches are merged"],
  ["wh explain [range]", "this, in your terminal, on the same key"],
  ["wh init zsh", "the shell wrapper for switch"],
  "source: github.com/chrispetrou/wh",
];

export function helpLines(rows: HelpRow[]): ChatLine[] {
  return rows.map((row) => {
    if (typeof row === "string") {
      return { text: row, cls: row.endsWith(":") ? "a" : "o" };
    }
    const [cmd, desc] = row;
    // a command outgrowing the column still gets a gap before its note
    const head = `  ${cmd}`;
    return {
      head: { text: head.length >= HELP_COL ? `${head}  ` : head.padEnd(HELP_COL), cls: "" },
      text: desc,
      cls: "o",
    };
  });
}
