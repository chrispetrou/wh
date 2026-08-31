// read-only github fetchers that synthesize cli-shaped explain inputs
// (unified diff + numstat lines + commit lines) so the shared preprocess
// spec applies unchanged.

import type { Block, CommitRow, PlanRow, Ref, StatRow } from "./block";
import type { CommitDetail, PrDetail } from "./chat-store";
import { LATEST_TAG } from "./commands";
import { filterDiff } from "./explain/filter";
import { laneCount, layout } from "./graph";
import { resolvePeriod } from "./time";
import { relTime } from "./utils";

// overridable for github enterprise (and tests), read per call so a
// first-run setup that writes .env.local is seen without a restart
const api = () => process.env.GITHUB_API_URL ?? "https://api.github.com";
const graphqlUrl = () => process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";

// owner and repo names as github allows them, checked before either is
// placed in an api path
const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
export function validSlug(owner: string, repo: string): boolean {
  // "." and ".." pass the character class but fetch would normalize them
  // out of the path
  return [owner, repo].every((s) => SLUG.test(s) && s !== "." && s !== "..");
}

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
  const res = await fetch(`${api()}${path}`, {
    headers: headers(token, accept),
    cache: "no-store",
  });
  if (res.ok) return res;
  throw failure(res);
}

// graphql, only where rest has no answer (blame). same errors, same token
async function ghql<T>(token: string, query: string, variables: object): Promise<T> {
  const res = await fetch(graphqlUrl(), {
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
    // relative: the server's clock is not the user's timezone
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const mins = reset ? Math.ceil((reset - Date.now()) / 60_000) : 0;
    const when = mins > 1 ? `in ${mins} min` : mins === 1 ? "in a minute" : "in a moment";
    return new GithubError(res.status, `github rate limit, try again ${when}`);
  }
  return new GithubError(res.status, `github error (${res.status})`);
}

// /commits/{ref} answers 422 (not 404) for a ref that does not resolve
const unknownRef = (e: unknown): boolean =>
  e instanceof GithubError && (e.status === 404 || e.status === 422);

// one list of commits; github pages at 100, so n above that takes several
async function commitList(
  token: string,
  path: string,
  q: URLSearchParams,
  n: number
): Promise<CommitJson[]> {
  const per = Math.min(n, 100);
  const out: CommitJson[] = [];
  for (let page = 1; out.length < n; page++) {
    q.set("per_page", String(per));
    q.set("page", String(page));
    const res = await gh(token, `${path}?${q}`);
    const list = (await res.json()) as CommitJson[];
    out.push(...list);
    if (list.length < per) break;
  }
  return out.slice(0, n);
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
  const q = new URLSearchParams();
  if (ref) q.set("sha", ref);
  let commits: CommitJson[];
  try {
    commits = await commitList(token, `/repos/${owner}/${repo}/commits`, q, n + 1);
  } catch (e) {
    if (ref && unknownRef(e)) {
      throw new GithubError(404, `branch ${ref} not found; run branches to see refs`);
    }
    throw e;
  }
  if (!commits.length) throw new GithubError(422, "not enough history to compare");
  // a root alone: its own diff, no range to compare
  if (commits.length === 1) return commitInput(token, owner, repo, commits[0].sha);
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
    if (unknownRef(e)) throw new GithubError(404, `commit ${sha} not found in this repo`);
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
    if (unknownRef(e)) throw new GithubError(404, `commit ${sha} not found in this repo`);
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
    if (unknownRef(e)) throw new GithubError(404, `unknown ref ${ref}; run branches to see refs`);
    throw e;
  }
  const c = (await res.json()) as CommitJson;
  return { since: c.commit.committer.date, skip: c.sha, label: `since ${ref}` };
}

// several commits as one input: diffs concatenated, commit lines joined,
// numstat summed per path
export function mergeInputs(inputs: ExplainInput[]): ExplainInput {
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
    commitCount: inputs.reduce((n, i) => n + i.commitCount, 0),
    truncated: inputs.some((i) => i.truncated),
  };
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
    return {
      ...mergeInputs(inputs),
      note: `${list.length} ${list.length === 1 ? "commit" : "commits"}${who}, ${label}`,
    };
  }

  // walk first parents from the newest commit through the window: the
  // oldest by date may sit on a merged side branch whose parent is far
  // older, which would widen the range past the window
  const inWindow = new Map(list.map((c) => [c.sha, c]));
  let last = newest;
  while (last.parents[0] && inWindow.has(last.parents[0].sha)) last = inWindow.get(last.parents[0].sha)!;
  const parent = last.parents[0]?.sha;
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
  rows.map((r) => {
    const branch = r.refs.find((f) => f.kind !== "tag")?.name;
    return {
      sha: r.sha,
      parent: r.parents[0] ?? null,
      merge: r.parents.length > 1,
      subject: r.subject,
      ...(branch ? { branch } : {}),
    };
  });

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

