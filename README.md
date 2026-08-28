# wd

Tiny git companion. Worktrees, minus the ceremony. Diffs, in plain English.

**wd** is a single-binary git companion with two jobs: managing worktrees so
branch-switching never touches your working state, and explaining diffs in
plain English so review starts with understanding, not archaeology.

It is local-first and telemetry-free. Explanations run on your own key:
Anthropic, OpenAI, Groq (free tier), or a local model via Ollama. Everything
else needs nothing but git.

Written in Rust. One binary, no runtime.

## install

From a clone (or straight from git):

```
cargo install --path cli
# or, without cloning:
cargo install --git https://github.com/chrispetrou/wd wd
```

That puts `wd` on your PATH via `~/.cargo/bin`. Then add the shell wrapper
so `wd switch` can actually change directory:

```
echo 'eval "$(wd init zsh)"' >> ~/.zshrc     # bash: ~/.bashrc
wd init fish | source                        # fish: add to config.fish
```

Needs git 2.31+ and, for `wd explain`, curl (both ship with macOS and
virtually every Linux). A `curl | bash` installer with prebuilt binaries
comes with the first release.

## commands

```
$ wd new feat/auth
created worktree ../repo.feat-auth
copied .env .env.local
→ ready feat/auth checked out
```

`wd new <branch>` creates a worktree in a predictable sibling directory
(`<repo>.<branch>`, slashes become dashes) and copies your untracked `.env*`
files into it. The branch is created from `HEAD` if it doesn't exist
(`--from <ref>` to branch from elsewhere).

```
$ wd ls
main          clean
feat/auth     clean
fix/nav-323   2 dirty   ·  ahead 3
spike/wasm    clean     ·  behind 12
```

`wd ls` lists worktrees with dirty-file counts and ahead/behind against
upstream.

```
$ wd switch
? select worktree au▏
› feat/auth    clean
→ switched ../repo.feat-auth
```

`wd switch` opens a picker over your worktrees: type to filter, arrows (or
ctrl-p/ctrl-n) to move, enter to select, esc to cancel. With the shell
wrapper installed it is a real `cd`. `wd switch <query>` skips the picker
when the match is unique.

```
$ wd explain HEAD~3..
reading 3 commits · 14 files · +212 −87
summary
Moves session handling from cookies to signed JWTs.
...
watch out
logout() no longer clears server state ...
```

`wd explain [range]` reads a diff range (default `HEAD~1..`; a bare ref
means `<ref>..HEAD`) and streams a plain-English summary with a
"watch out" section. Lockfiles, vendored paths, and binaries are
excluded, and large diffs are truncated (see `shared/prompts/`).
`--dry-run` prints the preprocessed payload instead of asking the model.
`--changelog` asks for release notes instead of a review: `added`,
`changed`, `fixed`, `removed` sections (empty ones left out), one line
per user-visible change, so `wd explain --changelog v1.1..v1.2` drafts
the notes for a tag.

```
$ wd rm
would remove ../repo.feat-auth (feat/auth)
remove 1 worktree? [y/N]
```

