// token and wait formatting, headroom headers; mirrors cli/src/usage.rs.
// the rules are in shared/prompts/provider.md; integer arithmetic so both
// sides round ties the same way.

import type { ProviderName } from "./providers";

// 842, 1k, 1.3k, 12.4k, 999.9k, 1m, 1.2m
export function fmtTokens(n: number): string {
  n = Math.max(0, Math.floor(n));
  if (n < 1000) return String(n);
  const unit = n < 999_950 ? 1000 : 1_000_000;
  const tenths = Math.floor((n * 10 + unit / 2) / unit);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return `${whole}${frac ? `.${frac}` : ""}${unit === 1000 ? "k" : "m"}`;
}

// 12s, 3m, 1h 20m, 2h
export function fmtWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s - h * 3600) / 60);
  if (m === 60) return `${h + 1}h`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// "6m0s", "2m59.56s", "7.66s", "1h23m" -> whole seconds, rounded up
export function parseDuration(s: string): number | null {
  const m = /^\s*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?\s*$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Math.ceil((+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)));
}

export interface HeaderBag {
  get(name: string): string | null;
}

// seconds until the next try, from the headers then the message; null
// when nothing says. see "waits" in shared/prompts/provider.md
export function waitFrom(headers: HeaderBag | undefined, message: string): number | null {
  const now = Date.now();
  const retry = headers?.get("retry-after");
  if (retry) {
    if (/^\d+$/.test(retry.trim())) return +retry.trim();
    const at = Date.parse(retry);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  for (const name of [
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-requests",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-requests-reset",
  ]) {
    const v = headers?.get(name);
    if (!v) continue;
    const d = parseDuration(v);
    if (d !== null) return d;
    const at = Date.parse(v);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  const phrase = /try again in ((?:\d+(?:\.\d+)?[hms])+)/i.exec(message);
  if (phrase) {
    const d = parseDuration(phrase[1]);
    if (d !== null) return d;
  }
  return null;
}

// what the last answer said was left on the key, when the provider
// reports it; tokens per minute, requests per day for groq
export interface Headroom {
  tokens?: { left: number; limit: number };
  requests?: { left: number; limit: number };
  reset?: string; // fmtWait output, when known
}

function pair(headers: HeaderBag, left: string, limit: string) {
  const l = headers.get(left);
  const m = headers.get(limit);
  if (l === null || m === null) return undefined;
  const a = parseInt(l, 10);
  const b = parseInt(m, 10);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= 0) return undefined;
  return { left: a, limit: b };
}

export function headroom(provider: ProviderName, headers: HeaderBag): Headroom | null {
  const h: Headroom =
    provider === "anthropic"
      ? {
          tokens: pair(headers, "anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-tokens-limit"),
          requests: pair(
            headers,
            "anthropic-ratelimit-requests-remaining",
            "anthropic-ratelimit-requests-limit"
          ),
        }
      : {
          tokens: pair(headers, "x-ratelimit-remaining-tokens", "x-ratelimit-limit-tokens"),
          requests: pair(headers, "x-ratelimit-remaining-requests", "x-ratelimit-limit-requests"),
        };
  if (!h.tokens && !h.requests) return null;
  const wait = waitFrom(headers, "");
  if (wait !== null) h.reset = fmtWait(wait);
  return h;
}

// the amber line when a limit is nearly used up, else null
export function lowLine(provider: ProviderName, h: Headroom | null | undefined): string | null {
  if (!h) return null;
  for (const [what, v] of [
    ["tokens", h.tokens],
    ["requests", h.requests],
  ] as const) {
    if (v && v.left < v.limit / 10) {
      return `low on ${provider} ${what}: ${fmtTokens(v.left)} of ${fmtTokens(v.limit)} left${
        h.reset ? `, resets in ${h.reset}` : ""
      }`;
    }
  }
  return null;
}

// "1.2k in · 340 out", or "" when the provider sent nothing
export function usageParts(u: { in: number; out: number } | null | undefined): string {
  if (!u) return "";
  return `${fmtTokens(u.in)} in · ${fmtTokens(u.out)} out`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the provider";
  }
}