// who knows a path: its history's authors ranked with recent work
// weighing more (half-life 180 days), so whoever touched it lately
// outranks a departed heavy committer. the counts and shares stay raw
const WHO_COMMITS = 100;
const WHO_ROWS = 10;

export async function whoBlock(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  now = Date.now()
): Promise<{ block: Block }> {
  const q = new URLSearchParams({ path, per_page: String(WHO_COMMITS) });
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
  if (!commits.length) {
    return { block: { kind: "stat", rows: [], footer: [`no commits touch ${path}${where}`] } };
  }

  const byAuthor = new Map<string, { count: number; last: string; score: number }>();
  for (const c of commits) {
    const name = c.author?.login ?? c.commit.author.name;
    const date = c.commit.committer.date;
    const ageDays = Math.max(0, now - Date.parse(date)) / 86_400_000;
    const cur = byAuthor.get(name) ?? { count: 0, last: date, score: 0 };
    cur.count += 1;
    cur.score += 0.5 ** (ageDays / 180);
    if (date > cur.last) cur.last = date;
    byAuthor.set(name, cur);
  }
  const ranked = [...byAuthor].sort((a, b) => b[1].score - a[1].score);
  const rows: StatRow[] = ranked.slice(0, WHO_ROWS).map(([name, w]) => ({
    label: name,
    value: `${w.count} ${w.count === 1 ? "commit" : "commits"}`,
    share: w.count / commits.length,
    note: `last touched ${relTime(w.last, now)}`,
  }));
  const n = commits.length;
  const footer = [
    `${ranked.length} ${ranked.length === 1 ? "author" : "authors"} over ${n === WHO_COMMITS ? "the last " : ""}${n} ${n === 1 ? "commit" : "commits"} touching ${path}${where}`,
    ranked.length > WHO_ROWS
      ? `(top ${WHO_ROWS} shown, recent work weighs more)`
      : "(recent work weighs more)",
  ];
  return { block: { kind: "stat", rows, footer } };
}

// the repo's pulse: the 52-week commit spark, top authors, languages.
// the /stats endpoints answer 202 with an empty body while github
// computes them (a cold repo can take a while), so they get one short
// retry; gh() cannot help (202 is res.ok). null means still computing:
// the commit list, which is always warm, stands in
const STATS_TRIES = 2;
const ACTIVITY_AUTHORS = 8;
const ACTIVITY_LANGS = 6;
const ACTIVITY_FALLBACK_CAP = 300; // commits walked when stats are cold

async function ghStats<T>(token: string, path: string): Promise<T | null> {
  for (let i = 0; i < STATS_TRIES; i++) {
    const res = await fetch(`${api()}${path}`, {
      headers: headers(token, "application/vnd.github+json"),
      cache: "no-store",
    });
    if (res.status === 202) {
      if (i < STATS_TRIES - 1) await new Promise((r) => setTimeout(r, 900 * (i + 1)));
      continue;
    }
    if (!res.ok) throw failure(res);
    return (await res.json()) as T;
  }
  return null;
}

interface WeekJson {
  week: number; // unix seconds
  total: number;
}

interface ContribJson {
  total: number;
  author: { login: string } | null;
  weeks: Array<{ w: number; c: number }>;
}

export interface ActivityOpts {
  since?: string; // a period phrase cutting the weekly buckets
  now: number;
  tz: number; // minutes, as getTimezoneOffset reports
}

