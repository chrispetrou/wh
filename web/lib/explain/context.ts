// the context block describe mode appends to the user turn after the
// payload (shared/prompts/README.md): the branch and its base, and an
// existing pr's title and body. twin of the cli's block in
// cli/src/commands/explain.rs, which only ever knows the branch
import type { DescribeContext } from "../github";

// chars of an existing description relayed to the model
export const BODY_CAP = 2000;

export function describeTurn(d: DescribeContext | undefined): string {
  if (!d) return "";
  const lines: string[] = [];
  if (d.head && d.base) lines.push(`branch ${d.head} into ${d.base}`);
  else if (d.head) lines.push(`branch ${d.head}`);
  else if (d.base) lines.push(`into ${d.base}`);
  if (d.pr) {
    lines.push(`pr #${d.pr.num}: ${d.pr.title}`);
    const body = d.pr.body.trim();
    if (body) lines.push("current description:", body.slice(0, BODY_CAP));
  }
  if (!lines.length) return "";
  return `\n\ncontext:\n${lines.join("\n")}`;
}
