import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitDetail,
  commitInput,
  historyBlock,
  latestTag,
  logBlock,
  prFlags,
  prInput,
  prsBlock,
  sinceInput,
  tagsText,
  whyInput,
} from "./github";

// a tiny github: main = M(A, F) > A > C, feat = F > C, tag v1 on C
const SHA = (c: string) => c.repeat(40);
function commit(sha: string, parents: string[], subject: string, date: string) {
  return {
    sha: SHA(sha),
    parents: parents.map((p) => ({ sha: SHA(p) })),
    commit: { message: `${subject}\n\nbody`, committer: { date }, author: { name: "Chris" } },
    author: { login: "chris" },
  };
}
const M = commit("m", ["a", "f"], "merge feat", "2026-08-27T05:00:00Z");
const A = commit("a", ["c"], "add a", "2026-08-27T04:00:00Z");
const F = commit("f", ["c"], "add f", "2026-08-27T03:00:00Z");
const C = commit("c", [], "init", "2026-08-27T01:00:00Z");

function stub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const path = url.replace("https://api.github.com", "");
      calls.push(path);
      const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + "?"));
      if (!key) return new Response("{}", { status: 404 });
      const body = routes[key];
      if (init?.headers?.accept === "application/vnd.github.diff") {
        return new Response(String((body as { diff?: string }).diff ?? ""), { status: 200 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("logBlock", () => {
  it("unions branch walks, draws the graph, decorates heads and tags", async () => {
    const calls = stub({
      "/repos/o/r": { default_branch: "main" },
      "/repos/o/r/branches": [
        { name: "feat", commit: { sha: SHA("f") } },
        { name: "main", commit: { sha: SHA("m") } },
      ],
      "/repos/o/r/tags": [{ name: "v1", commit: { sha: SHA("c") } }],
      "/repos/o/r/commits": [],
    });
    // the commits route answers per branch
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      calls.push(path);
      if (path === "/repos/o/r") return Response.json({ default_branch: "main" });
      if (path.startsWith("/repos/o/r/branches"))
        return Response.json([
          { name: "feat", commit: { sha: SHA("f") } },
          { name: "main", commit: { sha: SHA("m") } },
        ]);
      if (path.startsWith("/repos/o/r/tags"))
        return Response.json([{ name: "v1", commit: { sha: SHA("c") } }]);
      if (path.startsWith("/repos/o/r/commits?")) {
        const sha = new URL(url).searchParams.get("sha");
        return Response.json(sha === "main" ? [M, A, F, C] : [F, C]);
      }
      return new Response("{}", { status: 404 });
    });

    const log = await logBlock("t", "o", "r", 40);
    const b = log.block;
    if (b.kind !== "log") throw new Error("expected a log block");
    expect(b.lanes).toBe(2);
    expect(b.footer).toEqual(["4 commits · 2 branches"]);
    expect(b.rows.map((r) => [r.sha[0], r.subject, r.author, r.graph!.lane, r.graph!.merge])).toEqual([
      ["m", "merge feat", "chris", 0, true],
      ["a", "add a", "chris", 0, false],
      ["f", "add f", "chris", 1, false],
      ["c", "init", "chris", 0, false],
    ]);
    expect(b.rows[0].refs).toEqual([{ name: "main", kind: "default" }]);
    expect(b.rows[2].refs).toEqual([{ name: "feat", kind: "branch" }]);
    expect(b.rows[3].refs).toEqual([{ name: "v1", kind: "tag" }]);
    expect(b.rows[0].date).toBe("2026-08-27T05:00:00Z");
    expect(log.rows.map((r) => [r.sha[0], r.parent?.[0] ?? null, r.subject])).toEqual([
      ["m", "a", "merge feat"],
      ["a", "c", "add a"],
      ["f", "c", "add f"],
      ["c", null, "init"],
    ]);
    // the default branch is walked first, per_page is the row budget
    const walks = calls.filter((c) => c.startsWith("/repos/o/r/commits?"));
    expect(walks[0]).toContain("per_page=40&sha=main");
    expect(walks[1]).toContain("sha=feat");
  });

  it("scopes to one branch with `on` and says so in the footer", async () => {
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      if (path === "/repos/o/r") return Response.json({ default_branch: "main" });
      if (path.startsWith("/repos/o/r/branches"))
        return Response.json([{ name: "main", commit: { sha: SHA("m") } }]);
      if (path.startsWith("/repos/o/r/tags")) return Response.json([]);
      if (path.startsWith("/repos/o/r/commits?")) {
        const sha = new URL(url).searchParams.get("sha");
        return sha === "feat" ? Response.json([F, C]) : new Response("{}", { status: 404 });
      }
      return new Response("{}", { status: 404 });
    });
    const log = await logBlock("t", "o", "r", 10, "feat");
    expect(log.block.footer).toEqual(["2 commits on feat"]);
    expect(log.block.rows).toHaveLength(2);
    await expect(logBlock("t", "o", "r", 10, "nope")).rejects.toThrow("branch nope not found");
  });
});

