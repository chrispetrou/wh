# shared/prompts

Explain prompt templates and diff-preprocessing conventions, shared by the
CLI (`cli/`, Rust) and the web app (`web/`, TypeScript).

The rule: **spec once here, implement twice.** Both implementations must
produce the same sections in the same order — a `summary` followed by a
`watch out` section — as shown in the landing demo (`site/index.html`).

Planned contents (explain milestone):

- `explain.md` — the system/user prompt template with placeholders for the
  diff, commit messages, and file stats.
- `preprocess.md` — diff-preprocessing conventions: file ordering, lockfile
  and vendored-path exclusion, per-file and total size caps, truncation
  markers.

Nothing here is consumed at build time yet.
