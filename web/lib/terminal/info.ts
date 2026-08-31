// the strings the terminal says about keys, models, effort, and usage:
// the footer, /info, /usage, /key, /model. every function reads a key
// store passed in (the browser one by default), so the wording is
// testable with an in-memory store.
import { DEFAULT_MODELS, EFFORTS, FREE_TIER, SUGGESTED_MODELS, type ProviderName } from "../explain/providers";
import { fmtTokens } from "../explain/usage";
import { keyStore, type KeyStore } from "../key-store";
import { PROVIDERS } from "./menu";

export function modelList(p: ProviderName): string {
  const [first, ...rest] = SUGGESTED_MODELS[p];
  return [`${first} (default)`, ...rest].join(", ");
}

// one line per provider; the ones without a key say so
export function modelSuggestionLines(ks: KeyStore = keyStore): string[] {
  return PROVIDERS.map(
    (p) =>
      `${p}${FREE_TIER.includes(p) ? " (free tier)" : ""}: ${modelList(p)}${ks.hasKey(p) ? "" : " · no key"}`
  );
}

// one line per provider for /key
export function keyLines(ks: KeyStore = keyStore): string[] {
  const a = ks.active();
  return PROVIDERS.map((p) => {
    const state = ks.hasKey(p)
      ? p === a
        ? "set (active)"
        : "set"
      : FREE_TIER.includes(p)
        ? "none (free tier at console.groq.com)"
        : "none";
    return `${p.padEnd(10)}${state}`;
  });
}

export function activeModel(ks: KeyStore = keyStore): string {
  const a = ks.active();
  return a ? ks.model(a) : "";
}

export function activeEffort(ks: KeyStore = keyStore): string {
  const a = ks.active();
  return a ? ks.effort(a) : "";
}

// true when the active provider takes no effort level
export function effortIgnored(ks: KeyStore = keyStore): boolean {
  const a = ks.active();
  return a !== null && EFFORTS[a].length === 0;
}

export function providerInfo(ks: KeyStore = keyStore): string {
  const a = ks.active();
  if (!a) return "no key set";
  const override = ks.model(a);
  return `${a} · ${override || DEFAULT_MODELS[a]}`;
}

// the model a request goes to right now
export function modelName(ks: KeyStore = keyStore): string {
  const a = ks.active();
  return a ? ks.model(a) || DEFAULT_MODELS[a] : "";
}

// "aug 27"
export function monthDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
}

// the footer's " · 12.4k tokens": in + out on the active key since it
// was saved; nothing at 0
export function usageInfo(ks: KeyStore = keyStore): string {
  const a = ks.active();
  const u = a ? ks.usage(a) : null;
  const total = u ? u.in + u.out : 0;
  return total ? ` · ${fmtTokens(total)} tokens` : "";
}

// the /info row
export function usageInfoRow(ks: KeyStore = keyStore): string {
  const a = ks.active();
  const u = a ? ks.usage(a) : null;
  if (!u) return "nothing counted yet";
  return `${fmtTokens(u.in + u.out)} tokens on ${a} since ${monthDay(u.since)}, /usage for the breakdown`;
}

// the /usage table: one row per provider, then the last headroom
export function usageLines(ks: KeyStore = keyStore): string[] {
  const a = ks.active();
  const rows = PROVIDERS.map((p) => {
    if (!ks.hasKey(p)) return `${p.padEnd(11)}no key`;
    const u = ks.usage(p);
    if (!u) return `${p.padEnd(11)}nothing yet${p === a ? " (active)" : ""}`;
    const n = u.answers === 1 ? "answer" : "answers";
    return `${p.padEnd(11)}${fmtTokens(u.in)} in · ${fmtTokens(u.out)} out · ${u.answers} ${n} · since ${monthDay(u.since)}${p === a ? " (active)" : ""}`;
  });
  const left = a ? ks.usage(a)?.left : undefined;
  if (left) {
    const parts = [
      left.tokens ? `${fmtTokens(left.tokens.left)} tokens` : "",
      left.requests ? `${fmtTokens(left.requests.left)} requests` : "",
    ].filter(Boolean);
    if (parts.length) rows.push(`${"headroom".padEnd(11)}${parts.join(" · ")} left (as of the last answer)`);
  }
  return rows;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
