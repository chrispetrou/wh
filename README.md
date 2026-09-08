<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="readme/logo-dark.svg">
    <img alt="wh" src="readme/logo-light.svg" width="56" height="56">
  </picture>
</p>

<h1 align="center">wh</h1>

<p align="center">Tiny git companion. Worktrees, minus the ceremony. History, diffs, and pull requests in plain English: in the terminal, or in the browser for any GitHub repo.</p>

<p align="center">
  <a href="https://github.com/chrispetrou/wh/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/chrispetrou/wh/ci.yml?branch=main&style=flat-square&label=ci&labelColor=1a1a1a&color=2f9e44"></a>
  <a href="https://github.com/chrispetrou/wh/releases"><img alt="v0.1.0" src="https://img.shields.io/badge/version-v0.1.0-8a8a8a?style=flat-square&labelColor=1a1a1a"></a>
  <img alt="binary 0.6MiB" src="https://img.shields.io/badge/binary-0.6MiB-8a8a8a?style=flat-square&labelColor=1a1a1a">
  <img alt="rust" src="https://img.shields.io/badge/rust-stable-8a8a8a?style=flat-square&labelColor=1a1a1a">
  <a href="LICENSE"><img alt="gpl-3.0 license" src="https://img.shields.io/badge/license-GPL--3.0-8a8a8a?style=flat-square&labelColor=1a1a1a"></a>
  <img alt="status experimental" src="https://img.shields.io/badge/status-experimental-b08900?style=flat-square&labelColor=1a1a1a">
  <img alt="no telemetry" src="https://img.shields.io/badge/telemetry-none-8a8a8a?style=flat-square&labelColor=1a1a1a">
</p>

<p align="center"><a href="https://wh-site.pages.dev/docs">documentation</a> · <a href="https://wh-site.pages.dev">site</a></p>

**wh** has two surfaces. The cli manages worktrees so branch-switching never
touches your working state, and explains diffs in plain English. The web app
is a terminal for any repo you can see on GitHub, cloned or not: what changed,
the commit graph, pull requests, a file's history, why a line exists, and
rebase or cherry-pick plans written out as commands to paste. Nothing is ever
written to the repo or to GitHub.

Local-first and telemetry-free. Explanations run on your own key (Anthropic,
OpenAI, Groq's free tier) or, in the cli, a local model via Ollama. The cli is
one Rust binary (0.6MiB, budget 3.2MiB) with three small dependencies (clap,
serde, serde_json) and no runtime; the web app is a Next.js app you run
yourself. One explain spec (`shared/prompts/`) sits behind both, so an answer
reads the same wherever you ask.

## install

```
cargo install --path cli                                   # from a clone
cargo install --git https://github.com/chrispetrou/wh wh   # or straight from git
```

Add the shell wrapper so `wh switch` can actually change directory:

```
echo 'eval "$(wh init zsh)"' >> ~/.zshrc     # bash: ~/.bashrc
wh init fish | source                        # fish: add to config.fish
```

Needs `git`, and `curl` for `wh explain`. Tagged releases build binaries for
macOS (arm64, x64) and Linux (x64, arm64, both musl) with sha256 checksums.

## quick start

```
wh new feat/auth              # a sibling worktree, branch created if missing
wh ls                         # every worktree, dirty count, ahead/behind
wh switch                     # pick one, cd into it
export GROQ_API_KEY=gsk_...   # free tier at console.groq.com
wh explain HEAD~3..           # the last three commits, in plain english
wh rm                         # prune worktrees whose branches are merged
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="readme/explain-dark.svg">
  <img alt="wh explain HEAD~3..: streams a summary and a watch out section" src="readme/explain-light.svg" width="720">
</picture>

`wh explain` reads a diff, drops what a reviewer would skip (lockfiles,
vendored and minified files), and streams a `summary` and a `watch out`. The
diff can be a range, the work you have not committed yet (`--uncommitted`),
or any of them cut to a pathspec after `--`. `--changelog` turns it into
release notes, `--describe` into a pull request to paste, and `--chat` keeps
the conversation open for follow-up questions about the same diff.

`wh why src/git.rs:42` answers what `git blame` cannot: why the line is
there. `wh models` lists what your provider offers, asked of the provider
itself, so no list shipped in the binary has to be kept current. Keys and
providers come from the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GROQ_API_KEY`, or none for Ollama.

Every command, flag, range form, environment variable, and error message is
in the [cli docs](https://wh-site.pages.dev/docs/cli/commands).

## web

```
cd web && npm install && npm run dev      # node 22, http://localhost:3000
```

Sign in with GitHub, pick a repo, and ask in plain words: `what changed in pr
#42`, `log`, `history src/git.rs`, `why src/git.rs:42`, `rebase feat/auth`,
`pick 3 5 onto release/1.x`. Keys are pasted once and stay in your browser.
`/theme` has the everyday `auto`, `light`, and `dark`, plus two opt-in
phosphor looks, `vintage` (green) and `amber`. `/model sync` asks your
provider for its current model list, so a new model needs no redeploy.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="readme/web-log-dark.svg">
  <img alt="log draws the commit graph in the transcript, then explain 3 explains that row" src="readme/web-log-light.svg" width="720">
</picture>

The grammar, the blocks you can walk, the plans, keys and models, slash
commands, and hosting your own instance are in the
[web docs](https://wh-site.pages.dev/docs/web/run-it). The deploy reference
(environment, docker, sessions) is also in [web/README.md](web/README.md).

## layout

```
cli/     rust cli: the wh binary
web/     next.js app: the web terminal
shared/  explain spec: prompt template, preprocessing rules, provider wording,
         and golden fixtures both implementations must reproduce
site/    the original landing mock (the live site is chrispetrou/wh-site)
readme/  the logo and the animated svgs embedded above
scripts/ readme-anim.mjs, which writes those svgs
```

`shared/` is spec once, implement twice: change the spec first, then both
implementations, and the golden fixtures under `shared/fixtures/` must be
reproduced byte for byte by the Rust and the TypeScript preprocessors.

## building

```
cd cli && cargo build --release   # binary at target/release/wh
cd cli && cargo test              # unit + integration (isolated git config)
cd web && npm test                # vitest: grammar, preprocessing, providers, usage
cd web && npm run build
node scripts/readme-anim.mjs      # regenerate the readme animations
```

CI runs fmt, clippy, tests, a 3.2MiB size gate on the binary, the web tests
and build, and a brand check (no em dashes outside the landing mock). Tagged
releases (`v*`) build the four binaries and open a draft GitHub release with
checksums.

Bug fixes and docs are welcome now; features get an issue first, while the
design settles. [CONTRIBUTING.md](CONTRIBUTING.md) has what wh has decided
not to do and why, what CI will check, and the parts that catch people.

GPL-3.0 license.