describe("sinceInput", () => {
  const NOW = Date.parse("2026-08-27T12:00:00Z");
  const commitRoute = (url: string, list: unknown[]) => {
    const path = url.replace("https://api.github.com", "");
    if (path === "/repos/o/r") return Response.json({ default_branch: "main" });
    if (path.startsWith("/repos/o/r/commits?")) return Response.json(list);
    return null;
  };

  it("turns a period into a compare from the oldest commit's parent", async () => {
    const calls = stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push(url);
      const r = commitRoute(url, [A, F]);
      if (r) return r;
      if (url.includes("/compare/")) {
        return url.includes("diff")
          ? new Response("diff --git a/x b/x\n")
          : Response.json({ total_commits: 2, commits: [A, F], files: [] });
      }
      return Response.json({ total_commits: 2, commits: [A, F], files: [] });
    });
    const r = await sinceInput("t", "o", "r", { period: "yesterday", login: "me", now: NOW, tz: 0 });
    expect("empty" in r).toBe(false);
    const list = calls.find((c) => c.includes("/commits?"))!;
    expect(list).toContain("sha=main");
    expect(list).toContain("since=2026-08-26T00%3A00%3A00.000Z");
    expect(list).toContain("until=2026-08-27T00%3A00%3A00.000Z");
    // F is the oldest, its parent C opens the range
    expect(calls.some((c) => c.includes(`/compare/${SHA("c")}...${SHA("a")}`))).toBe(true);
  });

  it("says so when the window is empty, without a compare", async () => {
    const calls = stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push(url);
      return commitRoute(url, []) ?? new Response("{}", { status: 404 });
    });
    const r = await sinceInput("t", "o", "r", {
      period: "this week",
      author: "me",
      login: "chris",
      now: NOW,
      tz: 0,
    });
    expect(r).toEqual({ empty: "nothing this week by chris" });
    expect(calls.find((c) => c.includes("/commits?"))).toContain("author=chris");
    expect(calls.some((c) => c.includes("/compare/"))).toBe(false);
  });

  it("fetches one author's commits one by one and merges the stats", async () => {
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: { headers?: Record<string, string> }) => {
        const r = commitRoute(url, [A, F]);
        if (r) return r;
        if (url.includes("/commits/")) {
          const sha = url.split("/commits/")[1];
          const c = sha === SHA("a") ? A : F;
          if (init?.headers?.accept === "application/vnd.github.diff") {
            return new Response(`diff --git a/${sha[0]} b/${sha[0]}\n`);
          }
          return Response.json({
            ...c,
            files: [{ filename: "shared.ts", additions: 1, deletions: 2 }],
          });
        }
        return new Response("{}", { status: 404 });
      }
    );
    const r = await sinceInput("t", "o", "r", {
      period: "yesterday",
      author: "alice",
      login: "me",
      now: NOW,
      tz: 0,
    });
    if ("empty" in r) throw new Error("expected an input");
    expect(r.commitCount).toBe(2);
    expect(r.commits).toBe(`${"a".repeat(7)} add a\n${"f".repeat(7)} add f`);
    expect(r.numstat).toBe("2\t4\tshared.ts");
    expect(r.diff).toBe("diff --git a/a b/a\ndiff --git a/f b/f\n");
    expect(r.note).toBe("2 commits by alice, yesterday");
  });

  it("treats a ref without an author as a plain compare", async () => {
    const calls = stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/repos/o/r")) return Response.json({ default_branch: "main" });
      return url.includes("diff")
        ? new Response("")
        : Response.json({ total_commits: 0, commits: [], files: [] });
    });
    await sinceInput("t", "o", "r", { period: "v1.2", login: "me", now: NOW, tz: 0 });
    expect(calls.some((c) => c.includes("/compare/v1.2...main"))).toBe(true);
  });
});

describe("tagsText", () => {
  it("orders tags by commit date and pads the name column", async () => {
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes("/tags"))
        return Response.json([
          { name: "v1.10", commit: { sha: SHA("a") } },
          { name: "v1.9", commit: { sha: SHA("c") } },
          { name: "v2.0", commit: { sha: SHA("m") } },
        ]);
      if (url.includes(`/commits/${SHA("a")}`)) return Response.json(A);
      if (url.includes(`/commits/${SHA("c")}`)) return Response.json(C);
      if (url.includes(`/commits/${SHA("m")}`)) return Response.json(M);
      return new Response("{}", { status: 404 });
    });
    expect((await tagsText("t", "o", "r")).split("\n")).toEqual([
      `1\tv2.0   \t${"m".repeat(7)}\t2026-08-27T05:00:00Z`,
      `2\tv1.10  \t${"a".repeat(7)}\t2026-08-27T04:00:00Z`,
      `3\tv1.9   \t${"c".repeat(7)}\t2026-08-27T01:00:00Z`,
      "3 tags",
      "",
    ]);
    expect(await latestTag("t", "o", "r")).toBe("v2.0");
  });
});

