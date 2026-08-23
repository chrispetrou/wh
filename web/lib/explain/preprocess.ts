// typescript implementation of shared/prompts/preprocess.md. must
// reproduce shared/fixtures/explain/*/expected.txt byte for byte; the
// rust twin lives in cli/src/preprocess.rs.
import { excludeTxt } from "./shared.gen";

export interface Caps {
  perFile: number;
  total: number;
}

export const defaultCaps: Caps = { perFile: 400, total: 4000 };

export type Matcher = "name" | "segment" | "suffix";

export interface Rule {
  kind: string;
  matcher: Matcher;
  value: string;
}

export function parseRules(s: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of s.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [kind, matcher, value] = line.split("\t");
    if (!kind || !value) continue;
    if (matcher !== "name" && matcher !== "segment" && matcher !== "suffix") continue;
    rules.push({ kind, matcher, value });
  }
  return rules;
}

export function defaultRules(): Rule[] {
  return parseRules(excludeTxt);
}

export function classify(path: string, rules: Rule[]): string | null {
  const segs = path.split("/");
  for (const r of rules) {
    const hit =
      r.matcher === "name"
        ? segs[segs.length - 1] === r.value
        : r.matcher === "segment"
          ? segs.includes(r.value)
          : path.endsWith(r.value);
    if (hit) return r.kind;
  }
  return null;
}

export interface Stats {
  files: number;
  added: number;
  deleted: number;
}

// binary "-" columns count 0
export function stats(numstat: string): Stats {
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [a, d] = line.split("\t");
    files += 1;
    added += /^\d+$/.test(a) ? parseInt(a, 10) : 0;
    deleted += /^\d+$/.test(d) ? parseInt(d, 10) : 0;
  }
  return { files, added, deleted };
}

// byte-order comparison: js "<" compares utf-16 code units, which
// diverges from the spec's byte order for astral characters
const enc = new TextEncoder();
function byteCompare(a: string, b: string): number {
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

export function preprocess(
  diff: string,
  commits: string,
  numstat: string,
  caps: Caps,
  rules: Rule[]
): string {
  const out: string[] = [];

  const commitLines = commits.split("\n").filter((l) => l.trim());
  if (commitLines.length > 0) {
    out.push(`commits: ${commitLines.length}`);
    for (const c of commitLines) out.push(`- ${c}`);
  }

  const { files, added, deleted } = stats(numstat);
  out.push(`files: ${files} (+${added} -${deleted})`);

  // split into file sections; content before the first header is dropped
  const sections: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      sections.push([line]);
    } else if (sections.length > 0) {
      sections[sections.length - 1].push(line);
    }
  }
  // a trailing newline in the input yields one empty trailing line in the
  // last section; drop it so section line counts match the rust `lines()`
  const last = sections[sections.length - 1];
  if (last && last[last.length - 1] === "") last.pop();

  const kept: Array<{ path: string; sec: string[] }> = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  for (const sec of sections) {
    const header = sec[0];
    const i = header.lastIndexOf(" b/");
    const path = i >= 0 ? header.slice(i + 3) : header;
    const binary = sec.some(
      (l) => l.startsWith("Binary files ") || l.startsWith("GIT binary patch")
    );
    const reason = binary ? "binary" : classify(path, rules);
    if (reason) excluded.push({ path, reason });
    else kept.push({ path, sec });
  }

  if (excluded.length > 0) {
    excluded.sort(
      (x, y) => byteCompare(x.path, y.path) || byteCompare(x.reason, y.reason)
    );
    out.push("excluded:");
    for (const { path, reason } of excluded) out.push(`- ${path} (${reason})`);
  }
  out.push("---");

  kept.sort((x, y) => byteCompare(x.path, y.path));
  let total = 0;
  for (const { path, sec } of kept) {
    let lines = sec;
    if (lines.length > caps.perFile) {
      const dropped = lines.length - caps.perFile;
      lines = lines.slice(0, caps.perFile);
      lines.push(`... truncated (${dropped} more lines)`);
    }
    if (total + lines.length > caps.total) {
      out.push(`... omitted ${path} (size cap)`);
      total += 1;
      continue;
    }
    total += lines.length;
    out.push(...lines);
  }

  return out.join("\n") + "\n";
}