`wd rm` prunes worktrees whose branches are merged into the default branch
(and deletes the branches). It never touches dirty worktrees, the main
worktree, or the one you're standing in. `--dry-run` previews, `--yes` skips
the prompt, `wd rm <branch> --force` removes a specific worktree even if
dirty or unmerged (the escape hatch for squash-merged branches, which plain
ancestor detection can't see).

## configuration (explain)

Environment only, no config files:

```
ANTHROPIC_API_KEY   used if set (model: claude-opus-5)
OPENAI_API_KEY      used if no anthropic key (model: gpt-5-mini)
GROQ_API_KEY        used if neither (model: llama-3.3-70b-versatile)
                    none set: local ollama (model: llama3.2)
WD_PROVIDER         force one of: anthropic, openai, groq, ollama
WD_MODEL            override the model for any provider
WD_OLLAMA_URL       default http://localhost:11434
WD_GROQ_URL         default https://api.groq.com/openai
```

Paid keys win the auto-detect so nobody is silently downgraded;
`WD_PROVIDER=groq` opts into the free one. Groq's free tier
(console.groq.com) is the no-cost hosted option; Ollama is the no-key
option.

Nothing is sent anywhere unless you run `wd explain`. There is no
telemetry.

## terminal or web

Same tool, two surfaces. The cli is for the repo in front of you: it
runs on your machine, reads your local git, and manages worktrees. The
web app is for any repo you can see on GitHub, including ones you never
cloned: sign in, pick a repo, ask. Both explain diffs from the same spec
(`shared/prompts/`), so an answer reads the same wherever you ask.

```
                    terminal (wd)                 web
worktrees           new, ls, switch, rm           (cli only)
explain a range     wd explain main..dev          diff main..dev
last N commits      wd explain HEAD~3..           explain the last 3 commits
                                                  (on <branch> to scope it)
a pull request      fetch the branch, then a range prs, then what changed in pr #42
one commit          wd explain <sha>~1..<sha>     explain <sha>
the graph           git log --graph               log, then explain 3
time and people     git log --since, --author     since yesterday by me, standup
release notes       wd explain --changelog v1..   changelog v1.1..v1.2
a file's story      git log -p -- <path>          history <path>, why <path>:<line>
branches            wd ls (worktrees, dirty)      branches (ahead/behind), tags
follow-ups          (not yet)                     plain words after an explain
raw payload         wd explain --dry-run          /show
keys                env: ANTHROPIC_API_KEY, ...   pasted once, kept in browser
providers           anthropic, openai, groq,      anthropic, openai, groq
                    ollama
model / effort      WD_MODEL, WD_PROVIDER         /model, /effort, per provider
private repos       whatever git can reach        github oauth, repo scope
```

Pick the terminal when the diff is local, uncommitted, or on a machine
with no GitHub access, when you want a no-key model via Ollama, or when
the job is worktrees. Pick the web when the repo lives on GitHub and you
want to ask about a PR or a branch without cloning it, keep several
repos open as tabs, or ask follow-up questions about the same diff.
Muscle memory carries over: the web terminal accepts `wd explain
HEAD~3..` verbatim, and `/wd` inside it lists the cli commands.

Keys never cross between the two. The cli reads them from the
environment on your machine; the web app keeps them in your browser and
sends them per request, and its server never stores or logs them.

## web

The web app (`web/`) is wd explain for any GitHub repo, in the browser:
sign in with GitHub, pick a repo, and ask in a full-page terminal:

```
explain the last 5 commits [on <branch>]
what changed in pr #42
diff main..release
log [N] [on <branch>]
explain 3 (a row of the log), explain 2..5, explain <sha>
since yesterday | this week | v1.2 [by <login>], standup
changelog [v1.1..v1.2 | since v1.2 | pr #42]
history src/git.rs, explain the last 5 commits in src/, why src/git.rs:42
branches, tags, prs [open | closed | mine]
```

Phrasing is flexible: `summarize`, `show me`, and `what changed in` work
as leading verbs, `pull request 42` and bare `#42` name a PR,
`what changed in <branch>` compares a branch against the default, and
cli-style input like `wd explain HEAD~3..` or open ranges (`main..`)
works exactly as it does in the terminal.

Ranges take any refs, `on <branch>` scopes the last-N commands to a
branch, and `branches` lists branches numbered with ahead/behind
against the default (the web cousin of `wd ls`; worktrees themselves
live in the cli). Wherever a branch name belongs, the completion menu
drops down with the repo's branches, filtered as you type.

`log` draws the commit graph inside the transcript: colored lanes with
curves where branches fork and join, a dot per commit (a ring for
merges), branch and tag chips, subject, author, age, and sha, every
row numbered. All branches are walked (the default branch first, up to
12 heads; the footer says how many were left out) and unioned into one
graph; `log 100` shows more rows, `log on <branch>` scopes to one
branch. After a `log`, the arrow keys walk its rows (`›` marks the one
selected), enter opens a commit in place (full sha, parents, author,
message, files with their +/−, and `explain`, `changelog`, `github ↗`
actions; hovering a file offers `explain` (that commit, cut to the
file), `history` (the file's story), and `copy` (its path); a parent
jumps to its row), esc steps back out, and clicking a row does the
same. A command launched from an open panel leaves the panel open, so
the answer below it still shows where it came from; only /clear closes
them all. The session slides: every request renews it, so it only ends
after a week of silence, with a hard ceiling of 30 days from sign-in
(or when the token is revoked). If it has
ended, an opened row or a command says `your github session ended` and
offers `sign in again →`: the page goes to GitHub and comes straight
back to the same repo, transcript intact, prints `→ signed in as you`
under the error, and reruns the command or reopens the row that
failed. The numbers
still work as words: `explain 3` explains that commit, `explain 2..5`
the span of rows (from the parent of row 5 to row 2), and `explain
<sha>` takes any sha directly; typing `explain ` with a log on screen
offers the rows in the completion menu.

Time and people work as words: `since yesterday`, `since monday`, `this
week`, `last week`, `since 3 days ago`, `since 2026-08-20`, or `since
v1.2` for a ref. Add `by <login>` for one person's commits, `by me` (or
`what did i do this week`, `my commits since v1.2`) for your own, and
`standup` for your commits since the last working day. Days follow your
browser's clock. An empty window says `nothing since yesterday` and
costs no model call.

`changelog` frames any of those as release notes instead of a review:
`changelog v1.1..v1.2`, `changelog since v1.2`, `release notes for pr
#42`, `changelog of the last 10 commits`, or bare `changelog` for
everything since the newest tag. The answer comes as `added`,
`changed`, `fixed`, `removed` sections (empty ones left out), one line
per user-visible change, the same contract as `wd explain --changelog`
in the cli. `tags` lists tags newest first with their sha and age, and
tag names join branch names in the completion menu wherever a ref
belongs (`since `, `changelog `, ranges).

`prs` lists open pull requests, most recently updated first (`closed
prs`, `my prs`): number, title, `head → base`, author, age, and `draft`,
`merged`, or `closed` where it applies. It is the same kind of block as
the log: arrows and enter open a pr in place (state, branches,
description, files, and `explain` / `changelog` actions). Typing `pr `
afterwards offers those numbers in the completion menu, and `what
changed in pr #42` shows the pr's state under its title: `draft`,
`mergeable`, or `conflicts with base`.

Files have a history too. `history src/git.rs` (or a directory, `on
<branch>` to scope) lists the commits touching it as a log block
without lanes, numbered and navigable the same way, so `explain 3`
follows. (`log` is the whole repo across branches; `history` always
takes a path.) Opening a row shows what the row already knows at once
and fills in parents, message, and files as they arrive; nothing spins. Any explain takes `in <path>` to cut the
diff down to one file or directory before the model sees it: `explain
the last 5 commits in src/`, `what changed in src/git.rs since v1.2`,
`changelog of pr 42 in docs/`; the header says `2 of 14 files, under
src/`. And `why src/git.rs:42` (or `why line 42 of src/git.rs`, `on
<ref>` to pick the version) blames the line, fetches the commit that
last touched it cut down to that file, and asks the model why the line
exists and what would break without it: a `why` section, then `watch
out`, with the blaming commit noted under the header so `explain
<sha>` can follow.

It uses the same explain spec as the CLI (`shared/prompts/`), on your own
LLM keys. The first time a repo opens with no key stored, the terminal
asks for one: paste it as the first message and it is kept in your
browser only (one per provider, the key prefix decides which), sent per
request, never stored or logged server-side, and never echoed back.
`/key <value>` adds or replaces one later; `/key` lists them; `/key
clear groq` removes one, `/key clear` all of them. The provider whose
key was pasted last is active; `/model` switches: picking another
provider's model (any id accepted; the menu marks each model's provider,
`free` where there is a no-cost tier, and `no key` where you have none)
makes that provider active, defaulting to claude-opus-5 for anthropic,
gpt-5-mini for openai, and llama-3.3-70b-versatile for groq (keys start
with `gsk_`; groq has a free tier at console.groq.com). `/effort` sets
the reasoning effort where the provider supports it (anthropic: low to
max, openai: minimal to high; groq ignores it), and switching to such a
provider opens the effort menu right away. Model and effort are
remembered per provider.

