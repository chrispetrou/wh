<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="readme/logo-dark.svg">
    <img alt="wh" src="readme/logo-light.svg" width="56" height="56">
  </picture>
</p>

<h1 align="center">wh</h1>

<p align="center">Tiny git companion. Worktrees, minus the ceremony. History, diffs, and pull requests in plain English: in the terminal, or in the browser for any GitHub repo.</p>

<p align="center">
  <a href="https://wh-site.pages.dev/docs"><strong>Documentation</strong></a> ·
  <a href="https://wh-site.pages.dev/docs/install">Install</a> ·
  <a href="https://wh-site.pages.dev/docs/quick-start">Quick start</a> ·
  <a href="https://wh-site.pages.dev/docs/reference/terminal-or-web">Terminal or web</a>
</p>

<p align="center">
  <a href="https://github.com/chrispetrou/wh/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/chrispetrou/wh/ci.yml?branch=main&style=flat-square&label=ci&labelColor=1a1a1a&color=2f9e44"></a>
  <a href="https://github.com/chrispetrou/wh/releases"><img alt="v0.1.0" src="https://img.shields.io/badge/version-v0.1.0-8a8a8a?style=flat-square&labelColor=1a1a1a"></a>
  <img alt="binary 0.6MiB" src="https://img.shields.io/badge/binary-0.6MiB-8a8a8a?style=flat-square&labelColor=1a1a1a">
  <a href="LICENSE"><img alt="gpl-3.0 license" src="https://img.shields.io/badge/license-GPL--3.0-8a8a8a?style=flat-square&labelColor=1a1a1a"></a>
  <img alt="status experimental" src="https://img.shields.io/badge/status-experimental-b08900?style=flat-square&labelColor=1a1a1a">
  <img alt="no telemetry" src="https://img.shields.io/badge/telemetry-none-8a8a8a?style=flat-square&labelColor=1a1a1a">
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="readme/explain-dark.svg">
  <img alt="wh explain HEAD~3..: streams a summary and a watch out section" src="readme/explain-light.svg" width="720">
</picture>

**wh** is a git companion with two surfaces. The cli manages worktrees so
branch-switching never touches your working state, and explains diffs in
plain English so review starts with understanding, not archaeology. The web
app is a terminal for any repo you can see on GitHub, cloned or not: what
changed, the commit graph, pull requests, a file's history, why a line
exists, and rebase or cherry-pick plans written out as commands to paste.
Nothing is ever written to the repo or to GitHub.

Local-first and telemetry-free. Explanations run on your own key (Anthropic,
OpenAI, Groq's free tier) or, in the cli, a local model via Ollama. The cli
needs nothing but git; the web needs a GitHub sign-in and keys that stay in
your browser.

## install

```
cargo install --git https://github.com/chrispetrou/wh wh
echo 'eval "$(wh init zsh)"' >> ~/.zshrc     # so `wh switch` can cd
```

Needs `git`, and `curl` for the explain commands. Tagged releases build
static binaries for macOS and Linux.
[Install guide →](https://wh-site.pages.dev/docs/install)

## quick start

```
wh new feat/auth              # a sibling worktree, branch created if missing
wh ls                         # every worktree, dirty count, ahead/behind
wh switch                     # pick one, cd into it
export GROQ_API_KEY=gsk_...   # free tier at console.groq.com
wh explain --uncommitted      # what you are about to commit, in plain english
wh rm                         # prune worktrees whose branches are merged
```

## commands

| command | what it does |
|---|---|
| `wh new` `ls` `switch` `rm` | worktrees in sibling directories, with `.env` copied over |
| `wh explain` | a review, release notes, or a pr draft for a range, uncommitted work, or a pathspec |
| `wh why <path>:<line>` | what git blame cannot tell you: why the line is there |
| `wh models` | the models your provider offers, asked of the provider |
| `wh init` | the shell wrapper that makes `switch` a real `cd` |

[CLI reference →](https://wh-site.pages.dev/docs/cli/commands) ·
[wh explain →](https://wh-site.pages.dev/docs/cli/explain) ·
[Configuration →](https://wh-site.pages.dev/docs/cli/configuration)

## the web app

A terminal for a GitHub repo: `diff main..dev`, `what changed in pr #42`,
`log`, `history src/git.rs`, `why src/git.rs:42`, `rebase feat/auth`.
Everything that only reads the repo runs with no key; explains ask for one,
and it never leaves your browser. Run it yourself with `cd web && npm run
dev`, or deploy the container.

[Web docs →](https://wh-site.pages.dev/docs/web/run-it) ·
[Running and deploying →](web/README.md)

## contributing

```
cd cli && cargo test              # unit + integration (isolated git config)
cd cli && cargo build --release   # binary at target/release/wh
cd web && npm test && npm run build
```

Bug fixes and docs are welcome now; features get an issue first, while the
design settles. The explain prompts and diff preprocessing are specified
once in [`shared/prompts/`](shared/prompts) and implemented twice, so an
answer reads the same in both surfaces; change the spec first.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: what wh has decided not to
do and why, what CI will check, and the parts that catch people.
[Layout →](https://wh-site.pages.dev/docs/reference/layout)

GPL-3.0 license.
