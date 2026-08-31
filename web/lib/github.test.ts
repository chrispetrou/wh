import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitDetail,
  commitInput,
  historyBlock,
  latestTag,
  logBlock,
  planBlock,
  planRow,
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
    // the default branch is walked first, per_page is the row budget plus
    // one, so a cut walk can be told from a short one
    const walks = calls.filter((c) => c.startsWith("/repos/o/r/commits?"));
    expect(walks[0]).toContain("sha=main");
    expect(walks[0]).toContain("per_page=41");
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

  // a filtered log: the api does the filtering on every walk, the rows
  // come back flat (no rails), newest first, and spans are off
  function filteredRepo(perWalk: (q: URLSearchParams) => unknown[]) {
    const calls: string[] = [];
    stub({});
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      calls.push(path);
      if (path === "/repos/o/r") return Response.json({ default_branch: "main" });
      if (path.startsWith("/repos/o/r/branches"))
        return Response.json([
          { name: "main", commit: { sha: SHA("m") } },
          { name: "feat", commit: { sha: SHA("f") } },
        ]);
      if (path.startsWith("/repos/o/r/tags")) return Response.json([]);
      if (path === `/repos/o/r/commits/v1`) return Response.json(C);
      if (path === `/repos/o/r/commits/nope`) return new Response("{}", { status: 404 });
      if (path.startsWith("/repos/o/r/commits?"))
        return Response.json(perWalk(new URL(url).searchParams));
      return new Response("{}", { status: 404 });
    });
    return calls;
  }
  const NOW = Date.parse("2026-08-27T12:00:00Z");
  const shas = (log: Awaited<ReturnType<typeof logBlock>>) => {
    if (log.block.kind !== "log") throw new Error("expected a log block");
    return log.block.rows.map((r) => r.sha[0]);
  };
  const walksOf = (calls: string[]) =>
    calls.filter((c) => c.startsWith("/repos/o/r/commits?")).map((c) => new URL(`https://x${c}`).searchParams);

  it("filters by author on every walk and draws the rows flat", async () => {
    // the api answers out of order and with duplicates across walks
    const calls = filteredRepo((q) => (q.get("sha") === "main" ? [C, A] : [F, C]));
    const log = await logBlock("t", "o", "r", 40, undefined, {
      author: "renovate[bot]",
      login: "chris",
      now: NOW,
      tz: 0,
    });
    for (const q of walksOf(calls)) expect(q.get("author")).toBe("renovate[bot]");
    expect(calls.find((c) => c.includes("author="))).toContain("author=renovate%5Bbot%5D");
    const b = log.block;
    if (b.kind !== "log") throw new Error("expected a log block");
    expect(b.lanes).toBe(0);
    expect(b.rows.map((r) => [r.sha[0], r.graph])).toEqual([
      ["a", undefined],
      ["f", undefined],
      ["c", undefined],
    ]);
    expect(b.rows[1].refs).toEqual([{ name: "feat", kind: "branch" }]);
    expect(b.footer).toEqual(["3 commits by renovate[bot] · 2 branches"]);
    expect(log.spans).toBe(false);
    expect(log.rows.map((r) => r.sha[0])).toEqual(["a", "f", "c"]);
  });

  it("resolves `me`, passes a period as since/until, and says the latest when cut", async () => {
    const calls = filteredRepo(() => [M, A, F, C]);
    const log = await logBlock("t", "o", "r", 2, "main", {
      author: "me",
      since: "yesterday",
      login: "chris",
      now: NOW,
      tz: 0,
    });
    const [q] = walksOf(calls);
    expect(q.get("author")).toBe("chris");
    expect(q.get("since")).toBe("2026-08-26T00:00:00.000Z");
    expect(q.get("until")).toBe("2026-08-27T00:00:00.000Z");
    expect(q.get("per_page")).toBe("3"); // the budget plus one
    expect(shas(log)).toEqual(["m", "a"]);
    expect(log.block.footer).toEqual(["the latest 2 commits on main by chris, yesterday"]);
  });

  it("takes a ref as the start of the window and leaves the ref itself out", async () => {
    const calls = filteredRepo(() => [A, F, C]);
    const log = await logBlock("t", "o", "r", 40, undefined, {
      since: "v1",
      login: "chris",
      now: NOW,
      tz: 0,
    });
    expect(calls).toContain("/repos/o/r/commits/v1");
    for (const q of walksOf(calls)) {
      expect(q.get("since")).toBe(C.commit.committer.date);
      expect(q.get("author")).toBeNull();
    }
    expect(shas(log)).toEqual(["a", "f"]);
    expect(log.block.footer).toEqual(["2 commits, since v1 · 2 branches"]);
    await expect(
      logBlock("t", "o", "r", 40, undefined, { since: "nope", login: "chris", now: NOW, tz: 0 })
    ).rejects.toThrow("unknown ref nope");
  });

  it("says when nothing matches, and that by wants a login", async () => {
    filteredRepo(() => []);
    const log = await logBlock("t", "o", "r", 40, "feat", {
      author: "alice",
      since: "this week",
      login: "chris",
      now: NOW,
      tz: 0,
    });
    expect(log.block.rows).toEqual([]);
    expect(log.block.footer).toEqual(["no commits this week by alice on feat (by takes a github login)"]);
    expect(log.spans).toBe(false);
    const bare = await logBlock("t", "o", "r", 40, undefined, {
      since: "today",
      login: "chris",
      now: NOW,
      tz: 0,
    });
    expect(bare.block.footer).toEqual(["no commits today"]);
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
          body: "  the body\n",
          head: { ref: "feat/x" },
          base: { ref: "main" },
        });
      }
    );
    const input = await prInput("t", "o", "r", 5);
    expect(input.note).toBe("draft · conflicts with base");
    // what describe mode relays after the payload
    expect(input.describe).toEqual({
      base: "main",
      head: "feat/x",
      pr: { num: 5, title: "t", body: "  the body\n" },
    });
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
    expect(h.rows[1]).toEqual({ sha: SHA("c"), parent: null, merge: false, subject: "init" });
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

