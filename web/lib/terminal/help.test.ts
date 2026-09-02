import { describe, expect, it } from "vitest";
import { HELP, HELP_COL, helpLines, WH_HELP } from "./help";
import { COMMANDS } from "./menu";

describe("help tables", () => {
  it("aligns short commands on one column", () => {
    for (const l of helpLines(HELP)) {
      if (l.head && l.head.text.trim().length + 2 <= HELP_COL) {
        expect(l.head.text.length).toBe(HELP_COL);
      }
    }
  });

  it("keeps a gap between a long command and its note", () => {
    for (const l of [...helpLines(HELP), ...helpLines(WH_HELP)]) {
      if (l.head && l.text) expect(l.head.text.endsWith(" "), l.head.text).toBe(true);
    }
  });

  it("labels sections amber and notes muted", () => {
    const rows = helpLines(HELP);
    expect(rows[0]).toEqual({ text: "repo commands:", cls: "a" });
    const note = rows.find((l) => l.text.startsWith("  after an explain"));
    expect(note?.cls).toBe("o");
    expect(helpLines(WH_HELP).at(-1)).toEqual({ text: "source: github.com/chrispetrou/wh", cls: "o" });
  });

  it("lists every slash command the menu offers", () => {
    const heads = new Set(helpLines(HELP).map((l) => l.head?.text.trim().split(" ")[0]));
    for (const c of COMMANDS) {
      if (c.name === "/help") continue;
      expect(heads.has(c.name), c.name).toBe(true);
    }
  });
});
