// read-only github fetchers that synthesize cli-shaped explain inputs
// (unified diff + numstat lines + commit lines) so the shared preprocess
// spec applies unchanged.

// overridable for github enterprise (and tests)
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

export class GithubError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

function headers(token: string, accept: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": "2022-11-28",
  };
}

async function gh(
  token: string,
  path: string,
  accept = "application/vnd.github+json"
): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    headers: headers(token, accept),
    cache: "no-store",
  });
  if (res.ok) return res;
  if (res.status === 401) throw new GithubError(401, "session expired, sign in again");
  if (res.status === 404) throw new GithubError(404, "not found on github");
  if (res.status === 406) throw new GithubError(406, "diff too large to explain");
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const at = reset
      ? new Date(reset).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : "later";
    throw new GithubError(res.status, `github rate limit, try again after ${at}`);
  }
  throw new GithubError(res.status, `github error (${res.status})`);
}

export interface RepoItem {
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  pushedAt: string;
  private: boolean;
}

interface RepoJson {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  pushed_at: string;
  private: boolean;
}

export async function listRepos(token: string): Promise<RepoItem[]> {
  const out: RepoItem[] = [];
  for (let page = 1; page <= 2; page++) {
    const res = await gh(token, `/user/repos?sort=pushed&per_page=100&page=${page}`);
    const repos = (await res.json()) as RepoJson[];
    for (const r of repos) {
      out.push({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        description: r.description,
        pushedAt: r.pushed_at,
        private: r.private,
      });
    }
    if (repos.length < 100) break;
  }
  return out;
}

export interface ExplainInput {
  diff: string;
  commits: string;
  numstat: string;
  commitCount: number;
  truncated: boolean;
  title?: string;
  note?: string;
}

interface CompareJson {
  total_commits: number;
  commits: Array<{ sha: string; commit: { message: string } }>;
  files?: Array<{ filename: string; additions: number; deletions: number }>;
}

function commitLines(commits: Array<{ sha: string; commit: { message: string } }>): string {
  return commits
    .map((c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`)
    .join("\n");
}

function numstatLines(files: Array<{ filename: string; additions: number; deletions: number }>): string {
  return files.map((f) => `${f.additions}\t${f.deletions}\t${f.filename}`).join("\n");
}

export async function compareRange(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<ExplainInput> {
  const path = `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const [diffRes, jsonRes] = await Promise.all([
    gh(token, path, "application/vnd.github.diff"),
    gh(token, path),
  ]);
  const diff = await diffRes.text();
  const json = (await jsonRes.json()) as CompareJson;
  const files = json.files ?? [];
  return {
    diff,
    commits: commitLines(json.commits),
    numstat: numstatLines(files),
    commitCount: json.total_commits,
    truncated: json.total_commits > 250 || files.length >= 300,
  };
}

export async function lastNCommits(
  token: string,
  owner: string,
  repo: string,
  n: number
): Promise<ExplainInput> {
  const res = await gh(token, `/repos/${owner}/${repo}/commits?per_page=${n + 1}`);
  const commits = (await res.json()) as Array<{ sha: string }>;
  if (commits.length < 2) {
    throw new GithubError(422, "not enough history to compare");
  }
  const head = commits[0].sha;
  const base = commits[Math.min(n, commits.length - 1)].sha;
  const input = await compareRange(token, owner, repo, base, head);
  const shown = Math.min(n, commits.length - 1);
  if (shown < n) input.note = `showing last ${shown} of ${n}`;
  return input;
}

interface PrJson {
  title: string;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
}

export async function prInput(
  token: string,
  owner: string,
  repo: string,
  num: number
): Promise<ExplainInput> {
  const path = `/repos/${owner}/${repo}/pulls/${num}`;
  const [diffRes, jsonRes, commitsRes] = await Promise.all([
    gh(token, path, "application/vnd.github.diff"),
    gh(token, path),
    gh(token, `${path}/commits?per_page=100`),
  ]);
  const diff = await diffRes.text();
  const pr = (await jsonRes.json()) as PrJson;
  const commits = (await commitsRes.json()) as Array<{
    sha: string;
    commit: { message: string };
  }>;
  // the diff media type has no per-file stats, so numstat comes from the
  // diff itself being preprocessed; give the payload a whole-pr stats line
  return {
    diff,
    commits: commitLines(commits),
    numstat: numstatFromDiff(diff),
    commitCount: pr.commits,
    truncated: pr.commits > 100 || pr.changed_files >= 300,
    title: pr.title,
  };
}

// per-file counts derived from the unified diff: +/- body lines per
// "diff --git" section; binary sections yield 0/0 like the compare json.
export function numstatFromDiff(diff: string): string {
  const rows: string[] = [];
  let path = "";
  let add = 0;
  let del = 0;
  let started = false;
  const flush = () => {
    if (started) rows.push(`${add}\t${del}\t${path}`);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const i = line.lastIndexOf(" b/");
      path = i >= 0 ? line.slice(i + 3) : line;
      add = 0;
      del = 0;
      started = true;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      add++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      del++;
    }
  }
  flush();
  return rows.join("\n");
}
