// read-only github fetchers that synthesize cli-shaped explain inputs
// (unified diff + numstat lines + commit lines) so the shared preprocess
// spec applies unchanged.

import { graph } from "./graph";
import { resolvePeriod } from "./time";

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
  if (!head || !base) {
    // open side of a range means the default branch tip
    const info = await gh(token, `/repos/${owner}/${repo}`);
    const def = ((await info.json()) as { default_branch: string }).default_branch;
    head = head || def;
    base = base || def;
  }
  const path = `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  let diffRes: Response;
  let jsonRes: Response;
  try {
    [diffRes, jsonRes] = await Promise.all([
      gh(token, path, "application/vnd.github.diff"),
      gh(token, path),
    ]);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `unknown ref in ${base}..${head}; run branches to see refs`);
    }
    throw e;
  }
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
  n: number,
  ref?: string
): Promise<ExplainInput> {
  const sha = ref ? `&sha=${encodeURIComponent(ref)}` : "";
  let res: Response;
  try {
    res = await gh(token, `/repos/${owner}/${repo}/commits?per_page=${n + 1}${sha}`);
  } catch (e) {
    if (ref && e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `branch ${ref} not found; run branches to see refs`);
    }
    throw e;
  }
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
  let diffRes: Response;
  let jsonRes: Response;
  let commitsRes: Response;
  try {
    [diffRes, jsonRes, commitsRes] = await Promise.all([
      gh(token, path, "application/vnd.github.diff"),
      gh(token, path),
      gh(token, `${path}/commits?per_page=100`),
    ]);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `pr #${num} not found in this repo`);
    }
    throw e;
  }
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

interface CommitJson {
  sha: string;
  parents: Array<{ sha: string }>;
  commit: { message: string; committer: { date: string }; author: { name: string } };
  author: { login: string } | null;
  files?: Array<{ filename: string; additions: number; deletions: number }>;
}

// one commit, as an explain input
export async function commitInput(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<ExplainInput> {
  const path = `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`;
  let diffRes: Response;
  let jsonRes: Response;
  try {
    [diffRes, jsonRes] = await Promise.all([
      gh(token, path, "application/vnd.github.diff"),
      gh(token, path),
    ]);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `commit ${sha} not found in this repo`);
    }
    if (e instanceof GithubError && e.status === 422) {
      throw new GithubError(422, `${sha} is not a commit sha`);
    }
    throw e;
  }
  const diff = await diffRes.text();
  const json = (await jsonRes.json()) as CommitJson;
  const files = json.files ?? [];
  return {
    diff,
    commits: commitLines([json]),
    numstat: numstatLines(files),
    commitCount: 1,
    truncated: files.length >= 300,
  };
}

// "since yesterday", "this week by me", "since v1.2": a period resolves
// to a window on the default branch; a ref without an author is a plain
// compare. one author's commits are fetched one by one (capped) since a
// compare cannot filter by author.
const AUTHOR_COMMITS_CAP = 20;
const SINCE_PAGE = 100;

export interface SinceOpts {
  period: string;
  author?: string; // login, or "me"
  login: string; // the signed-in user, for "me"
  now: number;
  tz: number; // minutes, as getTimezoneOffset reports
}

export type SinceResult = ExplainInput | { empty: string };

