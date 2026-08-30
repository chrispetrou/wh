# shared/prompts

The explain spec, shared by the CLI (`cli/`, Rust) and the web app (`web/`,
TypeScript). The rule: **spec once here, implement twice.** Both
implementations must produce the same payloads and the same output shape.

## files

- `explain.md`: the prompt template, split on `[section]` marker lines
  (`[system]`, `[user]`, `[followup]`; parsers must skip unknown sections).
  `{{payload}}` in the user part is replaced with the preprocessed payload.
  The explain output contract is a `summary` section followed by a
  `watch out` section, as shown in the landing demo (`site/index.html`).
  `[followup]` is the system prompt for continuing the conversation about
  the same diff (web today; a cli explain repl may use it later).
  `[changelog]` replaces `[system]` in changelog mode (`wd explain
  --changelog`, `changelog <range>` on the web): the output contract is up
  to four sections, `added`, `changed`, `fixed`, `removed`, empty ones
  left out, or the single line `nothing user-visible`.
  `[describe]` replaces `[system]` in describe mode (`wd explain
  --describe`, `describe pr #N` or `describe <branch>` on the web): the
  contract is `title`, `description`, and `testing` when the diff shows
  how to verify. Both implementations append a context block to the user
  turn after the payload, never inside it (the preprocess spec and the
  fixtures are untouched): a blank line, `context:`, then `branch <head>
  into <base>` (either side left out when unknown) and, for an existing
  pull request, `pr #N: <title>` and `current description:` followed by
  the body, trimmed and cut at 2000 characters.
  `[why]` is the system prompt behind `why <path>:<line>` on the web: the
  payload is the blaming commit cut down to that file, followed by the
  line itself; the contract is `why` then `watch out`. (cli parity is
  deferred: `git blame` is local, so a cli `why` would be a small
  follow-up.)
  `[message]` is the system prompt behind the `draft message` action of
  a rebase plan on the web (`rebase <branch>`): the payload is the commit
  whose message is drafted and, for a squash, the commits folding into
  it, concatenated; the contract is `subject` then `body`, the body left
  out when the subject says it all. (cli parity deferred.)
- `preprocess.md`: the deterministic diff-to-payload transformation
  (section splitting, exclusion, sorting, size caps, payload layout).
- `exclude.txt`: machine-readable exclusion rules (lockfiles, vendored
  paths, minified and generated files). Both implementations parse this
  file, so the list can never drift between them. The CLI embeds it at
  compile time; the web app imports it.
- `provider.md`: what a failed model call says (one wording per failure
  class, keyed by HTTP status then body, with the way out), how token
  usage and rate-limit headroom are read from each provider, and the
  closing, footer, and warning lines that show them. Prose, not embedded:
  the tests on both sides quote it.

## golden fixtures

`../fixtures/explain/*/` holds golden cases: `input.diff`,
`input.commits`, `input.numstat`, optional `params.txt` (cap overrides),
and `expected.txt`. An implementation is correct when it reproduces every
`expected.txt` byte for byte. Add a fixture whenever the spec grows a rule.