Typing `/` opens a completion menu of every slash command with its
options: `/help`, `/repos`, `/key`, `/model`, `/effort`, `/theme` (auto,
light, or dark), `/font` (fira, jetbrains, plex, or the system default),
`/fontsize`, `/ligatures`, `/show` (the raw diff payload, pager-colored),
`/copy` (the last answer to the clipboard), `/export` (save the
transcript), `/account`, `/info`, `/wd`, `/stop`, `/clear`, `/logout`.
Arrows navigate the menu, tab completes, enter uses, esc closes; up/down
recalls history, ctrl+r searches it, esc stops a running explain, and
cmd+k jumps back to the repo picker.

The transcript reads like the cli: your command in the accent color,
`summary` and `watch out` in amber, a green `→` line when something
changed (`→ model claude-sonnet-5`, `→ saved wd-owner-repo.txt`), an
amber `error:` label when something failed (in plain words, never the
provider's raw json: `the diff is too big for gpt-5-mini: 17842 tokens,
limit 8192`, `your groq key is out of credit`, `provider rate limit, try
again in 12s`, `provider is overloaded, try again in a moment`, `could
not reach api.groq.com`; a muted line under it says the way out where
there is one, like the billing page to top up at), and muted gray
for status
(`reading 3 commits · 14 files · +212 −87`). Each answer closes with its
elapsed time and model (`· 8.4s · claude-opus-5`; `· stopped after 2.1s`
if you pressed esc), commands and their output group into blocks, and
scrolling up to read earlier output is never interrupted by new lines.
Motion is quiet and short: state changes ease in (an error, a `→` line,
a panel opening, a block landing, a page settling after navigation,
the theme cross-fading), streamed text and anything driven by the
keyboard never animate, and everything stops under
`prefers-reduced-motion`.

After an explain, plain words are follow-up questions: "why is that
risky?", "which files touch auth?". Answers stay grounded in the same
diff; a new command or /clear starts fresh. The conversation lives in
your browser only and is resent per turn (with a prompt-cache
breakpoint on the diff for anthropic keys, so follow-ups stay cheap).

Repos open as tabs: a quiet tab bar under the header lets you work on
several repos at once, each with its own history. A streaming explain
keeps going while you are on another tab. ctrl+t opens a new tab via
the picker, ctrl+1..9 switches, × closes.

Hover any control for its purpose and shortcut, and a status line under
the prompt shows the provider, model, and effort in use. A tab whose
explain is still streaming shows a dot after its name.

Notes:

- Sign-in requests the `repo` scope so private repos appear in the
  picker. GitHub has no read-only scope for private repos; wd only ever
  reads (commits, diffs, pull requests).
- `base..head` uses GitHub's three-dot compare: changes on head since it
  diverged from base.

To run it yourself (Node 20+):

```
cd web
npm install
npm run dev
```

Then open http://localhost:3000: the first run shows a one-time setup
screen that links to a prefilled GitHub OAuth-app form and saves the
pasted client id and secret to `web/.env.local` for you. The setup
screen only appears on localhost while unconfigured; deployed instances
are configured through the environment instead (see `.env.example`, the
callback must be `$APP_URL/api/auth/callback`).

`npm test` runs the golden fixtures + grammar suites. The shared spec is
embedded at build time by `scripts/sync-shared.mjs`; edit
`shared/prompts/`, never the generated file.

## layout

```
cli/     rust cli: the wd binary
web/     next.js app: wd explain for any github repo
site/    landing page
shared/  explain spec: prompt template, diff preprocessing rules,
         and golden fixtures both implementations must reproduce
```

## building

```
cd cli && cargo build --release   # binary at target/release/wd
cd cli && cargo test
cd web && npm test && npm run build
```

MIT license.
