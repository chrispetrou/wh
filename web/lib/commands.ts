// deterministic chat grammar: three shapes, nothing fuzzy. the llm is
// only used to summarize, never to guess intent.

export type Command =
  | { kind: "last"; n: number }
  | { kind: "pr"; num: number }
  | { kind: "range"; base: string; head: string };

const LAST = /^(?:explain\s+(?:the\s+)?)?last\s+(\d{1,3})\s+commits?$/i;
const PR = /^(?:what\s+changed\s+in\s+)?pr\s*#?\s*(\d{1,6})$/i;
// lazy match splits at the first run of 2+ dots; git forbids ".." inside
// refnames, so dotted branch names like v1.2 parse correctly
const RANGE = /^(\S+?)\.{2,3}(\S+)$/;

export function parseCommand(raw: string): Command | null {
  const input = raw.trim().replace(/\s+/g, " ");
  if (!input) return null;

  const last = LAST.exec(input);
  if (last) {
    const n = Math.min(Math.max(parseInt(last[1], 10), 1), 250);
    return { kind: "last", n };
  }

  const pr = PR.exec(input);
  if (pr) return { kind: "pr", num: parseInt(pr[1], 10) };

  const rangeInput = input.toLowerCase().startsWith("diff ")
    ? input.slice(5).trim()
    : input;
  const range = RANGE.exec(rangeInput);
  if (range) return { kind: "range", base: range[1], head: range[2] };

  return null;
}

export const commandHint = [
  "commands:",
  "  explain the last N commits",
  "  what changed in pr #N",
  "  diff base..head",
  "  /help for everything else",
].join("\n");
