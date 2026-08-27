import { afterEach, describe, expect, it, vi } from "vitest";
import { commitInput, logText, sinceInput } from "./github";

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

describe("logText", () => {
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

    const log = await logText("t", "o", "r", 40);
    expect(log.text.split("\n")).toEqual([
      `*\t${"m".repeat(7)}\tmain\tmerge feat\tchris\t2026-08-27T05:00:00Z`,
      "|\\\t\t\t\t\t",
      `* |\t${"a".repeat(7)}\t\tadd a\tchris\t2026-08-27T04:00:00Z`,
      `| *\t${"f".repeat(7)}\tfeat\tadd f\tchris\t2026-08-27T03:00:00Z`,
      "|/\t\t\t\t\t",
      `*\t${"c".repeat(7)}\tv1\tinit\tchris\t2026-08-27T01:00:00Z`,
      "4 commits · 2 branches",
      "",
    ]);
    expect(log.count).toBe(4);
    expect(log.rails).toBe(3);
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
    const log = await logText("t", "o", "r", 10, "feat");
    expect(log.text.split("\n").slice(-2)).toEqual(["2 commits on feat", ""]);
    await expect(logText("t", "o", "r", 10, "nope")).rejects.toThrow("branch nope not found");
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
