// the completion menu's grammar: the slash commands with their options,
// and where a branch name, a log row number, or a pr number belongs in a
// repo command being typed. the store is a parameter so the arg lists
// are testable with an in-memory key store.
import {
  DEFAULT_MODELS,
  EFFORTS,
  FREE_TIER,
  modelFamily,
  SUGGESTED_MODELS,
  type ProviderName,
} from "../explain/providers";
import { keyStore, type KeyStore } from "../key-store";

export const FONTS = ["default", "fira", "jetbrains", "plex"];

export const PROVIDERS = Object.keys(SUGGESTED_MODELS) as ProviderName[];

// every provider's models, the active provider's first. no "default"
// row: each provider's default is labeled, and picking it resets the
// override (typing /model default still works)
export function modelArgs(ks: KeyStore = keyStore): string[] {
  const a = ks.active();
  const order = a ? [a, ...PROVIDERS.filter((p) => p !== a)] : PROVIDERS;
  return order.flatMap((p) => SUGGESTED_MODELS[p]);
}

export function effortArgs(ks: KeyStore = keyStore): string[] {
  const a = ks.active();
  const levels = a ? EFFORTS[a] : [...new Set(Object.values(EFFORTS).flat())];
  return ["default", ...levels];
}

export function keyArgs(ks: KeyStore = keyStore): string[] {
  return ["clear", ...ks.providers().map((p) => `clear ${p}`)];
}

export function usageArgs(ks: KeyStore = keyStore): string[] {
  return ["reset", ...ks.providers().map((p) => `reset ${p}`)];
}

// the completion menu: commands, their descriptions, and their options
export interface CmdSpec {
  name: string;
  desc: string;
  args?: string[] | (() => string[]);
}

export function buildCommands(ks: KeyStore): CmdSpec[] {
  return [
    { name: "/help", desc: "all commands and keys" },
    { name: "/repos", desc: "switch repo" },
    { name: "/key", desc: "add an llm key", args: () => keyArgs(ks) },
    { name: "/usage", desc: "tokens per key", args: () => usageArgs(ks) },
    { name: "/model", desc: "pick the model", args: () => modelArgs(ks) },
    { name: "/effort", desc: "reasoning effort", args: () => effortArgs(ks) },
    { name: "/theme", desc: "light or dark", args: ["auto", "light", "dark"] },
    { name: "/font", desc: "terminal font", args: FONTS },
    {
      name: "/fontsize",
      desc: "11 to 18",
      args: ["default", "11", "12", "13", "14", "15", "16", "17", "18"],
    },
    { name: "/ligatures", desc: "fira and jetbrains only", args: ["on", "off"] },
    { name: "/account", desc: "who is signed in" },
    { name: "/info", desc: "repo, provider, theme, font" },
    { name: "/show", desc: "raw payload of the last command" },
    { name: "/copy", desc: "copy the last answer" },
    { name: "/export", desc: "save the transcript" },
    { name: "/wd", desc: "about the wd cli" },
    { name: "/stop", desc: "stop a running explain" },
    { name: "/clear", desc: "clear the screen" },
    { name: "/logout", desc: "sign out" },
  ];
}

export const COMMANDS: CmdSpec[] = buildCommands(keyStore);

export interface Menu {
  stage: "cmd" | "arg" | "branch" | "row" | "pr";
  rows: string[];
  spec?: CmdSpec;
  prefix?: string; // branch and row stages: the text before the slot
}

// where a branch name belongs in a repo command being typed
export interface BranchSlot {
  prefix: string;
  partial: string;
}

