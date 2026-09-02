# wd · web

The browser surface of wd: sign in with GitHub, pick a repo, and ask about
it in a terminal. Explains ranges, commits and pull requests, draws the log
graph, follows a file's history, answers why a line exists, and lays out
rebase or cherry-pick plans as git commands to paste. Never writes to
GitHub. Keys stay in the browser.

```
nvm use                  # node 22, see .nvmrc
npm install
npm run dev              # http://localhost:3000
npm test                 # vitest: grammar, preprocessing, providers, usage
npm run build
```

The first visit on localhost (dev server only, never behind a proxy) shows
a one-time setup screen that creates the GitHub OAuth app link and writes
`.env.local`. The command grammar and the
tour are in the root README under `web`; this file is the reference. The
explain prompts and diff preprocessing are specified once in
`../shared/prompts/` and shared with the cli.

## environment

Deployed instances are configured through the environment (`.env.example`
has the same list):

```
GITHUB_CLIENT_ID       oauth app; callback must be $APP_URL/api/auth/callback
GITHUB_CLIENT_SECRET
SESSION_SECRET         32+ random chars (openssl rand -hex 32)
APP_URL                base url of this instance; https turns on secure cookies
WD_ALLOWED_LOGINS      optional: github logins that may sign in, comma-separated
GITHUB_API_URL         optional, for github enterprise (and GITHUB_GRAPHQL_URL)
WD_ANTHROPIC_URL       optional provider gateways, same names as the cli
WD_OPENAI_URL
WD_GROQ_URL
```

## deploy

The app is stateless: no database, no volume, keys and transcripts stay
in each visitor's browser. Hosting it is one node process (or one
container) and the environment above. The setup screen only appears on a
localhost dev server, on purpose: a hosted instance is configured
through env vars alone.

1. Create a GitHub OAuth app (Settings > Developer settings > OAuth
   Apps) with the callback url set to exactly
   `$APP_URL/api/auth/callback`.
2. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`,
   and `APP_URL`. Keep `SESSION_SECRET` stable across restarts, or
   every session cookie dies with it.
3. Optionally set `WD_ALLOWED_LOGINS` to the github logins allowed to
   sign in (comma-separated, case-insensitive). Unset, anyone with a
   github account can use the instance. Removing a login signs that
   account out on its next request.

Behind a reverse proxy, `APP_URL` must be the public origin: it drives
the oauth redirect uri, the same-origin guards, and the cookie secure
flag (an `https://` `APP_URL` sets secure cookies even though the node
process itself speaks http; a mismatched scheme is the one way to break
sign-in). Nothing trusts `x-forwarded-*` headers.

With docker, build from the repo root (the image needs
`../shared/prompts`):

```
docker build -f web/Dockerfile -t wd-web .
docker run -p 3000:3000 \
  -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... \
  -e SESSION_SECRET=... -e APP_URL=https://wd.example.com \
  wd-web
```

or with compose:

```yaml
services:
  wd:
    image: wd-web
    ports: ["3000:3000"]
    environment:
      GITHUB_CLIENT_ID: "..."
      GITHUB_CLIENT_SECRET: "..."
      SESSION_SECRET: "..."
      APP_URL: "https://wd.example.com"
      WD_ALLOWED_LOGINS: "alice,bob"
    restart: unless-stopped
```

## sessions

Sign-in requests the `repo` scope so private repos appear in the picker
(GitHub has no read-only scope for private repos; wd only ever reads). The
session slides: every request renews it, so it ends after a week of silence
or 30 days after sign-in, whichever comes first. An ended session says so in
the transcript and `sign in again →` brings you back to the same repo with
the transcript intact and reruns what failed.

## periods

`today`, `yesterday`, `this week`, `last week`, `this month`, `last
month`, `this year`, `last year`, `since monday` (any weekday), `since 3
days ago`, `since 12 weeks` (or `12w`), `since 2026-08-20`, `since v1.2`
(any ref).
`by <login>` keeps one person's commits, `by me` yours; `standup` is your
commits since the last working day. Days follow your browser's clock; an
empty window says `nothing since yesterday` and costs no model call.

