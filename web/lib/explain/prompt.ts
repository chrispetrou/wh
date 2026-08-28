// splits shared/prompts/explain.md into its [section] parts and
// substitutes {{payload}}; twin of cli/src/llm.rs::prompt. any
// [section] line switches sections, unknown ones are skipped.
import { explainTemplate } from "./shared.gen";

// which system prompt frames the payload: the review shape (summary,
// watch out), release notes (added, changed, fixed, removed), or the
// reason a line exists (why, watch out)
export type PromptMode = "explain" | "changelog" | "why";

function sections(): Record<string, string> {
  const out: Record<string, string> = {};
  let target: string | null = null;
  for (const line of explainTemplate.split("\n")) {
    if (line.startsWith("[") && line.endsWith("]")) {
      target = line.slice(1, -1);
      out[target] = out[target] ?? "";
    } else if (target !== null) {
      out[target] += line + "\n";
    }
  }
  return out;
}

export function prompt(
  payload: string,
  mode: PromptMode = "explain"
): {
  system: string;
  user: string;
  followup: string;
} {
  const s = sections();
  return {
    system: (s[mode === "explain" ? "system" : mode] ?? "").trim(),
    user: (s.user ?? "").trim().replace("{{payload}}", payload),
    followup: (s.followup ?? "").trim(),
  };
}
