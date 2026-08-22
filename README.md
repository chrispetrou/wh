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

Coming: `wd explain` (plain-English diff summaries on your own LLM key).

## layout

```
cli/     rust cli: the wd binary
web/     next.js app: repo q&a on the web (in progress)
site/    landing page
shared/  prompt templates + diff conventions shared by cli and web
```

## building

```
cd cli && cargo build --release   # binary at target/release/wd
cd cli && cargo test
```

MIT license.
