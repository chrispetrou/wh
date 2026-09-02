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

  it("parses branch-scoped and branches shapes", () => {
    expect(parseCommand("explain the last 5 commits on dev")).toEqual({
      kind: "last",
      n: 5,
      ref: "dev",
    });
    expect(parseCommand("last 3 on feat/auth")).toEqual({
      kind: "last",
      n: 3,
      ref: "feat/auth",
    });
    expect(parseCommand("branches")).toEqual({ kind: "branches" });
    expect(parseCommand("wh branches")).toEqual({ kind: "branches" });
    expect(parseCommand("list branches")).toEqual({ kind: "branches" });
    expect(parseCommand("what changed in feat/multi_turn")).toEqual({
      kind: "range",
      base: "",
      head: "feat/multi_turn",
    });
    expect(parseCommand("what changed on dev?")).toEqual({
      kind: "range",
      base: "",
      head: "dev",
    });
    // a bare "pr" with no number stays unparsed for the client nudge
    expect(parseCommand("what changed in pr")).toBeNull();
  });

  it("accepts cli-style input", () => {
    expect(parseCommand("wh explain HEAD~3..")).toEqual({ kind: "last", n: 3 });
    expect(parseCommand("HEAD~5..HEAD")).toEqual({ kind: "last", n: 5 });
    expect(parseCommand("wh explain")).toEqual({ kind: "last", n: 1 });
    expect(parseCommand("explain")).toEqual({ kind: "last", n: 1 });
    expect(parseCommand("last 4")).toEqual({ kind: "last", n: 4 });
    expect(parseCommand("wh explain main..dev")).toEqual({
      kind: "range",
      base: "main",
      head: "dev",
    });
    // open head means the default branch tip (resolved server-side)
    expect(parseCommand("main..")).toEqual({ kind: "range", base: "main", head: "" });
    expect(parseCommand("v1.2..HEAD")).toEqual({ kind: "range", base: "v1.2", head: "" });
  });

  it("parses log shapes", () => {
    expect(parseCommand("log")).toEqual({ kind: "log" });
    expect(parseCommand("graph")).toEqual({ kind: "log" });
    expect(parseCommand("git log")).toEqual({ kind: "log" });
    expect(parseCommand("show the log")).toBeNull(); // "the" is not a ref
    expect(parseCommand("show log")).toEqual({ kind: "log" });
    expect(parseCommand("log 50")).toEqual({ kind: "log", n: 50 });
    expect(parseCommand("log 999")).toEqual({ kind: "log", n: 200 });
    expect(parseCommand("log on dev")).toEqual({ kind: "log", ref: "dev" });
    expect(parseCommand("graph 20 on feat/x")).toEqual({ kind: "log", n: 20, ref: "feat/x" });
    // history is a file's story, never the graph
    expect(parseCommand("history")).toBeNull();
  });

  it("parses log filters: one author, a window, either order", () => {
    expect(parseCommand("log by alice")).toEqual({ kind: "log", author: "alice" });
    expect(parseCommand("log 100 by me")).toEqual({ kind: "log", n: 100, author: "me" });
    expect(parseCommand("git log by Me")).toEqual({ kind: "log", author: "me" });
    expect(parseCommand("log on dev by renovate[bot]")).toEqual({
      kind: "log",
      ref: "dev",
      author: "renovate[bot]",
    });
    expect(parseCommand("log since yesterday")).toEqual({ kind: "log", since: "yesterday" });
    expect(parseCommand("graph since Monday")).toEqual({ kind: "log", since: "monday" });
    expect(parseCommand("log since 3 days ago")).toEqual({ kind: "log", since: "3 days ago" });
    expect(parseCommand("log since v1.2")).toEqual({ kind: "log", since: "v1.2" });
    expect(parseCommand("log 50 since this week by alice")).toEqual({
      kind: "log",
      n: 50,
      since: "this week",
      author: "alice",
    });
    expect(parseCommand("log by alice since 3 days ago")).toEqual({
      kind: "log",
      since: "3 days ago",
      author: "alice",
    });
    expect(parseCommand("log 20 on dev since 2026-08-20 by me")).toEqual({
      kind: "log",
      n: 20,
      ref: "dev",
      since: "2026-08-20",
      author: "me",
    });
    // a leading verb is not a path called log
    expect(parseCommand("show log since yesterday")).toEqual({ kind: "log", since: "yesterday" });
    expect(parseCommand("explain log since v1.2")).toEqual({ kind: "log", since: "v1.2" });
    // `on` belongs before the filters; a ref is one word, never a range
    expect(parseCommand("log since v1.2 on dev")).toBeNull();
    expect(parseCommand("log since the merge")).toBeNull();
    expect(parseCommand("log since main..dev")).toBeNull();
    expect(parseCommand("log by")).toBeNull();
    expect(parseCommand("log by alice by bob")).toBeNull();
    // the log is not a diff, so changelog and paths keep rejecting it
    expect(parseCommand("changelog log since v1.2")).toBeNull();
    expect(parseCommand("log by alice in src")).toBeNull();
    // the since command is untouched
    expect(parseCommand("since yesterday by alice")).toEqual({
      kind: "since",
      period: "yesterday",
      author: "alice",
    });
  });

  it("parses commits by sha and by log row", () => {
    expect(parseCommand("explain a1b2c3d")).toEqual({ kind: "commit", sha: "a1b2c3d" });
    expect(parseCommand("A1B2C3D")).toEqual({ kind: "commit", sha: "a1b2c3d" });
    expect(parseCommand("show me 40cce0c2a1")).toEqual({ kind: "commit", sha: "40cce0c2a1" });
    expect(parseCommand("explain 3")).toEqual({ kind: "row", from: 3 });
    expect(parseCommand("3")).toEqual({ kind: "row", from: 3 });
    expect(parseCommand("explain 2..5")).toEqual({ kind: "row", from: 2, to: 5 });
    expect(parseCommand("5..2")).toEqual({ kind: "row", from: 2, to: 5 });
    // six hex chars is too short to be a sha, and not a row either
    expect(parseCommand("abc123")).toBeNull();
    // sha ranges are plain ranges
    expect(parseCommand("a1b2c3d..40cce0c")).toEqual({
      kind: "range",
      base: "a1b2c3d",
      head: "40cce0c",
    });
  });

  it("parses periods, refs, and authors", () => {
    expect(parseCommand("since yesterday")).toEqual({ kind: "since", period: "yesterday" });
    expect(parseCommand("what changed since Monday")).toEqual({
      kind: "since",
      period: "monday",
    });
    expect(parseCommand("explain this week")).toEqual({ kind: "since", period: "this week" });
    expect(parseCommand("yesterday")).toEqual({ kind: "since", period: "yesterday" });
    expect(parseCommand("since 2026-08-20")).toEqual({ kind: "since", period: "2026-08-20" });
    expect(parseCommand("since v1.2")).toEqual({ kind: "since", period: "v1.2" });
    expect(parseCommand("commits since last week by alice")).toEqual({
      kind: "since",
      period: "last week",
      author: "alice",
    });
    expect(parseCommand("what did i do this week")).toEqual({
      kind: "since",
      period: "this week",
      author: "me",
    });
    expect(parseCommand("my commits since v1.2")).toEqual({
      kind: "since",
      period: "v1.2",
      author: "me",
    });
    expect(parseCommand("standup")).toEqual({ kind: "since", period: "standup", author: "me" });
    expect(parseCommand("since 3 days ago")).toEqual({ kind: "since", period: "3 days ago" });
    // a bare ref is not a command, and "since" wants one word for a ref
    expect(parseCommand("main")).toBeNull();
    expect(parseCommand("since the merge")).toBeNull();
    expect(parseCommand("since main..dev")).toBeNull();
  });

  it("parses describe mode", () => {
    expect(parseCommand("describe pr 42")).toEqual({ kind: "pr", num: 42, mode: "describe" });
    expect(parseCommand("pr description for #42")).toEqual({ kind: "pr", num: 42, mode: "describe" });
    expect(parseCommand("wh describe pr 42")).toEqual({ kind: "pr", num: 42, mode: "describe" });
    expect(parseCommand("describe feat/auth")).toEqual({
      kind: "range",
      base: "",
      head: "feat/auth",
      mode: "describe",
    });
    expect(parseCommand("draft a pr for main..dev")).toEqual({
      kind: "range",
      base: "main",
      head: "dev",
      mode: "describe",
    });
    expect(parseCommand("describe the last 3 commits")).toEqual({ kind: "last", n: 3, mode: "describe" });
    expect(parseCommand("describe pr 42 in docs/")).toEqual({
      kind: "pr",
      num: 42,
      path: "docs/",
      mode: "describe",
    });
    expect(parseCommand("describe 3")).toEqual({ kind: "row", from: 3, mode: "describe" });
    // needs a target, and lookups have no diff to draft from
    expect(parseCommand("describe")).toBeNull();
    expect(parseCommand("describe branches")).toBeNull();
    expect(parseCommand("describe log")).toBeNull();
  });

  it("parses changelog mode and tags", () => {
    expect(parseCommand("changelog")).toEqual({
      kind: "since",
      period: "latest tag",
      mode: "changelog",
    });
    expect(parseCommand("changelog v1.1..v1.2")).toEqual({
      kind: "range",
      base: "v1.1",
      head: "v1.2",
      mode: "changelog",
    });
    expect(parseCommand("release notes for pr 42")).toEqual({
      kind: "pr",
      num: 42,
      mode: "changelog",
    });
    expect(parseCommand("changelog since v1.2")).toEqual({
      kind: "since",
      period: "v1.2",
      mode: "changelog",
    });
    expect(parseCommand("changelog of the last 10 commits")).toEqual({
      kind: "last",
      n: 10,
      mode: "changelog",
    });
    // a lookup cannot be framed as release notes
    expect(parseCommand("changelog branches")).toBeNull();
    expect(parseCommand("tags")).toEqual({ kind: "tags" });
    expect(parseCommand("list tags")).toEqual({ kind: "tags" });
  });

  it("parses pull request lists", () => {
    expect(parseCommand("prs")).toEqual({ kind: "prs", state: "open" });
    expect(parseCommand("open pull requests")).toEqual({ kind: "prs", state: "open" });
    expect(parseCommand("closed prs")).toEqual({ kind: "prs", state: "closed" });
    expect(parseCommand("prs closed")).toEqual({ kind: "prs", state: "closed" });
    expect(parseCommand("my prs")).toEqual({ kind: "prs", state: "mine" });
    expect(parseCommand("prs mine")).toEqual({ kind: "prs", state: "mine" });
    expect(parseCommand("changelog prs")).toBeNull();
  });

  it("parses stale branches", () => {
    expect(parseCommand("stale")).toEqual({ kind: "stale" });
    expect(parseCommand("stale branches")).toEqual({ kind: "stale" });
    expect(parseCommand("stale 12w")).toEqual({ kind: "stale", weeks: 12 });
    expect(parseCommand("stale 2 weeks")).toEqual({ kind: "stale", weeks: 2 });
    expect(parseCommand("stale since 2026-06-01")).toEqual({
      kind: "stale",
      since: "2026-06-01",
    });
    expect(parseCommand("stale since last week")).toEqual({
      kind: "stale",
      since: "last week",
    });
    // a ref is not a cutoff date
    expect(parseCommand("stale since v1.2")).toBeNull();
    expect(parseCommand("changelog stale")).toBeNull();
  });

  it("parses activity", () => {
    expect(parseCommand("activity")).toEqual({ kind: "activity" });
    expect(parseCommand("activity since this week")).toEqual({
      kind: "activity",
      since: "this week",
    });
    expect(parseCommand("activity since 12w")).toEqual({ kind: "activity", since: "12w" });
    // weekly buckets only cut on a period, never a ref
    expect(parseCommand("activity since v1.2")).toBeNull();
    expect(parseCommand("changelog activity")).toBeNull();
  });

  it("parses churn with its filters in any order", () => {
    expect(parseCommand("churn")).toEqual({ kind: "churn" });
    expect(parseCommand("hotspots")).toEqual({ kind: "churn" });
    expect(parseCommand("churn since v1.2")).toEqual({ kind: "churn", since: "v1.2" });
    expect(parseCommand("churn since this week")).toEqual({ kind: "churn", since: "this week" });
    expect(parseCommand("churn on dev in src since v1.2")).toEqual({
      kind: "churn",
      ref: "dev",
      path: "src",
      since: "v1.2",
    });
    expect(parseCommand("hotspots in src/lib on main")).toEqual({
      kind: "churn",
      ref: "main",
      path: "src/lib",
    });
    // a period typo or a range is not a window
    expect(parseCommand("churn since the merge")).toBeNull();
    expect(parseCommand("churn since main..dev")).toBeNull();
    expect(parseCommand("changelog churn")).toBeNull();
  });

  it("parses view, cat, and ls", () => {
    expect(parseCommand("view src/git.rs")).toEqual({ kind: "view", path: "src/git.rs" });
    expect(parseCommand("cat src/git.rs")).toEqual({ kind: "view", path: "src/git.rs" });
    expect(parseCommand("view src/git.rs:42")).toEqual({
      kind: "view",
      path: "src/git.rs",
      line: 42,
    });
    expect(parseCommand("view src/git.rs:42 on dev")).toEqual({
      kind: "view",
      path: "src/git.rs",
      line: 42,
      ref: "dev",
    });
    expect(parseCommand("view")).toBeNull();
    expect(parseCommand("view a b")).toBeNull();
    expect(parseCommand("changelog view src")).toBeNull();
    expect(parseCommand("ls")).toEqual({ kind: "ls" });
    expect(parseCommand("ls src")).toEqual({ kind: "ls", dir: "src" });
    expect(parseCommand("ls src on dev")).toEqual({ kind: "ls", dir: "src", ref: "dev" });
    // the worktree commands belong to the cli, so their hint survives
    expect(parseCommand("wh ls")).toBeNull();
    expect(parseCommand("wh new feat/x")).toBeNull();
    expect(parseCommand("wh switch")).toBeNull();
    expect(parseCommand("wh rm old")).toBeNull();
    expect(parseCommand("wh explain")).toEqual({ kind: "last", n: 1 });
  });

  it("parses who", () => {
    expect(parseCommand("who src/git.rs")).toEqual({ kind: "who", path: "src/git.rs" });
    expect(parseCommand("who knows src/git.rs")).toEqual({ kind: "who", path: "src/git.rs" });
    expect(parseCommand("who touched src on dev")).toEqual({
      kind: "who",
      path: "src",
      ref: "dev",
    });
    expect(parseCommand("who")).toBeNull();
    expect(parseCommand("changelog who src")).toBeNull();
  });

  it("parses history, path cuts, and why", () => {
    expect(parseCommand("history src/git.rs")).toEqual({ kind: "history", path: "src/git.rs" });
    expect(parseCommand("history of src on dev")).toEqual({
      kind: "history",
      path: "src",
      ref: "dev",
    });
    expect(parseCommand("history on dev")).toBeNull();

    expect(parseCommand("explain the last 5 commits in src/git.rs")).toEqual({
      kind: "last",
      n: 5,
      path: "src/git.rs",
    });
    expect(parseCommand("last 3 on dev in src")).toEqual({
      kind: "last",
      n: 3,
      ref: "dev",
      path: "src",
    });
    expect(parseCommand("what changed in src/git.rs since v1.2")).toEqual({
      kind: "since",
      period: "v1.2",
      path: "src/git.rs",
    });
    expect(parseCommand("explain src/git.rs main..dev")).toEqual({
      kind: "range",
      base: "main",
      head: "dev",
      path: "src/git.rs",
    });
    expect(parseCommand("changelog of pr 42 in docs/")).toEqual({
      kind: "pr",
      num: 42,
      mode: "changelog",
      path: "docs/",
    });
    expect(parseCommand("explain 3 in src")).toEqual({ kind: "row", from: 3, path: "src" });
    // the branch and pr forms keep their meaning
    expect(parseCommand("what changed in feat/x")).toEqual({
      kind: "range",
      base: "",
      head: "feat/x",
    });
    expect(parseCommand("what changed in pr #42")).toEqual({ kind: "pr", num: 42 });
    expect(parseCommand("branches in src")).toBeNull();

    expect(parseCommand("why src/git.rs:42")).toEqual({
      kind: "why",
      path: "src/git.rs",
      line: 42,
    });
    expect(parseCommand("why line 7 of README.md on dev")).toEqual({
      kind: "why",
      path: "README.md",
      line: 7,
      ref: "dev",
    });
    expect(parseCommand("why src/git.rs:13-17")).toEqual({
      kind: "why",
      path: "src/git.rs",
      line: 13,
      to: 17,
    });
    // a span reads low to high whichever way it was typed; dots work too
    expect(parseCommand("why src/git.rs:17-13 on dev")).toEqual({
      kind: "why",
      path: "src/git.rs",
      line: 13,
      to: 17,
      ref: "dev",
    });
    expect(parseCommand("why src/git.rs:13..17")).toEqual({
      kind: "why",
      path: "src/git.rs",
      line: 13,
      to: 17,
    });
    expect(parseCommand("why lines 13-17 of src/git.rs")).toEqual({
      kind: "why",
      path: "src/git.rs",
      line: 13,
      to: 17,
    });
    expect(parseCommand("why src/git.rs:13-13")).toEqual({
      kind: "why",
      path: "src/git.rs",
      line: 13,
    });
    expect(parseCommand("why")).toBeNull();
  });

  it("parses rebase plans over ranges, branches, prs, last n, and rows", () => {
    expect(parseCommand("rebase main..feat/x")).toEqual({
      kind: "plan",
      source: { kind: "range", base: "main", head: "feat/x" },
    });
    expect(parseCommand("rebase feat/x")).toEqual({
      kind: "plan",
      source: { kind: "range", base: "", head: "feat/x" },
    });
    expect(parseCommand("rebase pr #42")).toEqual({ kind: "plan", source: { kind: "pr", num: 42 } });
    expect(parseCommand("REBASE #7")).toEqual({ kind: "plan", source: { kind: "pr", num: 7 } });
    expect(parseCommand("rebase last 3 on feat/x")).toEqual({
      kind: "plan",
      source: { kind: "last", n: 3, ref: "feat/x" },
    });
    expect(parseCommand("rebase 2..5")).toEqual({ kind: "plan", source: { kind: "row", from: 2, to: 5 } });
    expect(parseCommand("wh rebase 3")).toEqual({ kind: "plan", source: { kind: "row", from: 3 } });
    // no source, a single sha, a window, a lookup, a mode, a path
    expect(parseCommand("rebase")).toBeNull();
    expect(parseCommand("rebase a1b2c3d")).toBeNull();
    expect(parseCommand("rebase since yesterday")).toBeNull();
    expect(parseCommand("rebase log")).toBeNull();
    expect(parseCommand("rebase changelog pr 4")).toBeNull();
    expect(parseCommand("rebase feat/x in src")).toBeNull();
    expect(parseCommand("changelog rebase feat/x")).toBeNull();
    expect(parseCommand("describe rebase feat/x")).toBeNull();
  });

  it("parses cherry-pick plans", () => {
    expect(parseCommand("pick 3 5 onto release/1.x")).toEqual({
      kind: "pick",
      onto: "release/1.x",
      rows: [3, 5],
    });
    expect(parseCommand("cherry-pick 3, 4 onto main")).toEqual({ kind: "pick", onto: "main", rows: [3, 4] });
    expect(parseCommand("pick A1B2C3D 1234567 onto main")).toEqual({
      kind: "pick",
      onto: "main",
      shas: ["a1b2c3d", "1234567"],
    });
    expect(parseCommand("pick pr #42 onto release/1.x")).toEqual({ kind: "pick", onto: "release/1.x", pr: 42 });
    expect(parseCommand("backport pr 42 to release/1.x")).toEqual({ kind: "pick", onto: "release/1.x", pr: 42 });
    expect(parseCommand("backport #42 to main")).toEqual({ kind: "pick", onto: "main", pr: 42 });
    // mixed tokens, a range target, nothing to pick
    expect(parseCommand("pick 3 a1b2c3d onto main")).toBeNull();
    expect(parseCommand("pick 3 onto main..dev")).toBeNull();
    expect(parseCommand("pick onto main")).toBeNull();
    expect(parseCommand("pick 3 5")).toBeNull();
  });

  it("parses the hidden message command", () => {
    expect(parseCommand("message a1b2c3d")).toEqual({ kind: "message", shas: ["a1b2c3d"] });
    expect(parseCommand("message A1B2C3D 1234567")).toEqual({ kind: "message", shas: ["a1b2c3d", "1234567"] });
    expect(parseCommand("message 3")).toBeNull();
    expect(parseCommand(`message ${Array(11).fill("a1b2c3d").join(" ")}`)).toBeNull();
    expect(parseCommand("changelog message a1b2c3d")).toBeNull();
  });

  it("rejects everything else", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("explain everything")).toBeNull();
    expect(parseCommand("last commits")).toBeNull();
    expect(parseCommand("wh ls")).toBeNull();
    expect(parseCommand("..main")).toBeNull();
  });
});