describe("prs", () => {
  const pr = (number: number, login: string, extra: Record<string, unknown> = {}) => ({
    number,
    title: `pr ${number}`,
    draft: false,
    state: "open",
    merged_at: null,
    updated_at: "2026-08-27T04:00:00Z",
    user: { login },
    head: { ref: `feat/${number}` },
    base: { ref: "main" },
    ...extra,
  });

  it("lists prs as a block with state words", async () => {
    const calls = stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push(url);
      return Response.json([pr(12, "alice", { draft: true }), pr(7, "bob")]);
    });
    const { block, rows } = await prsBlock("t", "o", "r", "open", "me");
    if (block.kind !== "prs") throw new Error("expected a prs block");
    expect(block.rows).toEqual([
      {
        num: 12,
        title: "pr 12",
        author: "alice",
        head: "feat/12",
        base: "main",
        updated: "2026-08-27T04:00:00Z",
        flags: ["draft"],
      },
      {
        num: 7,
        title: "pr 7",
        author: "bob",
        head: "feat/7",
        base: "main",
        updated: "2026-08-27T04:00:00Z",
        flags: [],
      },
    ]);
    expect(block.footer).toEqual(["2 open prs"]);
    expect(rows).toEqual([
      { num: 12, title: "pr 12" },
      { num: 7, title: "pr 7" },
    ]);
    expect(calls[0]).toContain("state=open");
    expect(calls[0]).toContain("sort=updated");
  });

  it("filters mine across all states and marks merged ones", async () => {
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      Response.json([
        pr(3, "me", { state: "closed", merged_at: "2026-08-20T00:00:00Z" }),
        pr(2, "other"),
        pr(1, "me", { state: "closed" }),
      ])
    );
    const { block } = await prsBlock("t", "o", "r", "mine", "me");
    expect(block.rows.map((r) => [(r as { num: number }).num, (r as { flags: string[] }).flags])).toEqual([
      [3, ["merged"]],
      [1, ["closed"]],
    ]);
    expect(block.footer).toEqual(["2 prs by me"]);
  });

  it("puts the mergeable state in the pr explain note", async () => {
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.endsWith("/commits?per_page=100")) return Response.json([A]);
        if (init?.headers?.accept === "application/vnd.github.diff") {
          return new Response("diff --git a/x b/x\n+++ b/x\n+1\n");
        }
        return Response.json({
          title: "t",
          additions: 1,
          deletions: 0,
          changed_files: 1,
          commits: 1,
          draft: true,
          state: "open",
          merged: false,
          mergeable: false,
        });
      }
    );
    const input = await prInput("t", "o", "r", 5);
    expect(input.note).toBe("draft · conflicts with base");
    expect(prFlags({ draft: false, state: "open", merged: false, mergeable: null })).toEqual([]);
    expect(prFlags({ draft: false, state: "open", merged: false, mergeable: true })).toEqual([
      "mergeable",
    ]);
  });
});

describe("historyBlock", () => {
  it("lists the commits touching a path as a rail-less log block", async () => {
    const calls = stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push(url);
      return Response.json([A, { ...C, author: { login: "bo" } }]);
    });
    const h = await historyBlock("t", "o", "r", "src/a.ts", "dev");
    expect(calls[0]).toContain("path=src%2Fa.ts");
    expect(calls[0]).toContain("sha=dev");
    if (h.block.kind !== "log") throw new Error("expected a log block");
    expect(h.block.lanes).toBe(0);
    expect(h.block.rows.map((r) => [r.sha[0], r.subject, r.author, r.graph])).toEqual([
      ["a", "add a", "chris", undefined],
      ["c", "init", "bo", undefined],
    ]);
    expect(h.block.footer).toEqual(["2 commits touching src/a.ts on dev"]);
    expect(h.rows[1]).toEqual({ sha: SHA("c"), parent: null, subject: "init" });
  });

  it("says when nothing touches the path", async () => {
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => Response.json([]));
    const h = await historyBlock("t", "o", "r", "nope.txt");
    expect(h.block.rows).toEqual([]);
    expect(h.block.footer).toEqual(["no commits touch nope.txt"]);
    expect(h.rows).toEqual([]);
  });
});