export async function sinceInput(
  token: string,
  owner: string,
  repo: string,
  opts: SinceOpts
): Promise<SinceResult> {
  const author = opts.author === "me" ? opts.login : opts.author;
  const period = resolvePeriod(opts.period, opts.now, opts.tz);

  if (!period && !author) {
    // a ref: everything on the default branch since it
    return compareRange(token, owner, repo, opts.period, "");
  }

  const base = `/repos/${owner}/${repo}`;
  const info = await gh(token, base);
  const def = ((await info.json()) as { default_branch: string }).default_branch;

  let since: string;
  let until: string | undefined;
  let label: string;
  let skip: string | null = null; // the ref commit itself, when since is a ref
  if (period) {
    ({ since, until, label } = period);
  } else {
    // a ref with an author: the window starts at the ref's commit
    let res: Response;
    try {
      res = await gh(token, `${base}/commits/${encodeURIComponent(opts.period)}`);
    } catch (e) {
      if (e instanceof GithubError && e.status === 404) {
        throw new GithubError(404, `unknown ref ${opts.period}; run branches to see refs`);
      }
      throw e;
    }
    const c = (await res.json()) as CommitJson;
    since = c.commit.committer.date;
    skip = c.sha;
    label = `since ${opts.period}`;
  }

  const q = new URLSearchParams({ sha: def, since, per_page: String(SINCE_PAGE) });
  if (until) q.set("until", until);
  if (author) q.set("author", author);
  const listRes = await gh(token, `${base}/commits?${q}`);
  const list = ((await listRes.json()) as CommitJson[]).filter((c) => c.sha !== skip);
  const who = author ? ` by ${author}` : "";
  if (!list.length) return { empty: `nothing ${label}${who}` };

  const newest = list[0];
  const oldest = list[list.length - 1];
  const full = list.length >= SINCE_PAGE;

  if (author && list.length <= AUTHOR_COMMITS_CAP) {
    const inputs = await Promise.all(
      list.map((c) => commitInput(token, owner, repo, c.sha))
    );
    const numstat = new Map<string, [number, number]>();
    for (const i of inputs) {
      for (const row of i.numstat.split("\n").filter(Boolean)) {
        const [a, d, ...rest] = row.split("\t");
        const path = rest.join("\t");
        const cur = numstat.get(path) ?? [0, 0];
        numstat.set(path, [cur[0] + Number(a), cur[1] + Number(d)]);
      }
    }
    return {
      diff: inputs.map((i) => i.diff).join(""),
      commits: inputs.map((i) => i.commits).join("\n"),
      numstat: [...numstat].map(([p, [a, d]]) => `${a}\t${d}\t${p}`).join("\n"),
      commitCount: list.length,
      truncated: inputs.some((i) => i.truncated),
      note: `${list.length} ${list.length === 1 ? "commit" : "commits"}${who}, ${label}`,
    };
  }

  const parent = oldest.parents[0]?.sha;
  const input = await compareRange(token, owner, repo, parent ?? oldest.sha, newest.sha);
  const notes: string[] = [];
  if (author) notes.push(`showing all authors: too many commits${who} to fetch one by one`);
  if (full) notes.push(`the latest ${SINCE_PAGE} commits ${label}`);
  if (!parent) notes.push("the first commit of the repo is not included");
  if (notes.length) input.note = notes.join(" · ");
  return input;
}

// the ascii graph: one walk per branch head (capped), unioned by sha,
// drawn with lib/graph. rows travel as tab-separated fields so the client
// lays out columns and colors; footer lines carry no tabs.
const LOG_WALKS = 12;

export interface LogRef {
  sha: string;
  parent: string | null;
  subject: string;
}

export interface LogResult {
  text: string;
  count: number;
  rails: number; // widest rail string, for the column
  rows: LogRef[];
}

export async function logText(
  token: string,
  owner: string,
  repo: string,
  n: number,
  ref?: string
): Promise<LogResult> {
  const base = `/repos/${owner}/${repo}`;
  const [infoRes, branchRes, tagRes] = await Promise.all([
    gh(token, base),
    gh(token, `${base}/branches?per_page=100`),
    gh(token, `${base}/tags?per_page=100`),
  ]);
  const def = ((await infoRes.json()) as { default_branch: string }).default_branch;
  const branches = (await branchRes.json()) as Array<{ name: string; commit: { sha: string } }>;
  const tags = (await tagRes.json()) as Array<{ name: string; commit: { sha: string } }>;

  const heads = ref
    ? [ref]
    : [def, ...branches.map((b) => b.name).filter((b) => b !== def)].slice(0, LOG_WALKS);
  const walks = await Promise.all(
    heads.map(async (h) => {
      try {
        const res = await gh(
          token,
          `${base}/commits?per_page=${n}&sha=${encodeURIComponent(h)}`
        );
        return (await res.json()) as CommitJson[];
      } catch (e) {
        if (ref && e instanceof GithubError && e.status === 404) {
          throw new GithubError(404, `branch ${ref} not found; run branches to see refs`);
        }
        if (e instanceof GithubError && e.status === 404) return []; // a branch moved under us
        throw e;
      }
    })
  );

  const byShaMap = new Map<string, CommitJson>();
  for (const walk of walks) for (const c of walk) byShaMap.set(c.sha, c);
  const ordered = graph(
    [...byShaMap.values()].map((c) => ({
      sha: c.sha,
      parents: c.parents.map((p) => p.sha),
      date: c.commit.committer.date,
    }))
  );

  // decorations: branch heads (default first) and tags
  const refs = new Map<string, string[]>();
  const decorate = (sha: string, name: string) => {
    const list = refs.get(sha) ?? [];
    list.push(name);
    refs.set(sha, list);
  };
  const defHead = branches.find((b) => b.name === def);
  if (defHead) decorate(defHead.commit.sha, def);
  for (const b of branches) if (b.name !== def) decorate(b.commit.sha, b.name);
  for (const t of tags) decorate(t.commit.sha, t.name);

  const lines: string[] = [];
  const rows: LogRef[] = [];
  let rails = 1;
  for (const r of ordered) {
    if (rows.length >= n && r.sha) break;
    rails = Math.max(rails, r.rails.length);
    if (!r.sha) {
      lines.push(`${r.rails}\t\t\t\t\t`);
      continue;
    }
    const c = byShaMap.get(r.sha)!;
    const subject = c.commit.message.split("\n")[0];
    rows.push({ sha: c.sha, parent: c.parents[0]?.sha ?? null, subject });
    lines.push(
      [
        r.rails,
        c.sha.slice(0, 7),
        (refs.get(c.sha) ?? []).join(" "),
        subject,
        c.author?.login ?? c.commit.author.name,
        c.commit.committer.date,
      ].join("\t")
    );
  }
  // a trailing connector row leads nowhere
  while (lines.length && lines[lines.length - 1].endsWith("\t\t\t\t\t")) lines.pop();

  const shown = rows.length;
  if (ref) {
    lines.push(`${shown} ${shown === 1 ? "commit" : "commits"} on ${ref}`);
  } else {
    const drawn = Math.min(heads.length, branches.length);
    lines.push(
      `${shown} ${shown === 1 ? "commit" : "commits"} · ${drawn} ${drawn === 1 ? "branch" : "branches"}`
    );
    if (branches.length > drawn) lines.push(`(+${branches.length - drawn} branches not drawn)`);
  }
  return { text: lines.join("\n") + "\n", count: shown, rails, rows };
}