`changelog` and `describe` wrap any diff command and share the cli's output
contracts: the same four sections, the same `title`/`description`/`testing`
draft. `describe pr #42` sees the pr's current title and body and keeps
their intent where the diff still supports it. `/copy` puts the draft on
your clipboard.

## the log, prs, and history

`log` draws colored lanes with curves where branches fork and join, a dot
per commit (a ring for merges), branch and tag chips, subject, author, age,
sha, every row numbered. All branches are walked (the default first, up to
12 heads; the footer says how many were left out), 40 rows by default, up
to 200. A log filtered by `since` or `by` is drawn flat, without lanes,
since its rows are no longer a contiguous walk (so `explain 2..5` asks for
one row at a time).

`prs` lists open pull requests, most recently updated first (30 of them):
number, title, `head → base`, author, age, and `draft`, `merged`, or
`closed` where it applies. `history <path>` lists the commits touching a
file or directory (30 rows, no lanes). `branches` numbers branches with
ahead/behind against the default (the web cousin of `wd ls`); `tags` lists
tags newest first with sha and age.

All of these are blocks you can walk: arrows move (`›` marks the row),
enter opens a commit or pr in place (sha, parents, author, message, files
with their +/−, and `explain`, `changelog`, `describe`, `github ↗`
actions; hovering a file offers `explain`, `history`, and `copy`), esc
steps back out. A command launched from an open panel leaves it open so the
answer still shows where it came from; `/clear` closes them all.

## who, churn, activity, stale

`who <path>` ranks the authors of a file or directory from its last 100
commits, recent work weighing more (half-life six months): commit counts,
shares as bars, and when each person last touched it. `churn` (or
`hotspots`) lists the files changing most, commit counts per path with
their +/−, over a window (`since <period or ref>`, `on <branch>`,
`in <path>`; the newest 50 commits, merges skipped). `activity` draws a
year of weekly commits as a sparkline, then top authors and languages
(`since <period>` cuts the window); GitHub computes those stats lazily,
so on a cold repo the answer is counted from the commit list instead
(the latest 300, a footer says so) rather than making you wait. `stale`
lists
branches with no commits in 8 weeks (`stale 12w`, `stale since
2026-06-01`), oldest first, with ahead/behind like `branches`.

The first three render as stat blocks: bars in the accent color, section
labels in amber, one screenful, no dashboards. They are lookups (no model
call, no key needed) and flatten to text for `/copy` and `/export` like
every block, but there is nothing to walk: after one, the arrows keep
recalling history.

## view and ls

`view <path>` (or `cat <path>`) reads a file in place: numbered lines in
a block capped at 24 rows that scrolls inside (wheel, or the arrows
while it is live; esc steps out). Syntax highlighting maps hljs tokens onto
the palette (comments muted, strings green, keywords violet, numbers
orange, names accent, types teal: the lane colors doubling as token
colors); highlight.js loads lazily and only for known extensions. `view <path>:<line>` opens
scrolled to that line, marked; clicking any line number prefills
`why <path>:<line>` in the prompt (shift+click a second number to span,
`why <path>:<from>-<to>`), so reading a file flows straight into asking
about it. A span blames every line and merges the commits behind it
(the 5 newest commits when there are more). Files are fetched lazily (the transcript stores only
the address), capped at 500k or 5000 lines with a note; binaries and
directories are refused with a pointer to the right command. `ls
[<dir>]` lists a directory, dirs first with sizes, for finding paths at
all. `on <branch>` works on both.

## rebase and cherry-pick plans

`rebase feat/auth` (a branch, a range `rebase main..feat/auth`, a pull
request `rebase pr #42`, the last few commits `rebase last 5 on feat/auth`,
or a span of log rows `rebase 2..5`) lists those commits as an editable
plan, newest first. The paste rewrites a branch from its tip, so a span
that stops short of a branch label takes the rows above it along as
picks; when a merge sits in the way the plan is refused and a cherry-pick
(`pick 2 5 onto <branch>`) is the way to reorder. Reorder a row by dragging it or with shift+up/down, and
set what happens to it with `p` `r` `s` `f` `d` `e` (pick, reword, squash,
fixup, drop, edit) or the buttons in its panel. Edit a message inline, or
let the model draft one from the diff with `draft message`.