describe("commitDetail", () => {
  it("shapes one commit for the expanded row", async () => {
    stub({
      "/repos/o/r/commits/a1b2c3d": {
        ...A,
        html_url: "https://github.com/o/r/commit/a1b2c3d",
        files: [{ filename: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
      },
    });
    const d = await commitDetail("t", "o", "r", "a1b2c3d");
    expect(d).toEqual({
      kind: "commit",
      sha: SHA("a"),
      parents: [SHA("c")],
      author: { login: "chris", name: "Chris", date: "2026-08-27T04:00:00Z" },
      committer: { name: "", date: "2026-08-27T04:00:00Z" },
      message: "add a\n\nbody",
      url: "https://github.com/o/r/commit/a1b2c3d",
      files: [{ path: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
    });
  });
});

describe("whyInput", () => {
  const file = "one\ntwo\nthree\n";
  const blame = {
    data: {
      repository: {
        object: {
          blame: {
            ranges: [
              {
                startingLine: 1,
                endingLine: 1,
                commit: {
                  oid: SHA("c"),
                  messageHeadline: "init",
                  committedDate: "2026-08-27T01:00:00Z",
                  author: { name: "Chris", user: { login: "chris" } },
                },
              },
              {
                startingLine: 2,
                endingLine: 3,
                commit: {
                  oid: SHA("a"),
                  messageHeadline: "add a",
                  committedDate: "2026-08-27T04:00:00Z",
                  author: { name: "Chris", user: null },
                },
              },
            ],
          },
        },
      },
    },
  };

  function whyStub() {
    const calls: Array<{ url: string; body?: string }> = [];
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        calls.push({ url, body: init?.body });
        if (url.endsWith("/repos/o/r")) return Response.json({ default_branch: "main" });
        if (url.includes("/contents/")) {
          return url.includes("missing")
            ? new Response("{}", { status: 404 })
            : new Response(file);
        }
        if (url.endsWith("/graphql")) return Response.json(blame);
        if (url.includes(`/commits/${SHA("a")}`)) {
          if (init?.headers?.accept === "application/vnd.github.diff") {
            return new Response(
              "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+two\ndiff --git a/other.ts b/other.ts\n+++ b/other.ts\n+x\n"
            );
          }
          return Response.json({
            ...A,
            files: [
              { filename: "src/a.ts", additions: 1, deletions: 0 },
              { filename: "other.ts", additions: 1, deletions: 0 },
            ],
          });
        }
        return new Response("{}", { status: 404 });
      }
    );
    return calls;
  }

  it("blames the line and cuts the commit down to the file", async () => {
    const calls = whyStub();
    const w = await whyInput("t", "o", "r", "src/a.ts", 2);
    const ql = calls.find((c) => c.url.endsWith("/graphql"))!;
    expect(JSON.parse(ql.body!).variables).toEqual({
      owner: "o",
      name: "r",
      expr: "main",
      path: "src/a.ts",
    });
    expect(calls.some((c) => c.url.includes("/contents/src%2Fa.ts") || c.url.includes("/contents/src/a.ts"))).toBe(true);
    expect(w.diff).toBe("diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+two\n");
    expect(w.numstat).toBe("1\t0\tsrc/a.ts");
    expect(w.commits).toBe(`${"a".repeat(7)} add a`);
    expect(w.note).toBe(`src/a.ts:2 last changed in ${"a".repeat(7)} by Chris, 2026-08-27: add a`);
    expect(w.question).toBe("\n\nthe line in question, src/a.ts:2 on main:\ntwo");
  });

  it("rejects lines past the end and missing files", async () => {
    whyStub();
    await expect(whyInput("t", "o", "r", "src/a.ts", 9)).rejects.toThrow("src/a.ts has 3 lines");
    await expect(whyInput("t", "o", "r", "missing.ts", 1)).rejects.toThrow(
      "missing.ts not found on main"
    );
  });
});

describe("commitInput", () => {
  it("shapes one commit as an explain input", async () => {
    stub({
      "/repos/o/r/commits/a1b2c3d": {
        ...A,
        files: [{ filename: "src/a.ts", additions: 3, deletions: 1 }],
        diff: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+x\n",
      },
    });
    const input = await commitInput("t", "o", "r", "a1b2c3d");
    expect(input.commits).toBe(`${"a".repeat(7)} add a`);
    expect(input.numstat).toBe("3\t1\tsrc/a.ts");
    expect(input.commitCount).toBe(1);
    expect(input.diff.startsWith("diff --git")).toBe(true);
    await expect(commitInput("t", "o", "r", "0000000")).rejects.toThrow(
      "commit 0000000 not found"
    );
  });
});