describe("planBlock", () => {
  const withFiles = (c: ReturnType<typeof commit>, files: string[]) => ({
    ...c,
    files: files.map((filename) => ({ filename, additions: 1, deletions: 0, status: "modified" })),
  });
  const B = commit("b", ["a"], "add auth", "2026-08-27T03:00:00Z");
  const D = commit("d", ["b"], "fix typo", "2026-08-27T04:00:00Z");

  it("plans a rebase over a range, newest first, with the target's clashes", async () => {
    const calls = stub({
      "/repos/o/r/compare/main...feat": {
        total_commits: 2,
        base_commit: { sha: SHA("m") },
        commits: [B, D],
      },
      [`/repos/o/r/commits/${SHA("b")}`]: withFiles(B, ["src/auth.rs", "README.md"]),
      [`/repos/o/r/commits/${SHA("d")}`]: withFiles(D, ["src/auth.rs"]),
      [`/repos/o/r/compare/${SHA("d")}...${SHA("m")}`]: {
        files: [{ filename: "README.md" }, { filename: "ci.yml" }],
      },
    });
    const { block } = await planBlock("t", "o", "r", { kind: "range", base: "main", head: "feat" });
    if (block.kind !== "plan") throw new Error("expected a plan");
    expect(block.mode).toBe("rebase");
    expect(block.base).toEqual({ sha: SHA("m"), ref: "main" });
    expect(block.head).toBe("feat");
    expect(block.rows.map((r) => [r.sha[0], r.idx, r.action, r.files, r.clash])).toEqual([
      ["d", 0, "pick", ["src/auth.rs"], []],
      ["b", 1, "pick", ["src/auth.rs", "README.md"], ["README.md"]],
    ]);
    expect(block.rows[1].message).toBe("add auth\n\nbody");
    expect(block.footer).toEqual(["2 commits, feat onto main"]);
    expect(calls.filter((c) => c.startsWith("/repos/o/r/compare/"))).toHaveLength(2);
  });

  it("treats a sha end of a range as no branch: nothing to switch to or name", async () => {
    stub({
      [`/repos/o/r/compare/${SHA("a")}...${SHA("b")}`]: {
        total_commits: 1,
        base_commit: { sha: SHA("a") },
        commits: [B],
      },
      [`/repos/o/r/commits/${SHA("b")}`]: withFiles(B, ["src/auth.rs"]),
      [`/repos/o/r/compare/${SHA("b")}...${SHA("a")}`]: { files: [] },
    });
    const { block } = await planBlock("t", "o", "r", { kind: "range", base: SHA("a"), head: SHA("b") });
    if (block.kind !== "plan") throw new Error("expected a plan");
    expect(block.head).toBeUndefined();
    expect(block.base).toEqual({ sha: SHA("a") });
    expect(block.footer).toEqual([`1 commit, these commits onto ${"a".repeat(7)}`]);
  });

  it("backports a merged pr onto a branch, and refuses to rebase one", async () => {
    stub({
      "/repos/o/r/pulls/7": {
        merged: true,
        commits: 1,
        base: { ref: "main", sha: SHA("m") },
        head: { ref: "feat" },
      },
      "/repos/o/r/pulls/7/commits": [B],
      "/repos/o/r/commits/rel": { sha: SHA("r") },
      [`/repos/o/r/commits/${SHA("b")}`]: withFiles(B, ["src/auth.rs"]),
      [`/repos/o/r/compare/${SHA("b")}...rel`]: { files: [] },
    });
    const { block } = await planBlock("t", "o", "r", { kind: "pr", num: 7 }, "rel");
    if (block.kind !== "plan") throw new Error("expected a plan");
    expect(block.mode).toBe("pick");
    expect(block.rows.map((r) => r.sha[0])).toEqual(["b"]);
    await expect(planBlock("t", "o", "r", { kind: "pr", num: 7 })).rejects.toThrow(
      "pr #7 is merged; nothing to plan"
    );
  });

  it("orders cherry-picked shas by parent when their dates tie", async () => {
    // a rebase stamps every commit with the same second
    const X = commit("1", ["a"], "one", "2026-08-27T03:00:00Z");
    const Y = commit("2", ["1"], "two", "2026-08-27T03:00:00Z");
    stub({
      [`/repos/o/r/commits/${SHA("1")}`]: withFiles(X, ["x"]),
      [`/repos/o/r/commits/${SHA("2")}`]: withFiles(Y, ["y"]),
      "/repos/o/r/commits/rel": { sha: SHA("r") },
      [`/repos/o/r/compare/${SHA("1")}...rel`]: { files: [] },
      [`/repos/o/r/compare/${SHA("2")}...rel`]: { files: [] },
    });
    const { block } = await planBlock("t", "o", "r", { kind: "shas", shas: [SHA("2"), SHA("1")] }, "rel");
    if (block.kind !== "plan") throw new Error("expected a plan");
    expect(block.rows.map((r) => r.sha[0])).toEqual(["2", "1"]);
  });

  it("refuses merges, too many commits, an empty range, and unknown refs", async () => {
    stub({
      "/repos/o/r/compare/main...feat": { total_commits: 2, base_commit: { sha: SHA("c") }, commits: [F, M] },
      "/repos/o/r/compare/main...big": { total_commits: 31, base_commit: { sha: SHA("c") }, commits: [] },
      "/repos/o/r/compare/main...same": { total_commits: 0, base_commit: { sha: SHA("c") }, commits: [] },
    });
    await expect(planBlock("t", "o", "r", { kind: "range", base: "main", head: "feat" })).rejects.toThrow(
      `rebase plans need a linear history; ${SHA("m").slice(0, 7)} is a merge`
    );
    await expect(planBlock("t", "o", "r", { kind: "range", base: "main", head: "big" })).rejects.toThrow(
      "that is 31 commits; plans stop at 30"
    );
    await expect(planBlock("t", "o", "r", { kind: "range", base: "main", head: "same" })).rejects.toThrow(
      "nothing to rebase: same is up to date with main"
    );
    await expect(planBlock("t", "o", "r", { kind: "range", base: "main", head: "nope" })).rejects.toThrow(
      "unknown ref in main..nope"
    );
  });

  it("plans a pr's commits onto its base", async () => {
    stub({
      "/repos/o/r/pulls/7": {
        merged: false,
        commits: 1,
        base: { ref: "main", sha: SHA("m") },
        head: { ref: "feat" },
      },
      "/repos/o/r/pulls/7/commits": [B],
      [`/repos/o/r/commits/${SHA("b")}`]: withFiles(B, ["src/auth.rs"]),
      [`/repos/o/r/compare/${SHA("b")}...${SHA("m")}`]: { files: [] },
    });
    const { block } = await planBlock("t", "o", "r", { kind: "pr", num: 7 });
    if (block.kind !== "plan") throw new Error("expected a plan");
    expect(block.head).toBe("feat");
    expect(block.base).toEqual({ sha: SHA("m"), ref: "main" });
    expect(block.rows.map((r) => r.sha[0])).toEqual(["b"]);
    expect(block.footer).toEqual(["1 commit, feat onto main"]);
  });

  it("plans a cherry-pick of shas onto a branch, checking each against the target", async () => {
    const calls = stub({
      [`/repos/o/r/commits/${SHA("b")}`]: withFiles(B, ["src/auth.rs"]),
      [`/repos/o/r/commits/${SHA("d")}`]: withFiles(D, ["src/auth.rs", "docs.md"]),
      "/repos/o/r/commits/rel": { sha: SHA("r") },
      [`/repos/o/r/compare/${SHA("b")}...rel`]: { files: [{ filename: "src/auth.rs" }] },
      [`/repos/o/r/compare/${SHA("d")}...rel`]: { files: [{ filename: "other.rs" }] },
    });
    const { block } = await planBlock("t", "o", "r", { kind: "shas", shas: [SHA("d"), SHA("b")] }, "rel");
    if (block.kind !== "plan") throw new Error("expected a plan");
    expect(block.mode).toBe("pick");
    expect(block.onto).toBe("rel");
    expect(block.base).toEqual({ sha: SHA("r"), ref: "rel" });
    // oldest last on screen, whatever order the shas came in
    expect(block.rows.map((r) => [r.sha[0], r.clash])).toEqual([
      ["d", []],
      ["b", ["src/auth.rs"]],
    ]);
    expect(block.footer).toEqual(["2 commits onto rel"]);
    expect(calls).not.toContain("/repos/o/r/compare/rel");
    await expect(
      planBlock("t", "o", "r", { kind: "shas", shas: [SHA("b")] }, "gone")
    ).rejects.toThrow("unknown ref gone");
  });

  it("plans the last n commits on a branch", async () => {
    const fetchMock = stub({});
    void fetchMock;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      if (path.startsWith("/repos/o/r/commits?")) {
        expect(new URL(url).searchParams.get("sha")).toBe("feat");
        return Response.json([D, B, A]);
      }
      if (path === `/repos/o/r/commits/${SHA("d")}`) return Response.json(withFiles(D, ["x"]));
      if (path === `/repos/o/r/commits/${SHA("b")}`) return Response.json(withFiles(B, ["y"]));
      if (path.startsWith("/repos/o/r/compare/")) return Response.json({ files: [] });
      return new Response("{}", { status: 404 });
    });
    const { block } = await planBlock("t", "o", "r", { kind: "last", n: 2, ref: "feat" });
    if (block.kind !== "plan") throw new Error("expected a plan");
    expect(block.rows.map((r) => r.sha[0])).toEqual(["d", "b"]);
    expect(block.base).toEqual({ sha: SHA("a") });
    expect(block.head).toBe("feat");
  });
});

describe("planRow", () => {
  it("fetches one commit with its files and clashes against a target", async () => {
    const B = commit("b", ["a"], "add auth", "2026-08-27T03:00:00Z");
    stub({
      [`/repos/o/r/commits/${SHA("b")}`]: {
        ...B,
        files: [{ filename: "src/auth.rs" }, { filename: "README.md" }],
      },
      [`/repos/o/r/compare/${SHA("b")}...rel`]: { files: [{ filename: "README.md" }] },
    });
    const r = await planRow("t", "o", "r", SHA("b"), "rel");
    expect([r.sha[0], r.subject, r.files, r.clash, r.action, r.idx]).toEqual([
      "b",
      "add auth",
      ["src/auth.rs", "README.md"],
      ["README.md"],
      "pick",
      0,
    ]);
    await expect(planRow("t", "o", "r", SHA("b"), "gone")).rejects.toThrow("unknown ref gone");
    await expect(planRow("t", "o", "r", SHA("m"), "rel")).rejects.toThrow("not found");
  });
});
