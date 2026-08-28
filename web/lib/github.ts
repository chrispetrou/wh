// read-only github fetchers that synthesize cli-shaped explain inputs
// (unified diff + numstat lines + commit lines) so the shared preprocess
// spec applies unchanged.

import type { Block, CommitRow, Ref } from "./block";
import type { CommitDetail, PrDetail } from "./chat-store";
import { LATEST_TAG } from "./commands";
import { filterDiff } from "./explain/filter";
import { laneCount, layout } from "./graph";
import { resolvePeriod } from "./time";

// overridable for github enterprise (and tests)
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const GRAPHQL = process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";

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
  throw failure(res);
}

// graphql, only where rest has no answer (blame). same errors, same token
async function ghql<T>(token: string, query: string, variables: object): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { ...headers(token, "application/json"), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!res.ok) throw failure(res);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new GithubError(502, `github: ${json.errors[0].message}`);
  if (!json.data) throw new GithubError(502, "github error (empty reply)");
  return json.data;
}

function failure(res: Response): GithubError {
  if (res.status === 401) return new GithubError(401, "session expired, sign in again");
  if (res.status === 404) return new GithubError(404, "not found on github");
  if (res.status === 406) return new GithubError(406, "diff too large to explain");
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const at = reset
      ? new Date(reset).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : "later";
    return new GithubError(res.status, `github rate limit, try again after ${at}`);
  }
  return new GithubError(res.status, `github error (${res.status})`);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
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
  // what describe mode tells the model after the payload: the branch and
  // its base, and an existing pr's title and body
  describe?: DescribeContext;
}

export interface DescribeContext {
  base?: string;
  head?: string;
  pr?: { num: number; title: string; body: string };
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
    describe: { base, head },
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
  // a sha pair says nothing to a pr draft; the branch, when given, does
  input.describe = ref ? { head: ref } : undefined;
  return input;
}

interface PrJson {
  title: string;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null; // null while github is still computing it
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}

// the state words shown under a pr's title
export function prFlags(pr: Pick<PrJson, "draft" | "state" | "merged" | "mergeable">): string[] {
  const flags: string[] = [];
  if (pr.draft) flags.push("draft");
  if (pr.merged) flags.push("merged");
  else if (pr.state === "closed") flags.push("closed");
  else if (pr.mergeable === false) flags.push("conflicts with base");
  else if (pr.mergeable === true) flags.push("mergeable");
  return flags;
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
  const flags = prFlags(pr);
  return {
    diff,
    commits: commitLines(commits),
    numstat: numstatFromDiff(diff),
    commitCount: pr.commits,
    truncated: pr.commits > 100 || pr.changed_files >= 300,
    title: pr.title,
    note: flags.length ? flags.join(" · ") : undefined,
    describe: {
      base: pr.base?.ref,
      head: pr.head?.ref,
      pr: { num, title: pr.title, body: pr.body ?? "" },
    },
  };
}

// pull requests, most recently updated first, as a block
const PRS_PAGE = 30;

interface PrListJson {
  number: number;
  title: string;
  body?: string | null;
  draft: boolean;
  state: "open" | "closed";
  merged_at: string | null;
  merged?: boolean;
  mergeable?: boolean | null;
  updated_at: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
  html_url?: string;
  commits?: number;
}

export interface PrRef {
  num: number;
  title: string;
}