export async function activityBlock(
  token: string,
  owner: string,
  repo: string,
  opts: ActivityOpts
): Promise<{ block: Block }> {
  const base = `/repos/${owner}/${repo}`;
  const [weeksRaw, contribRaw, langs] = await Promise.all([
    ghStats<WeekJson[]>(token, `${base}/stats/commit_activity`),
    ghStats<ContribJson[]>(token, `${base}/stats/contributors`),
    gh(token, `${base}/languages`).then((r) => r.json() as Promise<Record<string, number>>),
  ]);
  // null: still computing (202 through the retry); an empty array is
  // github answering with nothing, which huge repos do
  const allWeeks = weeksRaw ?? [];
  const contrib = contribRaw ?? [];
  if (weeksRaw !== null && contribRaw !== null && !allWeeks.length && !contrib.length) {
    return { block: { kind: "stat", rows: [], footer: ["no activity data for this repo"] } };
  }

  const period = opts.since ? resolvePeriod(opts.since, opts.now, opts.tz) : null;
  if (opts.since && !period) throw new GithubError(400, `unknown period ${opts.since}`);
  const from = period ? Date.parse(period.since) : 0;
  const until = period?.until ? Date.parse(period.until) : Infinity;
  const inWindow = (sec: number) => sec * 1000 >= from && sec * 1000 < until;

  // whatever is still computing is counted from the commit list instead
  const start = period ? Date.parse(period.since) : opts.now - 52 * WEEK;
  const end = period?.until ? Date.parse(period.until) : opts.now;
  let fallback: CommitJson[] | null = null;
  if (weeksRaw === null || contribRaw === null) {
    const q = new URLSearchParams({ since: new Date(start).toISOString() });
    if (period?.until) q.set("until", period.until);
    fallback = await commitList(token, `${base}/commits`, q, ACTIVITY_FALLBACK_CAP);
  }
  const fallbackCut = (fallback?.length ?? 0) >= ACTIVITY_FALLBACK_CAP;

  const weeks = allWeeks.filter((w) => inWindow(w.week));
  let spark = weeks.length
    ? {
        values: weeks.map((w) => w.total),
        label: `commits per week, ${period ? period.label : "last 52 weeks"}`,
      }
    : undefined;
  if (weeksRaw === null && fallback?.length) {
    const n = Math.max(1, Math.ceil((end - start) / WEEK));
    const values = new Array<number>(n).fill(0);
    for (const c of fallback) {
      const i = Math.floor((Date.parse(c.commit.committer.date) - start) / WEEK);
      if (i >= 0 && i < n) values[i] += 1;
    }
    spark = {
      values,
      label: `commits per week, ${period ? period.label : "last 52 weeks"}`,
    };
  }

  let counted = contrib
    .map((c) => ({
      login: c.author?.login ?? "unknown",
      count: c.weeks.reduce((n, w) => n + (inWindow(w.w) ? w.c : 0), 0),
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
  if (contribRaw === null && fallback) {
    const byAuthor = new Map<string, number>();
    for (const c of fallback) {
      const name = c.author?.login ?? c.commit.author.name;
      byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
    }
    counted = [...byAuthor]
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count);
  }
  const authorTotal = counted.reduce((n, c) => n + c.count, 0);
  const rows: StatRow[] = counted.slice(0, ACTIVITY_AUTHORS).map((c) => ({
    label: c.login,
    value: `${c.count} ${c.count === 1 ? "commit" : "commits"}`,
    share: authorTotal ? c.count / authorTotal : 0,
    group: "authors",
  }));

  const bytes = Object.entries(langs).sort((a, b) => b[1] - a[1]);
  const byteTotal = bytes.reduce((n, [, b]) => n + b, 0);
  for (const [name, b] of bytes.slice(0, ACTIVITY_LANGS)) {
    const share = byteTotal ? b / byteTotal : 0;
    const pct = Math.round(share * 100);
    rows.push({ label: name.toLowerCase(), value: pct ? `${pct}%` : "<1%", share, group: "languages" });
  }

  const sum =
    weeksRaw !== null
      ? weeks.reduce((n, w) => n + w.total, 0)
      : (spark?.values.reduce((n, v) => n + v, 0) ?? 0);
  const footer = [
    `${sum} ${sum === 1 ? "commit" : "commits"} ${period ? period.label : "in the last 52 weeks"} · ${counted.length} ${counted.length === 1 ? "contributor" : "contributors"}`,
  ];
  if (counted.length > ACTIVITY_AUTHORS) {
    footer.push(`(top ${ACTIVITY_AUTHORS} of ${counted.length} authors shown)`);
  }
  if (fallback) {
    footer.push(
      `(counted from ${fallbackCut ? `the latest ${ACTIVITY_FALLBACK_CAP} commits` : "commits"} while github computes its stats)`
    );
  }
  return { block: { kind: "stat", spark, rows, footer } };
}

// hotspots: commit counts per path over a window, from capped per-commit
// detail fetches (a compare cannot count commits per file). merges are
// skipped: their combined diffs would double-count every side branch
const CHURN_COMMITS_CAP = 50;
const CHURN_ROWS = 15;
const CHURN_CHUNK = 10; // details fetched in bursts this small

export interface ChurnOpts {
  ref?: string;
  since?: string; // a period, or a ref whose commit opens the window
  path?: string;
  now: number;
  tz: number; // minutes, as getTimezoneOffset reports
}

export async function churnBlock(
  token: string,
  owner: string,
  repo: string,
  opts: ChurnOpts
): Promise<{ block: Block }> {
  const base = `/repos/${owner}/${repo}`;
  const q = new URLSearchParams({ per_page: String(CHURN_COMMITS_CAP) });
  let label = "";
  let skip: string | undefined;
  if (opts.since) {
    const w: Window =
      resolvePeriod(opts.since, opts.now, opts.tz) ?? (await refWindow(token, base, opts.since));
    q.set("since", w.since);
    if (w.until) q.set("until", w.until);
    skip = w.skip;
    label = ` ${w.label}`;
  }
  if (opts.ref) q.set("sha", opts.ref);
  if (opts.path) q.set("path", opts.path);

  let res: Response;
  try {
    res = await gh(token, `${base}/commits?${q}`);
  } catch (e) {
    if (opts.ref && e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `branch ${opts.ref} not found; run branches to see refs`);
    }
    throw e;
  }
  const list = (await res.json()) as CommitJson[];
  const cut = list.length >= CHURN_COMMITS_CAP;
  const picked = list.filter((c) => c.sha !== (skip ?? null) && c.parents.length <= 1);

  const where = `${label}${opts.ref ? ` on ${opts.ref}` : ""}${opts.path ? ` in ${opts.path}` : ""}`;
  if (!picked.length) {
    return { block: { kind: "stat", rows: [], footer: [`no commits${where}`] } };
  }

  const details: CommitJson[] = [];
  for (let i = 0; i < picked.length; i += CHURN_CHUNK) {
    details.push(
      ...(await Promise.all(
        picked.slice(i, i + CHURN_CHUNK).map(async (c) => {
          const r = await gh(token, `${base}/commits/${encodeURIComponent(c.sha)}`);
          return (await r.json()) as CommitJson;
        })
      ))
    );
  }

  const dir = opts.path?.replace(/\/+$/, "");
  const under = (f: string) => !dir || f === dir || f.startsWith(`${dir}/`);
  const byFile = new Map<string, { commits: number; adds: number; dels: number }>();
  for (const d of details) {
    for (const f of d.files ?? []) {
      if (!under(f.filename)) continue;
      const cur = byFile.get(f.filename) ?? { commits: 0, adds: 0, dels: 0 };
      cur.commits += 1;
      cur.adds += f.additions;
      cur.dels += f.deletions;
      byFile.set(f.filename, cur);
    }
  }
  const ranked = [...byFile].sort(
    (a, b) => b[1].commits - a[1].commits || b[1].adds + b[1].dels - (a[1].adds + a[1].dels)
  );
  const max = Math.max(1, ...ranked.map(([, f]) => f.commits));
  const rows: StatRow[] = ranked.slice(0, CHURN_ROWS).map(([path, f]) => ({
    label: path,
    value: `${f.commits} ${f.commits === 1 ? "commit" : "commits"}`,
    share: f.commits / max,
    note: `+${f.adds} −${f.dels}`,
  }));

  const n = picked.length;
  const footer = [
    `${byFile.size} ${byFile.size === 1 ? "file" : "files"} over ${n} ${n === 1 ? "commit" : "commits"}${where}`,
  ];
  const notes: string[] = [];
  if (byFile.size > CHURN_ROWS) notes.push(`top ${CHURN_ROWS} shown`);
  if (cut) notes.push(`the ${CHURN_COMMITS_CAP} newest commits only`);
  notes.push("merges skipped");
  footer.push(`(${notes.join(" · ")})`);
  return { block: { kind: "stat", rows, footer } };
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
  merge: boolean; // a rebase over rows refuses these client side, by row number
  branch?: string; // a branch tip: a rebase over rows must start at one
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
      const q = new URLSearchParams({ sha: h });
      if (window) {
        q.set("since", window.since);
        if (window.until) q.set("until", window.until);
      }
      if (author) q.set("author", author);
      try {
        // one past the budget tells a cut walk from a short one
        return await commitList(token, `${base}/commits`, q, n + 1);
      } catch (e) {
        if (ref && unknownRef(e)) {
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

// branches gone quiet: heads older than a cutoff, oldest first, with
// ahead/behind vs the default like branchesText. head dates come from one
// graphql query; rest would cost a commit lookup per branch
export const STALE_WEEKS_DEFAULT = 8;
const WEEK = 7 * 86_400_000;

const STALE_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100) {
      nodes { name target { ... on Commit { committedDate } } }
    }
  }
}`;

interface StaleRefsData {
  repository: {
    refs: { nodes: Array<{ name: string; target: { committedDate?: string } | null }> };
  } | null;
}

export interface StaleOpts {
  weeks?: number;
  since?: string; // a period phrase; the cutoff is its start
  now: number;
  tz: number; // minutes, as getTimezoneOffset reports
}

export async function staleText(
  token: string,
  owner: string,
  repo: string,
  opts: StaleOpts
): Promise<string> {
  const [infoRes, data] = await Promise.all([
    gh(token, `/repos/${owner}/${repo}`),
    ghql<StaleRefsData>(token, STALE_QUERY, { owner, name: repo }),
  ]);
  const def = ((await infoRes.json()) as { default_branch: string }).default_branch;
  const nodes = data.repository?.refs.nodes ?? [];

  const period = opts.since ? resolvePeriod(opts.since, opts.now, opts.tz) : null;
  if (opts.since && !period) throw new GithubError(400, `unknown period ${opts.since}`);
  const weeks = opts.weeks ?? STALE_WEEKS_DEFAULT;
  const cutoff = period ? Date.parse(period.since) : opts.now - weeks * WEEK;
  const label = period
    ? `no commits ${period.label}`
    : `no commits in ${weeks} ${weeks === 1 ? "week" : "weeks"}`;

  const stale = nodes
    .filter((n) => n.name !== def && n.target?.committedDate)
    .map((n) => ({ name: n.name, date: Date.parse(n.target!.committedDate!) }))
    .filter((h) => h.date < cutoff)
    .sort((a, b) => a.date - b.date);
  if (!stale.length) return `no stale branches (${label})\n`;

  const counts = new Map(
    await Promise.all(
      stale.slice(0, BRANCH_COUNTS_CAP).map(async (b): Promise<[string, string]> => {
        try {
          const res = await gh(
            token,
            `/repos/${owner}/${repo}/compare/${encodeURIComponent(def)}...${encodeURIComponent(b.name)}`
          );
          const j = (await res.json()) as { ahead_by: number; behind_by: number };
          const parts: string[] = [];
          if (j.ahead_by > 0) parts.push(`ahead ${j.ahead_by}`);
          if (j.behind_by > 0) parts.push(`behind ${j.behind_by}`);
          return [b.name, parts.join(" · ")];
        } catch {
          return [b.name, ""];
        }
      })
    )
  );

  const age = (t: number) => {
    const w = Math.floor((opts.now - t) / WEEK);
    return w >= 1 ? `${w}w ago` : `${Math.max(1, Math.floor((opts.now - t) / 86_400_000))}d ago`;
  };
  const width = Math.max(...stale.map((b) => b.name.length)) + 2;
  const numWidth = String(stale.length).length;
  const lines = stale.map((b, i) => {
    const status = [`last commit ${age(b.date)}`, counts.get(b.name) ?? ""]
      .filter(Boolean)
      .join(" · ");
    return `${String(i + 1).padStart(numWidth)}  ${b.name.padEnd(width)}${status}`.trimEnd();
  });
  lines.push(`${stale.length} of ${nodes.length} branches stale (${label})`);
  if (stale.length > BRANCH_COUNTS_CAP) {
    lines.push(`(ahead/behind for the first ${BRANCH_COUNTS_CAP})`);
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

// a rebase or cherry-pick plan: the commits between a base and a head
// (or a pr's, or the last n, or given shas), each with its files, and
// which of those files also changed on the target since the merge base.
// nothing is written; the block flattens to commands the user pastes
export const PLAN_CAP = 30;
export const PLAN_CLASH_CAP = 20;

export type PlanSource =
  | { kind: "range"; base: string; head: string }
  | { kind: "pr"; num: number }
  | { kind: "last"; n: number; ref?: string }
  | { kind: "shas"; shas: string[] };

interface PlanSet {
  commits: CommitJson[]; // oldest first
  base: { sha: string; ref?: string };
  head?: string;
}

function tooMany(n: number): GithubError {
  return new GithubError(422, `that is ${n} commits; plans stop at ${PLAN_CAP}`);
}

const isSha = (s: string) => /^[0-9a-f]{7,40}$/i.test(s);

async function planSet(
  token: string,
  root: string,
  source: PlanSource,
  pick: boolean
): Promise<PlanSet> {
  if (source.kind === "range") {
    let { base, head } = source;
    if (!head || !base) {
      const info = await gh(token, root);
      const def = ((await info.json()) as { default_branch: string }).default_branch;
      head = head || def;
      base = base || def;
    }
    let res: Response;
    try {
      res = await gh(token, `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    } catch (e) {
      if (e instanceof GithubError && e.status === 404) {
        throw new GithubError(404, `unknown ref in ${base}..${head}; run branches to see refs`);
      }
      throw e;
    }
    const json = (await res.json()) as {
      total_commits: number;
      base_commit: { sha: string };
      commits: CommitJson[];
    };
    if (json.total_commits > PLAN_CAP) throw tooMany(json.total_commits);
    if (!json.commits.length) {
      throw new GithubError(422, `nothing to rebase: ${head} is up to date with ${base}`);
    }
    // a sha end is not a branch: nothing to switch to, nothing to name
    return {
      commits: json.commits,
      base: { sha: json.base_commit.sha, ...(isSha(base) ? {} : { ref: base }) },
      ...(isSha(head) ? {} : { head }),
    };
  }
  if (source.kind === "pr") {
    const path = `${root}/pulls/${source.num}`;
    let prRes: Response;
    let listRes: Response;
    try {
      [prRes, listRes] = await Promise.all([
        gh(token, path),
        gh(token, `${path}/commits?per_page=${PLAN_CAP + 1}`),
      ]);
    } catch (e) {
      if (e instanceof GithubError && e.status === 404) {
        throw new GithubError(404, `pr #${source.num} not found in this repo`);
      }
      throw e;
    }
    const pr = (await prRes.json()) as {
      merged: boolean;
      commits: number;
      base: { ref: string; sha: string };
      head: { ref: string };
    };
    // a rebase of a merged pr has nothing left to rewrite; a backport
    // is exactly that
    if (pr.merged && !pick) throw new GithubError(422, `pr #${source.num} is merged; nothing to plan`);
    if (pr.commits > PLAN_CAP) throw tooMany(pr.commits);
    const commits = (await listRes.json()) as CommitJson[];
    return { commits, base: { sha: pr.base.sha, ref: pr.base.ref }, head: pr.head.ref };
  }
  if (source.kind === "last") {
    if (source.n > PLAN_CAP) throw tooMany(source.n);
    const q = new URLSearchParams({ per_page: String(Math.min(source.n, PLAN_CAP) + 1) });
    if (source.ref) q.set("sha", source.ref);
    let res: Response;
    try {
      res = await gh(token, `${root}/commits?${q}`);
    } catch (e) {
      if (source.ref && e instanceof GithubError && e.status === 404) {
        throw new GithubError(404, `branch ${source.ref} not found; run branches to see refs`);
      }
      throw e;
    }
    const list = (await res.json()) as CommitJson[];
    if (list.length < 2) throw new GithubError(422, "not enough history to plan a rebase");
    const shown = Math.min(source.n, list.length - 1);
    const commits = list.slice(0, shown).reverse();
    return { commits, base: { sha: list[shown].sha }, head: source.ref };
  }
  if (source.shas.length > PLAN_CAP) throw tooMany(source.shas.length);
  const commits = await Promise.all(source.shas.map((sha) => commitJson(token, root, sha)));
  commits.sort((a, b) => Date.parse(a.commit.committer.date) - Date.parse(b.commit.committer.date));
  // dates tie to the second after a rebase; a parent always goes first
  for (let i = 0; i < commits.length; i++) {
    const parents = new Set(commits[i].parents.map((p) => p.sha));
    const j = commits.findIndex((c, k) => k > i && parents.has(c.sha));
    if (j > i) {
      const [parent] = commits.splice(j, 1);
      commits.splice(i, 0, parent);
      i = -1; // start over: the move can unsettle an earlier pair
    }
  }
  return { commits, base: { sha: commits[0].sha } };
}

