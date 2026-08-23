// deterministic chat grammar: three shapes, nothing fuzzy. the llm is
// only used to summarize, never to guess intent.

export type Command =
  | { kind: "last"; n: number }
  | { kind: "pr"; num: number }
  | { kind: "range"; base: string; head: string };

const LAST = /^(?:explain\s+(?:the\s+)?)?last\s+(\d{1,3})(?:\s+commits?)?$/i;
const PR = /^(?:what\s+changed\s+in\s+)?pr\s*#?\s*(\d{1,6})$/i;
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
  // cli muscle memory: "wd explain HEAD~3.." works here too
  input = input.replace(/^wd\s+/i, "");
  if (/^explain$/i.test(input)) return { kind: "last", n: 1 }; // cli default

  const last = LAST.exec(input);
  if (last) return { kind: "last", n: clampN(last[1]) };

  const pr = PR.exec(input);
  if (pr) return { kind: "pr", num: parseInt(pr[1], 10) };

  const rangeInput = input.replace(/^(?:diff|explain)\s+/i, "");
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
  "  explain the last N commits",
  "  what changed in pr #N",
  "  diff base..head",
  "  cli-style works too: wd explain HEAD~3..",
  "  /help for everything else",
].join("\n");