export async function prsBlock(
  token: string,
  owner: string,
  repo: string,
  state: "open" | "closed" | "mine",
  login: string
): Promise<{ block: Block; rows: PrRef[] }> {
  const q = new URLSearchParams({
    state: state === "mine" ? "all" : state,
    sort: "updated",
    direction: "desc",
    per_page: String(state === "mine" ? 100 : PRS_PAGE),
  });
  const res = await gh(token, `/repos/${owner}/${repo}/pulls?${q}`);
  let prs = (await res.json()) as PrListJson[];
  const capped = prs.length >= PRS_PAGE;
  if (state === "mine") prs = prs.filter((p) => p.user?.login === login).slice(0, PRS_PAGE);
  const what = state === "mine" ? `prs by ${login || "you"}` : `${state} prs`;
  const footer: string[] = [];
  if (!prs.length) footer.push(`no ${what}`);
  else {
    footer.push(`${prs.length} ${what.replace(/prs$/, prs.length === 1 ? "pr" : "prs")}`);
    if (capped && state !== "mine") footer.push(`(the ${PRS_PAGE} most recently updated)`);
  }
  return {
    block: {
      kind: "prs",
      rows: prs.map((p) => ({
        num: p.number,
        title: p.title,
        author: p.user?.login ?? "",
        head: p.head.ref,
        base: p.base.ref,
        updated: p.updated_at,
        flags: prFlags({
          draft: p.draft,
          state: p.state,
          merged: p.merged_at !== null,
          mergeable: null,
        }),
      })),
      footer,
    },
    rows: prs.map((p) => ({ num: p.number, title: p.title })),
  };
}

interface FileJson {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}

const files = (list: FileJson[] | undefined) =>
  (list ?? []).map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    status: f.status,
  }));

// one pull request in full, for the expanded row
export async function prDetail(
  token: string,
  owner: string,
  repo: string,
  num: number
): Promise<PrDetail> {
  const path = `/repos/${owner}/${repo}/pulls/${num}`;
  const [prRes, filesRes] = await Promise.all([
    gh(token, path),
    gh(token, `${path}/files?per_page=100`),
  ]);
  const p = (await prRes.json()) as PrListJson;
  return {
    kind: "pr",
    num: p.number,
    title: p.title,
    body: p.body ?? "",
    author: p.user?.login ?? "",
    head: p.head.ref,
    base: p.base.ref,
    flags: prFlags({
      draft: p.draft,
      state: p.state,
      merged: p.merged ?? p.merged_at !== null,
      mergeable: p.mergeable ?? null,
    }),
    url: p.html_url ?? "",
    commits: p.commits ?? 0,
    files: files((await filesRes.json()) as FileJson[]),
  };
}

interface CommitJson {
  sha: string;
  parents: Array<{ sha: string }>;
  commit: {
    message: string;
    committer: { name?: string; date: string };
    author: { name: string; date?: string };
  };
  author: { login: string } | null;
  files?: FileJson[];
  html_url?: string;
}

// one commit in full, for the expanded row
export async function commitDetail(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<CommitDetail> {
  let res: Response;
  try {
    res = await gh(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `commit ${sha} not found in this repo`);
    }
    throw e;
  }
  const c = (await res.json()) as CommitJson;
  return {
    kind: "commit",
    sha: c.sha,
    parents: c.parents.map((p) => p.sha),
    author: {
      login: c.author?.login ?? null,
      name: c.commit.author.name,
      date: c.commit.author.date ?? c.commit.committer.date,
    },
    committer: { name: c.commit.committer.name ?? "", date: c.commit.committer.date },
    message: c.commit.message,
    url: c.html_url ?? "",
    files: files(c.files),
  };
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

// a window of commits: a period, or everything after a ref's commit
// (the commit itself left out)
interface Window {
  since: string; // iso
  until?: string; // iso, exclusive
  label: string; // "since yesterday", "since v1.2"
  skip?: string; // the ref's sha
}

async function refWindow(token: string, base: string, ref: string): Promise<Window> {
  let res: Response;
  try {
    res = await gh(token, `${base}/commits/${encodeURIComponent(ref)}`);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `unknown ref ${ref}; run branches to see refs`);
    }
    throw e;
  }
  const c = (await res.json()) as CommitJson;
  return { since: c.commit.committer.date, skip: c.sha, label: `since ${ref}` };
}

