// first-run oauth setup: only meaningful before credentials exist, and
// only offered to the dev server on localhost so a deployed instance can
// never be claimed by a visitor (a proxy may forward its own localhost
// host header, so the forwarding headers and NODE_ENV are checked too).
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function oauthConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export function isLocalHost(host: string | null): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? "");
}

export function setupAllowed(headers: Headers): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (headers.get("x-forwarded-host") || headers.get("x-forwarded-for")) return false;
  return isLocalHost(headers.get("host"));
}

function envPath(): string {
  return resolve(process.cwd(), process.env.WH_ENV_FILE ?? ".env.local");
}

// merge key=value pairs into .env.local, preserving unrelated lines
export function saveEnv(values: Record<string, string>) {
  let lines: string[] = [];
  try {
    lines = readFileSync(envPath(), "utf8").split("\n");
  } catch {
    // no file yet
  }
  const pending = { ...values };
  const out = lines.map((line) => {
    const key = line.split("=")[0];
    if (key && key in pending) {
      const v = pending[key];
      delete pending[key];
      return `${key}=${v}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${v}`);
  writeFileSync(envPath(), out.join("\n") + "\n");
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

// fills anything else a fresh clone is missing, so setup is one screen
export function ensureBaseEnv(origin: string) {
  const extra: Record<string, string> = {};
  if (!process.env.SESSION_SECRET) extra.SESSION_SECRET = randomBytes(32).toString("hex");
  if (!process.env.APP_URL) extra.APP_URL = origin;
  if (Object.keys(extra).length) saveEnv(extra);
}