`pick 3 5 onto release/1.x` (log rows, shas, or `backport pr #42 to
release/1.x`) is the same block for a cherry-pick: pick or drop, reorder,
done.

Rows can be dragged, too: press a row of a `log`, `prs`, or `history` block
(it shows a grab cursor) and drop it on a branch in a `branches` listing to
start a cherry-pick onto that branch, or into an open plan to add it there,
its files checked against the target on the way in. Esc abandons a drag.

Under the rows sits the block to paste. For a rebase it is the messages and
the todo as heredocs under `/tmp/wd-*` and one `git rebase -i` with
`GIT_SEQUENCE_EDITOR` pointing at the todo, so nothing opens an editor; a
reword or squash with a drafted message becomes `pick` or `fixup` plus
`exec git commit --amend -F`. For a cherry-pick it is `git switch` and `git
cherry-pick -x` (every branch name is shell-quoted). `copy` takes it,
`reset` (once you have changed something) puts the rows back. Before you
paste, a row whose files also changed on the target is flagged in amber and
a verdict line sums up the conflict risk from file overlap; git's own
conflict handling takes over if the guess was wrong. Plans stop at 30
commits and refuse merge commits, since reordering needs a linear history.
Nothing here runs: the commands run in your local clone, and you push.

## keys, models, usage

Keys live in your browser only, one per provider (the prefix decides which:
`sk-ant-` anthropic, `gsk_` groq, anything else openai), travel per request
in a header, and are never stored, logged, or echoed back by the server.
The provider whose key was pasted last is active.

| provider | default model | effort | free tier |
|---|---|---|---|
| anthropic | claude-opus-5 | low, medium, high, xhigh, max | |
| openai | gpt-5.6-terra | none, minimal, low, medium, high, xhigh, max | |
| groq | openai/gpt-oss-120b | (ignored) | console.groq.com |

`/model` switches models (any id accepted; the menu marks each one's
provider, `free`, and `no key`), and picking another provider's model
makes that provider active. `/effort` sets the reasoning effort where the
provider supports it. Both are remembered per provider. Follow-ups resend
the conversation from your browser, with a prompt-cache breakpoint on the
diff for anthropic keys so they stay cheap.

`/usage` shows what each key has cost since it was saved (`anthropic  1.2m
in · 84.3k out · 41 answers · since aug 12`) and the headroom the provider
last reported; `/usage reset [provider]` starts over. Tokens only, never
money: the provider's dashboard is the bill. A key nearly out of headroom
gets an amber warning after the answer.

## keyboard

| keys | |
|---|---|
| enter, up/down, ctrl+r | send; recall history; search it |
| esc | stop a running explain; close a menu or panel |
| tab, enter, esc (menu open) | complete; use; dismiss |
| arrows, enter, esc (after a log, prs, or history) | walk rows; open one; step out |
| arrows, esc (on a file view) | scroll; step out |
| p r s f d e, shift+up/down (in a plan) | set a row's action; move it (drag works too) |
| drag a log / prs row | onto a branch: cherry-pick; into a plan: add it |
| cmd+k / ctrl+k | repo picker |
| ctrl+t, ctrl+1..9, × | new repo tab; switch tabs; close |

Repos open as tabs, each with its own transcript; a streaming explain keeps
going while you are on another tab (a dot after the tab name says so). A
status line under the prompt shows provider, model, effort, and tokens in
use. Hover any control for its purpose and shortcut.

## how it reads

Like the cli: your command in the accent color, section labels in amber, a
green `→` line when something changed, an amber `error:` label with the
same plain-words vocabulary as the cli, muted gray for status. Each answer
closes with its elapsed time, model, and token cost (`· stopped after 2.1s`
if you pressed esc). Motion is short and stops under
`prefers-reduced-motion`.

## limits

`base..head` uses GitHub's three-dot compare (changes on head since it
diverged from base). Ahead/behind counts are computed for the first 15
branches and tag dates for the newest 15. A `since` window covers the
latest 100 commits; `by <login>` fetches that person's commits one by one
up to 20, past which the answer covers the whole span and a note says so.
