// deterministic chat grammar: three intents, a small synonym surface,
// nothing fuzzy. the llm is only used to summarize, never to guess
// intent.

export type Command =
  | { kind: "last"; n: number; ref?: string }
  | { kind: "pr"; num: number }
  | { kind: "range"; base: string; head: string }
  | { kind: "branches" };

// leading verbs people naturally type before any of the three shapes
const VERB = /^(?:(?:explain|summarize|show)(?:\s+me)?|what\s+changed\s+in)\s+/i;
// "last N commits", "last commit", "the last 5 commits on dev", ...
const LAST =
  /^(?:the\s+)?last(?:\s+(\d{1,3}))?(\s+commits?)?(?:\s+on\s+(\S+))?$/i;
// "pr 42", "pull request #42", "#42"
const PR = /^(?:the\s+)?(?:pr|pull\s+request)\s*#?\s*(\d{1,6})$/i;
const HASH = /^#(\d{1,6})$/;
// lazy match splits at the first run of 2+ dots; git forbids ".." inside
// refnames, so dotted branch names like v1.2 parse correctly. the head
// side may be empty (cli-style open ranges like HEAD~3..)
const RANGE = /^(\S+?)\.{2,3}(\S*)$/;

function clampN(s: string): number {
  return Math.min(Math.max(parseInt(s, 10), 1), 250);
}

export function parseCommand(raw: string): Command | null {
  let input = raw.trim().replace(/\s+/g, " ");
  if (!input) return null;
  // cli muscle memory ("wd explain HEAD~3..") and trailing question marks
  input = input.replace(/^wd\s+/i, "").replace(/\s*\?+$/, "");
  if (/^explain$/i.test(input)) return { kind: "last", n: 1 }; // cli default
  if (/^(?:list\s+)?branches$/i.test(input)) return { kind: "branches" };

  const phrase = input.replace(VERB, "");

  // a number, or the singular "last commit"; bare plural is too ambiguous
  const last = LAST.exec(phrase);
  if (last) {
    const n = last[1] ? clampN(last[1]) : /^\s+commit$/i.test(last[2] ?? "") ? 1 : 0;
    if (n) {
      return last[3] ? { kind: "last", n, ref: last[3] } : { kind: "last", n };
    }
  }

  const pr = PR.exec(phrase) ?? HASH.exec(phrase);
  if (pr) return { kind: "pr", num: parseInt(pr[1], 10) };

  const rangeInput = input
    .replace(/^(?:diff|compare|explain|summarize|show)\s+/i, "")
    .replace(/\s+and\s+(?:summarize|explain)(?:\s+it)?$/i, "");
  const range = RANGE.exec(rangeInput);
  if (range) {
    const base = range[1];
    // empty head (or literal HEAD) means the repo's default branch tip
    const head = /^head$/i.test(range[2]) ? "" : range[2];
    const lastN = /^head~(\d{1,3})$/i.exec(base);
    if (lastN && head === "") return { kind: "last", n: clampN(lastN[1]) };
    return { kind: "range", base, head };
  }

  return null;
}

export const commandHint = [
  "commands:",
  "  explain the last N commits [on <branch>]",
  "  what changed in pr #N",
  "  diff base..head",
  "  branches",
  "  cli-style works too: wd explain HEAD~3..",
  "  /help for everything else",
].join("\n");
