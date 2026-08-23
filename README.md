# wd

Tiny git companion. Worktrees, minus the ceremony. Diffs, in plain English.

```
$ curl -fsSL https://wd.sh/setup.sh | bash
```

**wd** is a single-binary git companion with two jobs: managing worktrees so
branch-switching never touches your working state, and explaining diffs in
plain English so review starts with understanding, not archaeology.

It is local-first and telemetry-free. Explanations run on your own key:
Anthropic, OpenAI, or a local model via Ollama. Everything else needs nothing
but git.

Written in Rust. One binary, no runtime.

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

```
$ wd switch
? select worktree au▏
› feat/auth    clean
→ switched ../repo.feat-auth
```

`wd switch` opens a picker over your worktrees: type to filter, arrows (or
ctrl-p/ctrl-n) to move, enter to select, esc to cancel. It prints the chosen
path, so with the shell wrapper below it becomes a real `cd`.
`wd switch <query>` skips the picker when the match is unique.

```
$ wd init zsh
```

`wd init zsh|bash|fish` prints a small `wd()` wrapper that makes
`wd switch` change directory in your shell. Add one line to your rc file:

```
eval "$(wd init zsh)"     # .zshrc or .bashrc
wd init fish | source     # config.fish
```

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

Explanations run on your own key. Configuration is environment only:

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

## layout

```
cli/     rust cli: the wd binary
web/     next.js app: repo q&a on the web (in progress)
site/    landing page
shared/  explain spec: prompt template, diff preprocessing rules,
         and golden fixtures both implementations must reproduce
```

## web

The web app (`web/`) answers questions about any GitHub repo: sign in,
pick a repo, then in a terminal-flavored chat:

```
explain the last 5 commits
what changed in pr #42
diff main..release
```

Answers use the same explain spec as the CLI (`shared/prompts/`), on your
own LLM key: pasted once, stored only in your browser, sent per request,
never stored or logged server-side. Notes:

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

## building

```
cd cli && cargo build --release   # binary at target/release/wd
cd cli && cargo test
```

MIT license.
