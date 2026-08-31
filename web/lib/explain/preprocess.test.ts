import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  classify,
  defaultCaps,
  defaultRules,
  preprocess,
  stats,
} from "./preprocess";
import { prompt } from "./prompt";

const fixtures = resolve(__dirname, "../../../shared/fixtures/explain");

describe("preprocess", () => {
  it("classifies paths", () => {
    const rules = defaultRules();
    expect(classify("Cargo.lock", rules)).toBe("lockfile");
    expect(classify("web/package-lock.json", rules)).toBe("lockfile");
    expect(classify("a/node_modules/b/c.js", rules)).toBe("vendored");
    expect(classify("dist/app.min.js", rules)).toBe("minified");
    expect(classify("dist/app.js.map", rules)).toBe("generated");
    expect(classify("src/main.rs", rules)).toBeNull();
    // "vendor" must match a segment, not a substring
    expect(classify("src/vendors.rs", rules)).toBeNull();
  });

  it("handles binary numstat columns", () => {
    expect(stats("1\t2\ta.txt\n-\t-\tb.png\n")).toEqual({
      files: 2,
      added: 1,
      deleted: 2,
    });
    expect(stats("")).toEqual({ files: 0, added: 0, deleted: 0 });
  });

  it("reproduces every golden fixture byte for byte", () => {
    const rules = defaultRules();
    const dirs = readdirSync(fixtures)
      .map((d) => join(fixtures, d))
      .filter((d) => statSync(d).isDirectory())
      .sort();
    expect(dirs.length).toBeGreaterThanOrEqual(4);
    for (const dir of dirs) {
      const read = (name: string) => {
        const p = join(dir, name);
        return existsSync(p) ? readFileSync(p, "utf8") : "";
      };
      const caps = { ...defaultCaps };
      for (const line of read("params.txt").split("\n")) {
        const [k, v] = line.split("=");
        if (k === "per_file_cap") caps.perFile = parseInt(v, 10);
        if (k === "total_cap") caps.total = parseInt(v, 10);
      }
      const got = preprocess(
        read("input.diff"),
        read("input.commits"),
        read("input.numstat"),
        caps,
        rules
      );
      expect(got, `fixture ${dir}`).toBe(read("expected.txt"));
    }
  });
});

describe("prompt", () => {
  it("splits the template and substitutes the payload", () => {
    const { system, user } = prompt("PAYLOAD");
    expect(system).toContain("summary");
    expect(system).toContain("watch out");
    expect(system).not.toContain("{{payload}}");
    expect(user).toBe("PAYLOAD");
    // a diff with $& or $$ (make, bash, perl) reaches the model untouched
    const shell = "echo $$ && x=$'y' $& q";
    expect(prompt(shell).user).toBe(shell);
  });

  it("swaps the system prompt in changelog mode, same payload", () => {
    const { system, user } = prompt("PAYLOAD", "changelog");
    for (const label of ["added", "changed", "fixed", "removed"]) {
      expect(system).toContain(`\n${label}\n`);
    }
    expect(system).not.toContain("watch out");
    expect(user).toBe("PAYLOAD");
  });

  it("swaps the system prompt in describe mode for a pr draft", () => {
    const { system, user } = prompt("PAYLOAD", "describe");
    for (const label of ["title", "description", "testing"]) {
      expect(system).toContain(`\n${label}\n`);
    }
    expect(system).toContain("pull request");
    expect(system).not.toContain("watch out");
    expect(system).not.toContain("release notes");
    expect(user).toBe("PAYLOAD");
  });

  it("has a why section for line archaeology", () => {
    const { system } = prompt("PAYLOAD", "why");
    expect(system).toContain("\nwhy\n");
    expect(system).toContain("\nwatch out\n");
    expect(system).not.toContain("summary");
  });
});
