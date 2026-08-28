import { describe, expect, it } from "vitest";
import { filterDiff } from "./filter";

const DIFF = [
  "diff --git a/src/git.rs b/src/git.rs",
  "--- a/src/git.rs",
  "+++ b/src/git.rs",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/src/main.rs b/src/main.rs",
  "+++ b/src/main.rs",
  "+x",
  "diff --git a/README.md b/README.md",
  "+++ b/README.md",
  "+y",
  "",
].join("\n");
const NUMSTAT = "1\t1\tsrc/git.rs\n1\t0\tsrc/main.rs\n1\t0\tREADME.md";

describe("filterDiff", () => {
  it("keeps one file", () => {
    const f = filterDiff(DIFF, NUMSTAT, "src/git.rs");
    expect(f.diff).toBe(
      "diff --git a/src/git.rs b/src/git.rs\n--- a/src/git.rs\n+++ b/src/git.rs\n@@ -1 +1 @@\n-a\n+b\n"
    );
    expect(f.numstat).toBe("1\t1\tsrc/git.rs");
    expect([f.kept, f.total]).toEqual([1, 3]);
  });

  it("keeps a directory, with or without the trailing slash", () => {
    for (const p of ["src", "src/"]) {
      const f = filterDiff(DIFF, NUMSTAT, p);
      expect(f.kept).toBe(2);
      expect(f.diff).toContain("b/src/main.rs");
      expect(f.diff).not.toContain("README");
      expect(f.numstat.split("\n")).toHaveLength(2);
    }
  });

  it("does not match a path prefix that is not a directory", () => {
    const f = filterDiff(DIFF, NUMSTAT, "src/git");
    expect(f.kept).toBe(0);
    expect(f.diff).toBe("");
    expect(f.numstat).toBe("");
  });
});
