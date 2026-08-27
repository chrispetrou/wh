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
- `preprocess.md`: the deterministic diff-to-payload transformation
  (section splitting, exclusion, sorting, size caps, payload layout).
- `exclude.txt`: machine-readable exclusion rules (lockfiles, vendored
  paths, minified and generated files). Both implementations parse this
  file, so the list can never drift between them. The CLI embeds it at
  compile time; the web app imports it.

## golden fixtures

`../fixtures/explain/*/` holds golden cases: `input.diff`,
`input.commits`, `input.numstat`, optional `params.txt` (cap overrides),
and `expected.txt`. An implementation is correct when it reproduces every
`expected.txt` byte for byte. Add a fixture whenever the spec grows a rule.
