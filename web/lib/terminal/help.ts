// the /help and /wd tables. a string ending in ":" is an amber section
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
  ["why <path>:<line>", "why a line exists (blame, in plain words)"],
  ["branches", "list branches with ahead/behind"],
  ["tags", "list tags, newest first"],
  ["prs [open|closed|mine]", "pull requests, recently updated first"],
  "  after an explain, plain words are follow-up questions",
  "slash commands:",
  ["/repos", "switch repo"],
  ["/key <value>", "add an llm key (/key clear [provider] removes)"],
  ["/usage", "tokens on each key since it was saved (/usage reset)"],
  ["/model <name>", "pick the model; another provider's switches to it"],
  ["/effort <level>", "reasoning effort (model support varies)"],
  ["/theme <t>", "auto, light, or dark"],
  ["/account", "who is signed in"],
  ["/info", "repo, provider, theme, font"],
  ["/font <f>", "default, fira, jetbrains, or plex"],
  ["/fontsize <n>", "11 to 18, or default"],
  ["/ligatures <t>", "on or off"],
  ["/show", "the raw payload of the last command"],
  ["/copy", "copy the last answer to the clipboard"],
  ["/export", "save this transcript as a text file"],
  ["/wd", "about the wd cli"],
  ["/stop", "stop a running explain (esc works too)"],
  ["/clear", "clear the screen"],
  ["/logout", "sign out"],
  "keys:",
  ["tab", "complete"],
  ["up/down", "history; after a log, walk its rows"],
  ["enter / esc", "open a row, step back out"],
  ["p r s f d e, shift+up/down", "on a plan row: set its action, move it (drag works too)"],
  ["ctrl+r", "search history"],
  ["esc", "stop, or close the menu"],
  ["cmd+k / ctrl+k", "repo picker"],
  ["ctrl+t", "new tab"],
  ["ctrl+1..9", "switch tabs"],
];

export const WD_HELP: HelpRow[] = [
  "wd is also a cli: one tiny binary, no telemetry.",
  ["wd new <branch>", "worktree in a sibling dir, copies .env*"],
  ["wd ls", "worktrees with dirty and ahead/behind status"],
  ["wd switch [query]", "picker that cd's via a shell wrapper"],
  ["wd rm [name]", "prune worktrees whose branches are merged"],
  ["wd explain [range]", "this, in your terminal, on the same key"],
  ["wd init zsh", "the shell wrapper for switch"],
  "source: github.com/chrispetrou/wd",
];

export function helpLines(rows: HelpRow[]): ChatLine[] {
  return rows.map((row) => {
    if (typeof row === "string") {
      return { text: row, cls: row.endsWith(":") ? "a" : "o" };
    }
    const [cmd, desc] = row;
    return {
      head: { text: `  ${cmd}`.padEnd(HELP_COL), cls: "" },
      text: desc,
      cls: "o",
    };
  });
}
