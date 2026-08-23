// splits shared/prompts/explain.md into its [system]/[user] parts and
// substitutes {{payload}}; port of cli/src/llm.rs::prompt.
import { explainTemplate } from "./shared.gen";

export function prompt(payload: string): { system: string; user: string } {
  let system = "";
  let user = "";
  let target: "system" | "user" | null = null;
  for (const line of explainTemplate.split("\n")) {
    if (line === "[system]") target = "system";
    else if (line === "[user]") target = "user";
    else if (target === "system") system += line + "\n";
    else if (target === "user") user += line + "\n";
  }
  return {
    system: system.trim(),
    user: user.trim().replace("{{payload}}", payload),
  };
}