// branches with ahead/behind against the default branch, wd ls style.
// counts come from per-branch compare calls, so they are capped.
const BRANCH_COUNTS_CAP = 15;

export async function branchesText(
  token: string,
  owner: string,
  repo: string
): Promise<string> {
  const [infoRes, listRes] = await Promise.all([
    gh(token, `/repos/${owner}/${repo}`),
    gh(token, `/repos/${owner}/${repo}/branches?per_page=100`),
  ]);
  const def = ((await infoRes.json()) as { default_branch: string }).default_branch;
  const branches = (await listRes.json()) as Array<{ name: string }>;

  const others = branches.filter((b) => b.name !== def);
  const counted = others.slice(0, BRANCH_COUNTS_CAP);
  const compared = await Promise.all(
    counted.map(async (b) => {
      try {
        const res = await gh(
          token,
          `/repos/${owner}/${repo}/compare/${encodeURIComponent(def)}...${encodeURIComponent(b.name)}`
        );
        const j = (await res.json()) as { ahead_by: number; behind_by: number };
        return { name: b.name, ahead: j.ahead_by, behind: j.behind_by };
      } catch {
        return { name: b.name, ahead: -1, behind: -1 };
      }
    })
  );

  const width = Math.max(def.length, ...others.map((b) => b.name.length), 0) + 2;
  const total = branches.length;
  const numWidth = String(total).length;
  let i = 0;
  const row = (name: string, status: string) =>
    `${String(++i).padStart(numWidth)}  ${name.padEnd(width)}${status}`.trimEnd();

  const lines = [row(def, "default")];
  for (const b of compared) {
    const parts: string[] = [];
    if (b.ahead > 0) parts.push(`ahead ${b.ahead}`);
    if (b.behind > 0) parts.push(`behind ${b.behind}`);
    if (b.ahead === 0 && b.behind === 0) parts.push("even");
    lines.push(row(b.name, b.ahead < 0 ? "" : parts.join(" · ")));
  }
  for (const b of others.slice(BRANCH_COUNTS_CAP)) {
    lines.push(row(b.name, ""));
  }
  lines.push(`${total} ${total === 1 ? "branch" : "branches"}`);
  if (others.length > BRANCH_COUNTS_CAP) {
    lines.push(`(counts shown for the first ${BRANCH_COUNTS_CAP})`);
  }
  return lines.join("\n") + "\n";
}

// branch names for completion menus, default branch first
export async function branchNames(
  token: string,
  owner: string,
  repo: string
): Promise<string[]> {
  const [infoRes, listRes] = await Promise.all([
    gh(token, `/repos/${owner}/${repo}`),
    gh(token, `/repos/${owner}/${repo}/branches?per_page=100`),
  ]);
  const def = ((await infoRes.json()) as { default_branch: string }).default_branch;
  const names = ((await listRes.json()) as Array<{ name: string }>).map((b) => b.name);
  return [def, ...names.filter((n) => n !== def)];
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
