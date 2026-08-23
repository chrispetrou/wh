# wd

Tiny git companion. Worktrees, minus the ceremony. Diffs, in plain English.

**wd** is a single-binary git companion with two jobs: managing worktrees so
branch-switching never touches your working state, and explaining diffs in
plain English so review starts with understanding, not archaeology.

It is local-first and telemetry-free. Explanations run on your own key:
Anthropic, OpenAI, or a local model via Ollama. Everything else needs nothing
but git.

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
                    neither set: local ollama (model: llama3.2)
WD_PROVIDER         force one of: anthropic, openai, ollama
WD_MODEL            override the model for any provider
WD_OLLAMA_URL       default http://localhost:11434
```

Nothing is sent anywhere unless you run `wd explain`. There is no
telemetry.

## web

The web app (`web/`) is wd explain for any GitHub repo, in the browser:
sign in with GitHub, pick a repo, and ask in a full-page terminal:

```
explain the last 5 commits
what changed in pr #42
diff main..release
```

Phrasing is flexible: `summarize`, `show me`, and `what changed in` work
as leading verbs, `pull request 42` and bare `#42` name a PR, and
cli-style input like `wd explain HEAD~3..` or open ranges (`main..`)
works exactly as it does in the terminal.

It uses the same explain spec as the CLI (`shared/prompts/`), on your own
LLM key: pasted once into the terminal, stored only in your browser, sent
per request, never stored or logged server-side. `/model` picks the model
the same way (any id accepted, stored in your browser, sent per request);
its suggestions follow your key's provider, defaulting to claude-opus-5
for anthropic keys and gpt-5-mini for openai keys.

Typing `/` opens a completion menu of every slash command with its
options: `/help`, `/repos`, `/key`, `/model`, `/theme`, `/font`
(fira, jetbrains, plex, or the system default), `/fontsize`,
`/ligatures`, `/show` (the raw diff payload, pager-colored), `/export`
(save the transcript), `/account`, `/info`, `/wd`, `/stop`, `/clear`,
`/logout`. Arrows navigate the menu, tab completes, enter uses, esc
closes; up/down recalls history, ctrl+r searches it, esc stops a running
explain, and cmd+k jumps back to the repo picker.

Repos open as tabs: a quiet tab bar under the header lets you work on
several repos at once, each with its own history. A streaming explain
keeps going while you are on another tab. ctrl+t opens a new tab via
the picker, ctrl+1..9 switches, × closes.

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
