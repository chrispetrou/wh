import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands";

describe("parseCommand", () => {
  it("parses last-n shapes", () => {
    expect(parseCommand("explain the last 5 commits")).toEqual({
      kind: "last",
      n: 5,
    });
    expect(parseCommand("last 1 commit")).toEqual({ kind: "last", n: 1 });
    expect(parseCommand("LAST 12 COMMITS")).toEqual({ kind: "last", n: 12 });
    expect(parseCommand("last 999 commits")).toEqual({ kind: "last", n: 250 });
  });

  it("parses pr shapes", () => {
    expect(parseCommand("what changed in pr #42")).toEqual({
      kind: "pr",
      num: 42,
    });
    expect(parseCommand("pr 42")).toEqual({ kind: "pr", num: 42 });
    expect(parseCommand("PR#7")).toEqual({ kind: "pr", num: 7 });
  });

  it("parses ranges, including dotted branch names", () => {
    expect(parseCommand("diff main..release")).toEqual({
      kind: "range",
      base: "main",
      head: "release",
    });
    expect(parseCommand("main...dev")).toEqual({
      kind: "range",
      base: "main",
      head: "dev",
    });
    expect(parseCommand("v1.2..main")).toEqual({
      kind: "range",
      base: "v1.2",
      head: "main",
    });
  });

  it("rejects everything else", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("explain everything")).toBeNull();
    expect(parseCommand("last commits")).toBeNull();
    expect(parseCommand("main..")).toBeNull();
  });
});
