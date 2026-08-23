// splits shared/prompts/explain.md into its [section] parts and
// substitutes {{payload}}; twin of cli/src/llm.rs::prompt. any
// [section] line switches sections, unknown ones are skipped.
import { explainTemplate } from "./shared.gen";

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

export function prompt(payload: string): {
  system: string;
  user: string;
  followup: string;
} {
  const s = sections();
  return {
    system: (s.system ?? "").trim(),
    user: (s.user ?? "").trim().replace("{{payload}}", payload),
    followup: (s.followup ?? "").trim(),
  };
}
