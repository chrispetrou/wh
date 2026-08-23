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
    expect(parseCommand("summarize the last 5 commits")).toEqual({ kind: "last", n: 5 });
    expect(parseCommand("show me the last 3 commits")).toEqual({ kind: "last", n: 3 });
    expect(parseCommand("what changed in the last 5 commits")).toEqual({ kind: "last", n: 5 });
    expect(parseCommand("explain the last commit")).toEqual({ kind: "last", n: 1 });
    expect(parseCommand("last commit")).toEqual({ kind: "last", n: 1 });
  });

  it("parses pr shapes", () => {
    expect(parseCommand("what changed in pr #42")).toEqual({
      kind: "pr",
      num: 42,
    });
    expect(parseCommand("pr 42")).toEqual({ kind: "pr", num: 42 });
    expect(parseCommand("PR#7")).toEqual({ kind: "pr", num: 7 });
    expect(parseCommand("explain pr 42")).toEqual({ kind: "pr", num: 42 });
    expect(parseCommand("pull request 42")).toEqual({ kind: "pr", num: 42 });
    expect(parseCommand("#42")).toEqual({ kind: "pr", num: 42 });
    expect(parseCommand("what changed in pr #42?")).toEqual({ kind: "pr", num: 42 });
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
    expect(parseCommand("diff main..release and summarize")).toEqual({
      kind: "range",
      base: "main",
      head: "release",
    });
    expect(parseCommand("compare main..dev")).toEqual({
      kind: "range",
      base: "main",
      head: "dev",
    });
  });

  it("accepts cli-style input", () => {
    expect(parseCommand("wd explain HEAD~3..")).toEqual({ kind: "last", n: 3 });
    expect(parseCommand("HEAD~5..HEAD")).toEqual({ kind: "last", n: 5 });
    expect(parseCommand("wd explain")).toEqual({ kind: "last", n: 1 });
    expect(parseCommand("explain")).toEqual({ kind: "last", n: 1 });
    expect(parseCommand("last 4")).toEqual({ kind: "last", n: 4 });
    expect(parseCommand("wd explain main..dev")).toEqual({
      kind: "range",
      base: "main",
      head: "dev",
    });
    // open head means the default branch tip (resolved server-side)
    expect(parseCommand("main..")).toEqual({ kind: "range", base: "main", head: "" });
    expect(parseCommand("v1.2..HEAD")).toEqual({ kind: "range", base: "v1.2", head: "" });
  });

  it("rejects everything else", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("explain everything")).toBeNull();
    expect(parseCommand("last commits")).toBeNull();
    expect(parseCommand("wd ls")).toBeNull();
    expect(parseCommand("..main")).toBeNull();
  });
});