export function branchSlot(input: string): BranchSlot | null {
  if (!input || input.startsWith("/")) return null;
  let m = /^((?:wd\s+)?what\s+changed\s+(?:in|on)\s+)(\S*)$/i.exec(input);
  if (m && !/^pr\b|^#/i.test(m[2])) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:explain\s+(?:the\s+)?)?last\s+\d{1,3}(?:\s+commits?)?\s+on\s+)(\S*)$/i.exec(
    input
  );
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:git\s+)?(?:log|graph|history)(?:\s+\S+)?\s+on\s+)(\S*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?why\s+\S+:\d+\s+on\s+)(\S*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  // "since <ref>" anywhere at the end, and the first side of a changelog range
  m = /^((?:wd\s+)?(?:.*\s)?since\s+)([^\s.]*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:changelog|release\s+notes|describe|rebase)\s+)([^\s.]*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  // the target of a cherry-pick plan
  m = /^((?:wd\s+)?(?:(?:cherry-)?pick\s+.+?\s+onto\s+|backport\s+.+?\s+to\s+))(\S*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  m = /^((?:(?:wd\s+)?(?:diff|compare|explain)\s+)?\S*?\.{2,3})(\S*)$/i.exec(input);
  if (m && m[1].includes("..")) return { prefix: m[1], partial: m[2] };
  m = /^((?:wd\s+)?(?:diff|compare)\s+)([^\s.]*)$/i.exec(input);
  if (m) return { prefix: m[1], partial: m[2] };
  return null;
}

// "explain " with a log on screen offers its row numbers; so do a rebase
// and a pick (which takes several)
export function rowSlot(input: string): BranchSlot | null {
  const m = /^((?:wd\s+)?(?:explain|show|rebase|(?:cherry-)?pick)\s+(?:\d{1,3}\s+)*)(\d{0,3})$/i.exec(input);
  return m ? { prefix: m[1], partial: m[2] } : null;
}

// "pr " with a prs list on screen offers its numbers
export function prSlot(input: string): BranchSlot | null {
  const m =
    /^((?:wd\s+)?(?:(?:explain|changelog|release\s+notes|describe|draft\s+pr|pr\s+description)\s+(?:for\s+)?|what\s+changed\s+in\s+)?(?:pr|pull\s+request)\s*#?)(\d{0,6})$/i.exec(
      input
    );
  return m ? { prefix: m[1], partial: m[2] } : null;
}

export function menuFor(input: string, commands: CmdSpec[] = COMMANDS): Menu | null {
  if (!input.startsWith("/")) return null;
  const sp = input.indexOf(" ");
  if (sp < 0) {
    const q = input.toLowerCase();
    const rows = commands.filter((c) => c.name.startsWith(q)).map((c) => c.name);
    return rows.length ? { stage: "cmd", rows } : null;
  }
  const spec = commands.find((c) => c.name === input.slice(0, sp).toLowerCase());
  if (!spec?.args) return null;
  const args = typeof spec.args === "function" ? spec.args() : spec.args;
  const partial = input.slice(sp + 1).toLowerCase();
  const rows = args.filter((a) => a.startsWith(partial));
  if (rows.length === 1 && rows[0] === partial) return null; // fully typed
  return rows.length ? { stage: "arg", rows, spec } : null;
}

// which kind of menu the input would open, if any
export function stageOf(v: string, commands: CmdSpec[] = COMMANDS): Menu["stage"] | undefined {
  return (
    menuFor(v, commands)?.stage ??
    (branchSlot(v) ? "branch" : rowSlot(v) ? "row" : prSlot(v) ? "pr" : undefined)
  );
}

export interface Note {
  text: string;
  cls?: string;
}

// notes beside a completion row: for /model, the provider, whether it
// is free, whether the row is that provider's default, and a warning
// when no key for it is stored
export function argNotes(spec: CmdSpec | undefined, row: string, ks: KeyStore = keyStore): Note[] {
  if (row === "default") return [{ text: "provider default" }];
  if (spec?.name !== "/model") return [];
  const p = modelFamily(row);
  if (!p) return [];
  const notes: Note[] = [{ text: p }];
  if (FREE_TIER.includes(p)) notes.push({ text: "free", cls: "text-wd-green" });
  if (DEFAULT_MODELS[p] === row) notes.push({ text: "default", cls: "text-muted-foreground" });
  if (!ks.hasKey(p)) notes.push({ text: "no key", cls: "text-wd-amber" });
  return notes;
}