async function commitJson(token: string, root: string, sha: string): Promise<CommitJson> {
  let res: Response;
  try {
    res = await gh(token, `${root}/commits/${encodeURIComponent(sha)}`);
  } catch (e) {
    if (unknownRef(e)) throw new GithubError(404, `commit ${sha} not found in this repo`);
    throw e;
  }
  return (await res.json()) as CommitJson;
}

// the files changed on `target` since its merge base with `from`
async function changedOn(token: string, root: string, from: string, target: string): Promise<Set<string>> {
  const res = await gh(token, `${root}/compare/${encodeURIComponent(from)}...${encodeURIComponent(target)}`);
  const json = (await res.json()) as { files?: Array<{ filename: string }> };
  return new Set((json.files ?? []).map((f) => f.filename));
}

export async function planBlock(
  token: string,
  owner: string,
  repo: string,
  source: PlanSource,
  onto?: string
): Promise<{ block: Block }> {
  const root = `/repos/${owner}/${repo}`;
  const set = await planSet(token, root, source, Boolean(onto));
  // a cherry-pick lands on the target's tip; the lookup also proves it exists
  if (onto) {
    let res: Response;
    try {
      res = await gh(token, `${root}/commits/${encodeURIComponent(onto)}`);
    } catch (e) {
      if (unknownRef(e)) throw new GithubError(404, `unknown ref ${onto}; run branches to see refs`);
      throw e;
    }
    set.base = { sha: ((await res.json()) as CommitJson).sha, ref: onto };
  }
  const n = set.commits.length;
  // the server never sees row numbers, so the merge is named by sha
  const merge = set.commits.find((c) => c.parents.length > 1);
  if (merge) {
    throw new GithubError(422, `rebase plans need a linear history; ${merge.sha.slice(0, 7)} is a merge`);
  }
  // files per commit: the compare and list endpoints carry none
  const detailed = await Promise.all(
    set.commits.map((c) => (c.files ? Promise.resolve(c) : commitJson(token, root, c.sha)))
  );
  const rows: PlanRow[] = [...detailed].reverse().map((c, i) => ({
    ...commitRow(c),
    idx: i,
    message: c.commit.message,
    files: (c.files ?? []).map((f) => f.filename),
    clash: [],
    action: "pick",
  }));
  const footer: string[] = [];
  if (onto) {
    const checked = rows.slice(0, PLAN_CLASH_CAP);
    const changed = await Promise.all(checked.map((r) => changedOn(token, root, r.sha, onto)));
    checked.forEach((r, i) => (r.clash = r.files.filter((f) => changed[i].has(f))));
    footer.push(`${n} ${n === 1 ? "commit" : "commits"} onto ${onto}`);
    if (rows.length > PLAN_CLASH_CAP) {
      footer.push(`(conflict check on the newest ${PLAN_CLASH_CAP} only)`);
    }
  } else {
    const changed = await changedOn(token, root, rows[0].sha, set.base.sha);
    for (const r of rows) r.clash = r.files.filter((f) => changed.has(f));
    const where = set.base.ref ?? set.base.sha.slice(0, 7);
    footer.push(`${n} ${n === 1 ? "commit" : "commits"}, ${set.head ?? "these commits"} onto ${where}`);
    if (changed.size >= 300) footer.push("(the target changed more than 300 files; the check is partial)");
  }
  return {
    block: {
      kind: "plan",
      mode: onto ? "pick" : "rebase",
      base: set.base,
      head: set.head,
      onto,
      rows,
      footer,
    },
  };
}

// one commit as a plan row, for a log row dropped into a plan: its files
// and, of those, the ones changed on the target since the merge base.
// the client gives it a position and an idx
export async function planRow(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  target: string
): Promise<PlanRow> {
  const root = `/repos/${owner}/${repo}`;
  const c = await commitJson(token, root, sha);
  if (c.parents.length > 1) throw new GithubError(422, `${sha.slice(0, 7)} is a merge; plans need plain commits`);
  const files = (c.files ?? []).map((f) => f.filename);
  let changed: Set<string>;
  try {
    changed = await changedOn(token, root, c.sha, target);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      throw new GithubError(404, `unknown ref ${target}; run branches to see refs`);
    }
    throw e;
  }
  return {
    ...commitRow(c),
    idx: 0,
    message: c.commit.message,
    files,
    clash: files.filter((f) => changed.has(f)),
    action: "pick",
  };
}
