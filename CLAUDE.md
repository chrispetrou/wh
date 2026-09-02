# wh · tiny git companion

Single-binary git companion: worktree management without ceremony, plus
plain-English diff explanations. Local-first, telemetry-free, BYO LLM key.

## repo map

- `cli/`: Rust CLI, the `wh` binary. Worktree commands (`new`, `ls`, `rm`,
  later `switch`) and `wh explain` (LLM diff summaries; later milestone).
- `web/`: Next.js + shadcn/ui app: GitHub OAuth, repo picker, a
  terminal-flavored chat that answers questions about a repo by fetching
  diffs/commits via the GitHub API and running them through the same explain
  logic as the CLI, plus the git features only a hosted repo can answer
  (log graph, prs, history, blame, rebase and cherry-pick plans; paste-only,
  never writes to GitHub). Keep it minimal: no dashboards, no analytics, no
  settings sprawl.
- `site/`: the landing page. **Complete. Do not modify** except to
  eventually add real links.
- `shared/prompts/`: explain prompt templates and diff-preprocessing
  conventions. Spec'd once here; implemented twice (Rust in cli/, TS in web/).
  Change the spec first, then both implementations.

No root workspace or build orchestration: each directory builds
independently.

## design source of truth

`site/index.html` **is** the design system. Every surface must look like it
belongs to that page. Never change its logo glyph (the CSS `clip-path`
square), monospace typography, spacing, or light/dark palette. Reuse its
values verbatim:

- Font: `ui-monospace,"SF Mono","Cascadia Mono","JetBrains Mono",Menlo,Consolas,monospace`,
  13px base, line-height 1.7. Monospace everywhere: headings, body, buttons.
- Palette (light / dark): bg `#ffffff`/`#0d0d0d`, fg `#1a1a1a`/`#e8e8e8`,
  muted `#8a8a8a`/`#7a7a7a`, faint `#c8c8c8`/`#3a3a3a`, line
  `#e6e6e6`/`#222222`, term-bg `#fcfcfc`/`#111111`, sel `#eef2ff`/`#1c2333`,
  green `#2f9e44`/`#69db7c`, amber `#b08900`/`#e0b420`.
- Aesthetic reference: minimal, terminal-first, quiet.
  Technical metrics as copy (version, binary size, "experimental"); a live
  terminal demo instead of marketing imagery.

Brand rules, all surfaces:

- lowercase, quiet copy; no emoji, no spinners, no exclamation marks
- no em dashes anywhere (code, docs, ui copy, commit messages); use commas,
  colons, parentheses, or the `·` separator instead. `site/index.html` is the
  one exemption (locked mock)
- hairline 1px borders (`--line`), flat surfaces, small border radii,
  **no shadows, no gradients**
- green `→` for success lines only; muted gray for info; amber for
  warnings/section labels

## cli/ rules

- Single static binary, small (**3.2MiB budget**: the size is part of the
  brand), no telemetry. Keep dependencies near zero: clap with trimmed
  features and serde_json (no `preserve_order`) are the whole runtime tree.
- **Shell out to system `git`: never add git2/gix.** All git invocations go
  through `src/git.rs` (explicit `-C <path>`, `GIT_OPTIONAL_LOCKS=0` on
  reads). Parse only `--porcelain` scripting formats.
- Output strings must match the landing demo verbatim:
  `created worktree ../repo.feat-auth`, `copied .env .env.local`,
  `→ ready feat/auth checked out`, `clean` / `2 dirty` / `ahead 3` /
  `behind 12`.
- Worktree naming: sibling dir `<main-worktree-dirname>.<branch>` with `/`
  (and other unsafe chars) replaced by `-`. Anchor to the main worktree
  (`git rev-parse --git-common-dir`), never cwd.
- ANSI color only when stdout is a tty and `NO_COLOR` is unset.
- `--help` text is lowercase and minimal; keep the flag surface small: add
  flags on demand, not speculatively.

## web/ rules

- shadcn/ui restyled via CSS variables in `globals.css` to the exact landing
  palette above (light + dark via `prefers-color-scheme`). Monospace-only
  font stack, 13px base, radius small, shadows neutralized.
- The explain logic must mirror the CLI's: same prompt templates and diff
  preprocessing per `shared/prompts/`.

## commands

```
cd cli && cargo test              # unit + integration tests
cd cli && cargo build --release   # check the binary stays well under 3.2MiB
cd web && npm run dev             # dev server
cd web && npm run build
```

web/ needs Node 22 (see `web/.nvmrc`; the shadcn CLI requires it: run it as
`npx shadcn@latest`).

## testing rules (cli)

- Integration tests always go through the `TestRepo` harness in
  `cli/tests/common/mod.rs`: it isolates git config
  (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, tmp `HOME`,
  `NO_COLOR=1`) so the developer's global git setup can't leak in. Never
  invoke the binary in tests without it.
- Test repos live at `<tmpdir>/repo` so sibling worktrees land inside the
  sandbox.
