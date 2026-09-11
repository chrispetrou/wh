---
name: wh
description: git worktrees and token-lean git context from the shell, with the wh cli. use when you need an isolated worktree for parallel work (env files copied in), a list of worktrees with dirty counts and ahead/behind, a diff of a range or of uncommitted work with lockfiles, vendored, minified and binary files already stripped, why a line of code exists, or to clean up worktrees whose branches are merged.
---

# wh

`wh` is a small git companion cli. Every command below is non-interactive
when used as written. Check it is installed with `command -v wh`; if it is
not, `cargo install --git https://github.com/chrispetrou/wh wh` (needs a rust
toolchain).

## worktrees

```
wh new feat/auth                 # ../<repo>.feat-auth, branch created from HEAD if missing, .env and .env.* copied
wh new hotfix/1.2 --from v1.2    # branch from another ref
command wh switch feat/auth      # prints the absolute path on stdout, nothing else
wh ls --json                     # one json array: name, branch, head, path, main, locked, stale, dirty, ahead, behind
```

- A worktree lands next to the main worktree, never inside the repo, so it
  stays out of the repo's `git status` and test globs. `/` in a branch
  becomes `-` in the directory name.
- To work in one: `cd "$(command wh switch feat/auth)"`, or take `path` from
  `wh ls --json`. Write `command wh`, not `wh`: your shell may load the
  user's rc file, and a `wh init` wrapper from an older wh turns
  `wh switch` into a `cd` that prints nothing.
- An exact name wins over a substring; an ambiguous query exits 1 and lists
  the matches on stderr.
- In `wh ls --json`, `dirty` is null for a stale worktree and
  `ahead`/`behind` are null without an upstream, so 0 is a real zero.
- A failed env copy is a warning on stderr, not an error: the worktree
  still exists.

## reading changes without calling a model

```
wh explain main... --dry-run          # what this branch changed since it left main
wh explain --describe --dry-run       # the same against the default branch, whatever it is called
wh explain HEAD~3.. --dry-run         # the last three commits
wh explain --uncommitted --dry-run    # staged and unstaged work
wh explain main... --dry-run -- src/  # any of them cut to a pathspec
wh why src/git.rs:42 --dry-run        # the commit that last touched a line (or 13-17), cut to that file
```

`--dry-run` prints the payload and makes no model call, so it costs
nothing but the tokens you read. The payload is `commits:` (short sha and
subject), `files: N (+A -D)`, an `excluded:` list, `---`, then the diff
sections sorted by path. Excluded are lockfiles, vendored directories,
minified bundles, source maps, and binaries. A file past 400 lines ends with
`... truncated (<n> more lines)`, and past 4000 lines in total whole files
become `... omitted <path> (size cap)`. When an excluded, truncated, or
omitted file matters to the task, read it with git directly.

## cleanup

```
wh rm --dry-run      # worktrees whose branches are merged (ancestor, rebase, or squash)
wh rm --yes          # remove those worktrees and their branches
wh rm feat/auth      # one worktree, by branch or directory name
```

- A bare `wh rm` never touches dirty, locked, or detached worktrees, the
  main worktree, or the one you stand in.
- A named `wh rm` refuses a dirty or unmerged worktree with a one-line
  reason.

## rules

- Always pass a query to `wh switch`: without one it opens a picker when a
  terminal is attached.
- Always pass `--dry-run` or `--yes` to a bare `wh rm`.
- Never pass `--force` to `wh rm` unless the user asked for that worktree to
  go, uncommitted work and all.
- Never use `--chat`.
- `wh explain` or `wh why` without `--dry-run` sends the diff to the user's
  own model provider on their key: only when the user asks for a written
  summary, review, changelog, or pull request description.
- Exit codes: 0 success, 1 error (`error: <reason>` on stderr, a hint on the
  next line when there is one), 2 bad usage.