export async function sinceInput(
  token: string,
  owner: string,
  repo: string,
  opts: SinceOpts
): Promise<SinceResult> {
  const author = opts.author === "me" ? opts.login : opts.author;
  const period = resolvePeriod(opts.period, opts.now, opts.tz);
  const base = `/repos/${owner}/${repo}`;

  // bare changelog: since the newest tag
  let tagNote: string | undefined;
  if (opts.period === LATEST_TAG) {
    const latest = await latestTag(token, owner, repo);
    if (!latest) throw new GithubError(404, "no tags in this repo; try changelog since <ref>");
    opts = { ...opts, period: latest };
    tagNote = `since ${latest}, the latest tag`;
  }

  if (!period && !author) {
    // a ref: everything on the default branch since it
    const input = await compareRange(token, owner, repo, opts.period, "");
    if (tagNote) input.note = tagNote;
    return input;
  }
  const info = await gh(token, base);
  const def = ((await info.json()) as { default_branch: string }).default_branch;

  // a ref with an author: the window starts at the ref's commit
  const { since, until, label, skip }: Window =
    period ?? (await refWindow(token, base, opts.period));

  const q = new URLSearchParams({ sha: def, since, per_page: String(SINCE_PAGE) });
  if (until) q.set("until", until);
  if (author) q.set("author", author);
  const listRes = await gh(token, `${base}/commits?${q}`);
  const list = ((await listRes.json()) as CommitJson[]).filter((c) => c.sha !== (skip ?? null));
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

// tags, newest first by commit date (github lists them by name); dates
// need one commit lookup each, so they are capped like branch counts
const TAG_DATES_CAP = 15;

interface TagJson {
  name: string;
  commit: { sha: string };
}

async function tagDates(
  token: string,
  owner: string,
  repo: string,
  tags: TagJson[]
): Promise<Array<TagJson & { date: string }>> {
  return Promise.all(
    tags.slice(0, TAG_DATES_CAP).map(async (t) => {
      try {
        const res = await gh(token, `/repos/${owner}/${repo}/commits/${t.commit.sha}`);
        const c = (await res.json()) as CommitJson;
        return { ...t, date: c.commit.committer.date };
      } catch {
        return { ...t, date: "" };
      }
    })
  );
}

export async function latestTag(token: string, owner: string, repo: string): Promise<string | null> {
  const res = await gh(token, `/repos/${owner}/${repo}/tags?per_page=${TAG_DATES_CAP}`);
  const tags = (await res.json()) as TagJson[];
  if (!tags.length) return null;
  const dated = await tagDates(token, owner, repo, tags);
  dated.sort((a, b) => b.date.localeCompare(a.date));
  return dated[0].name;
}

// rows travel as `num\tname\tsha\tiso` so the client renders the relative
// time; undated tags (past the cap) and the footer carry no tabs
export async function tagsText(token: string, owner: string, repo: string): Promise<string> {
  const res = await gh(token, `/repos/${owner}/${repo}/tags?per_page=100`);
  const tags = (await res.json()) as TagJson[];
  if (!tags.length) return "no tags\n";
  const dated = await tagDates(token, owner, repo, tags);
  dated.sort((a, b) => b.date.localeCompare(a.date));
  const rest = tags.slice(TAG_DATES_CAP);
  const width = Math.max(...tags.map((t) => t.name.length)) + 2;
  const numWidth = String(tags.length).length;
  let i = 0;
  const lines = dated.map(
    (t) =>
      `${String(++i).padStart(numWidth)}\t${t.name.padEnd(width)}\t${t.commit.sha.slice(0, 7)}\t${t.date}`
  );
  for (const t of rest) {
    lines.push(`${String(++i).padStart(numWidth)}\t${t.name.padEnd(width)}\t${t.commit.sha.slice(0, 7)}\t`);
  }
  lines.push(`${tags.length} ${tags.length === 1 ? "tag" : "tags"}`);
  if (rest.length) lines.push(`(dates shown for the newest ${TAG_DATES_CAP})`);
  return lines.join("\n") + "\n";
}

// tag names for completion menus
export async function tagNames(token: string, owner: string, repo: string): Promise<string[]> {
  const res = await gh(token, `/repos/${owner}/${repo}/tags?per_page=100`);
  return ((await res.json()) as TagJson[]).map((t) => t.name);
}

// the commits touching a path: a log block without rails, so `explain 3`
// works the same way
const HISTORY_ROWS = 30;

function commitRow(c: CommitJson, refs?: Ref[]): CommitRow {
  return {
    sha: c.sha,
    parents: c.parents.map((p) => p.sha),
    subject: c.commit.message.split("\n")[0],
    author: c.author?.login ?? c.commit.author.name,
    date: c.commit.committer.date,
    refs: refs ?? [],
  };
}

const logRefs = (rows: CommitRow[]): LogRef[] =>
  rows.map((r) => ({ sha: r.sha, parent: r.parents[0] ?? null, subject: r.subject }));

export async function historyBlock(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<LogResult> {
  const q = new URLSearchParams({ path, per_page: String(HISTORY_ROWS) });
  if (ref) q.set("sha", ref);
  let res: Response;
  try {
    res = await gh(token, `/repos/${owner}/${repo}/commits?${q}`);
  } catch (e) {
    if (ref && e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `branch ${ref} not found; run branches to see refs`);
    }
    throw e;
  }
  const commits = (await res.json()) as CommitJson[];
  const where = ref ? ` on ${ref}` : "";
  const n = commits.length;
  const rows = commits.map((c) => commitRow(c));
  const footer = n
    ? [
        `${n === HISTORY_ROWS ? "the latest " : ""}${n} ${n === 1 ? "commit" : "commits"} touching ${path}${where}`,
      ]
    : [`no commits touch ${path}${where}`];
  return { block: { kind: "log", rows, lanes: 0, footer }, rows: logRefs(rows), spans: false };
}

// why a line exists: blame the line on the ref, then the blaming commit
// cut down to that file, with the line itself for the prompt
interface BlameData {
  repository: {
    object: {
      blame: {
        ranges: Array<{
          startingLine: number;
          endingLine: number;
          commit: {
            oid: string;
            messageHeadline: string;
            committedDate: string;
            author: { name: string; user: { login: string } | null };
          };
        }>;
      } | null;
    } | null;
  } | null;
}

const BLAME_QUERY = `query($owner: String!, $name: String!, $expr: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expr) {
      ... on Commit {
        blame(path: $path) {
          ranges {
            startingLine
            endingLine
            commit { oid messageHeadline committedDate author { name user { login } } }
          }
        }
      }
    }
  }
}`;

export interface WhyInput extends ExplainInput {
  question: string; // appended to the user turn after the payload
}

export async function whyInput(
  token: string,
  owner: string,
  repo: string,
  path: string,
  line: number,
  ref?: string
): Promise<WhyInput> {
  const base = `/repos/${owner}/${repo}`;
  if (!ref) {
    const info = await gh(token, base);
    ref = ((await info.json()) as { default_branch: string }).default_branch;
  }
  let fileRes: Response;
  try {
    fileRes = await gh(
      token,
      `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      "application/vnd.github.raw"
    );
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `${path} not found on ${ref}`);
    }
    throw e;
  }
  const text = await fileRes.text();
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (line < 1 || line > lines.length) {
    throw new GithubError(422, `${path} has ${lines.length} lines`);
  }

  const data = await ghql<BlameData>(token, BLAME_QUERY, { owner, name: repo, expr: ref, path });
  const ranges = data.repository?.object?.blame?.ranges ?? [];
  const range = ranges.find((r) => r.startingLine <= line && line <= r.endingLine);
  if (!range) throw new GithubError(404, `no blame for ${path}:${line} on ${ref}`);
  const c = range.commit;

  const input = await commitInput(token, owner, repo, c.oid);
  const cut = filterDiff(input.diff, input.numstat, path);
  const who = c.author.user?.login ?? c.author.name;
  return {
    ...input,
    diff: cut.diff,
    numstat: cut.numstat,
    note: `${path}:${line} last changed in ${c.oid.slice(0, 7)} by ${who}, ${c.committedDate.slice(0, 10)}: ${c.messageHeadline}`,
    question: `\n\nthe line in question, ${path}:${line} on ${ref}:\n${lines[line - 1]}`,
  };
}

// the commit graph: one walk per branch head (capped), unioned by sha,
// laid out with lib/graph into a block the terminal draws as svg
const LOG_WALKS = 12;

export interface LogRef {
  sha: string;
  parent: string | null;
  subject: string;
}

export interface LogResult {
  block: Block;
  rows: LogRef[]; // for `explain 3`
  spans: boolean; // the rows are one contiguous walk, so `explain 2..5` is a range
}

// a filtered log: one author, a window, or both. the rows are no
// longer a contiguous walk, so it is drawn flat, like a file's history
export interface LogFilter {
  since?: string; // a period ("yesterday") or a ref ("v1.2")
  author?: string; // login, or "me"
  login: string; // the signed-in user, for "me"
  now: number;
  tz: number; // minutes, as getTimezoneOffset reports
}

export async function logBlock(
  token: string,
  owner: string,
  repo: string,
  n: number,
  ref?: string,
  filter?: LogFilter
): Promise<LogResult> {
  const base = `/repos/${owner}/${repo}`;
  const author = filter?.author === "me" ? filter.login : filter?.author;
  const window: Window | undefined = filter?.since
    ? (resolvePeriod(filter.since, filter.now, filter.tz) ?? (await refWindow(token, base, filter.since)))
    : undefined;
  const filtered = Boolean(author || window);
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
      const q = new URLSearchParams({ per_page: String(n), sha: h });
      if (window) {
        q.set("since", window.since);
        if (window.until) q.set("until", window.until);
      }
      if (author) q.set("author", author);
      try {
        const res = await gh(token, `${base}/commits?${q}`);
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
  if (window?.skip) byShaMap.delete(window.skip);
  const all = [...byShaMap.values()];
  // the graph only makes sense over a contiguous walk; a filter gives a
  // list, newest first
  const laid = filtered
    ? []
    : layout(
        all.map((c) => ({
          sha: c.sha,
          parents: c.parents.map((p) => p.sha),
          date: c.commit.committer.date,
        }))
      ).slice(0, n);
  const flat = filtered
    ? all
        .sort((a, b) => Date.parse(b.commit.committer.date) - Date.parse(a.commit.committer.date))
        .slice(0, n)
    : [];

  // decorations: the default branch first, then branches, then tags
  const refs = new Map<string, Ref[]>();
  const decorate = (sha: string, name: string, kind: Ref["kind"]) => {
    const list = refs.get(sha) ?? [];
    list.push({ name, kind });
    refs.set(sha, list);
  };
  const defHead = branches.find((b) => b.name === def);
  if (defHead) decorate(defHead.commit.sha, def, "default");
  for (const b of branches) if (b.name !== def) decorate(b.commit.sha, b.name, "branch");
  for (const t of tags) decorate(t.commit.sha, t.name, "tag");

  const rows: CommitRow[] = filtered
    ? flat.map((c) => commitRow(c, refs.get(c.sha)))
    : laid.map((r) => {
        const { sha, ...graph } = r;
        return { ...commitRow(byShaMap.get(sha)!, refs.get(sha)), graph };
      });

  const shown = rows.length;
  const where = ref ? ` on ${ref}` : "";
  const who = author ? ` by ${author}` : "";
  const footer: string[] = [];
  if (filtered && !shown) {
    // rows show a display name when the email is not linked to an
    // account; the api only matches logins
    const when = window ? ` ${window.label}` : "";
    const hint = author ? " (by takes a github login)" : "";
    footer.push(`no commits${when}${who}${where}${hint}`);
    return { block: { kind: "log", rows, lanes: 0, footer }, rows: [], spans: false };
  }
  const latest = filtered && all.length > shown ? "the latest " : "";
  const when = window ? `, ${window.label}` : "";
  const count = `${latest}${shown} ${shown === 1 ? "commit" : "commits"}${where}${who}${when}`;
  if (ref) {
    footer.push(count);
  } else {
    const drawn = Math.min(heads.length, branches.length);
    footer.push(`${count} · ${drawn} ${drawn === 1 ? "branch" : "branches"}`);
    if (branches.length > drawn) footer.push(`(+${branches.length - drawn} branches not drawn)`);
  }
  return {
    block: { kind: "log", rows, lanes: laneCount(laid), footer },
    rows: logRefs(rows),
    spans: !filtered,
  };
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
