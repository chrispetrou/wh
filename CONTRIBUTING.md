# contributing to wh

Thanks for looking. This file covers the app: the cli in `cli/` and the web
app in `web/`. The landing page and docs live in a separate repository.

## where things stand

**Bug fixes, documentation, and clear bug reports are welcome now.**

**Feature pull requests are not being merged yet**, while the design
settles. Please open an issue first and we can talk about it.

That is not politeness for its own sake. wh is an opinionated tool with a
long list of things it has deliberately decided not to do, and most of
that reasoning has lived in a local file rather than in the repository. It
would be unfair to let you build something for a week and then turn it
down for a rule you had no way to read. The next section is that list,
written down.

## what wh will not do

These are settled decisions, not oversights. If your change needs one of
them reversed, open an issue and make the case rather than sending a PR.

**The cli**

- **Shells out to system `git`. Never git2, gix, or any git library.** The
  reasons were size and worktree parity. Every invocation goes through
  `cli/src/git.rs` with an explicit `-C <path>`, `GIT_OPTIONAL_LOCKS=0` on
  reads, and only `--porcelain` output parsed. Human-readable git output is
  not a format.
- **Speaks HTTP through the system `curl`.** No HTTP crate, no TLS
  dependency. The api key rides in curl's config on stdin so it never
  reaches `argv` or `ps`, and the request body sits in a `0600` temp file
  for the length of the call.
- **Uses `stty` for raw terminal mode**, not a termios crate.
- **Has three runtime dependencies**: clap, serde, serde_json, all with
  `default-features = false`. serde_json was added deliberately, with the
  size arithmetic written down at the time. A new crate needs a reason
  that survives the budget below. A pty crate, in particular, is the shape
  of dependency this project turns down, which is why the interactive
  picker and `--chat` are tested at a pure function seam instead.
- **Keeps no state.** Environment variables only: no config file, no cache,
  no dotfile. It is why `wh models` asks the provider every time.
- **Stays under 3.2MiB.** The size is part of what the tool is, and CI
  fails the build over it.

**The web app**

- **Never writes to GitHub.** Rebase and cherry-pick plans are written out
  as commands for you to paste; your own shell runs them. Executing them
  through the api was designed and then rejected: it would force-push with
  no reflog, it cannot resolve a conflict in a browser, and it would pin
  the write scope permanently.
- **Never stores a provider key server-side.** Keys live in the browser and
  travel per request in a header. There is no hosted ollama option, because
  pointing a server at a user-supplied local url is an SSRF.
- **Has no dashboards, no analytics, no settings sprawl.** One quiet block
  per question. Charts were considered and became a single stat block.
- **Routes commands deterministically.** The grammar is parsed, not guessed:
  the model summarizes a diff, it never decides what you meant.
- **Adds no dependency per feature.** The cli's near-zero rule does not
  apply literally here, but a new runtime dependency is a decision, not a
  detail.

**Both**

- **No telemetry, ever.**
- **Usage is counted in tokens, never in dollars.** Prices drift, and no
  provider exposes a balance to an ordinary api key.
- **Model defaults stay pinned and never follow "latest".** A default that
  moves changes what every user pays and how answers read. There is no
  maintainer-hosted model list either: `wh models` and `/model sync` ask the
  provider, so nobody has to maintain a catalog.
- **Failures speak in our words**, one line, with the way out underneath.
  Never the provider's raw json, never an org or request id.

### two exceptions that are not bugs

The palette has five roles, but the commit graph uses six lane colors and
the phosphor themes (`/theme vintage`, `/theme amber`) carry a text glow and
a vignette. Both are sanctioned exceptions. Please do not "fix" them in a
tidying pass.

## setup

Each directory builds on its own. There is no root workspace and no build
orchestration.

```
cd cli && cargo build            # rust stable, no pinned toolchain
cd web && nvm use && npm install # node 22, see web/.nvmrc
```

The web app needs node 22. The default on many machines is older and vitest
will not run on it. If you build the docker image, build it from the
repository root, because the image needs `../shared/prompts`.

## the checks your pr must pass

CI runs three jobs, and all of them are easy to trip.

| job | what it runs |
|---|---|
| `cli` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo build --release`, then a size gate: the release binary must be under 3355443 bytes |
| `web` | `npm ci`, `npm test`, `npm run build` on node 22 |
| `brand` | greps the tree for em dashes and fails on a single one |

Run them before you push:

```
cd cli && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd cli && cargo build --release && ls -l target/release/wh
cd web && npm test && npm run build
```

Two things worth knowing:

- **clippy runs with `-D warnings`**, so a warning fails the build.
- **The em dash rule is broader than the check.** The rule is no em dashes
  anywhere: code, docs, ui copy, and commit messages. CI only greps `.md`,
  `.rs`, `.ts`, `.tsx`, `.css`, `.toml`, and `.mjs`, so a `.json` or `.yml`
  file can pass CI and still break the rule. Use commas, colons,
  parentheses, or the `·` separator.

If you drafted your change with an AI assistant, that is fine, this project
does too. You own the result: read it, run the tests, and take out the em
dashes it will have left behind. That is the single most common red build.

## the parts that catch people

**`shared/prompts/` is spec once, implement twice.** The explain prompts and
the diff preprocessing are specified once and implemented in both Rust and
TypeScript. Change the spec first, then `cli/src/preprocess.rs` and
`web/lib/explain/preprocess.ts`. The golden cases under
`shared/fixtures/explain/` must be reproduced byte for byte by both sides,
and each test runner asserts that at least four fixtures exist, so removing
one fails. When a spec change grows a rule, add a fixture: it will fail the
other language's suite until that side is implemented too, which is the
point of the arrangement.

**`web/lib/explain/shared.gen.ts` is generated but committed.**
`scripts/sync-shared.mjs` regenerates it on `predev`, `prebuild`, and
`pretest`, so running the tests locally keeps it fresh. CI does not diff it,
so a stale copy will not fail anything. After editing `shared/prompts/`, run
`npm test` and commit the regenerated file.

**Vitest only covers `web/lib/**/*.test.ts`.** `components/` and `app/` are
not tested, on purpose, and even a `.test.tsx` inside `lib/` would silently
never run. So logic belongs in a plain `.ts` module under `lib/`, and the
component calls it. Where a module needs browser storage, take it as a
parameter the way `createKeyStore`, `createPrefs`, and `createCatalog` do,
and export a singleton for the app to import. Tests then pass an in-memory
object. Wrap every storage access in try/catch: private windows throw.

**The release profile sets `panic = "abort"`**, so there is no
`catch_unwind` and a panicking test surfaces differently than you may
expect.

**Node 22 is pinned in two places**, `web/.nvmrc` and the CI workflow.
Bumping one without the other splits the toolchain.

## testing

**cli.** Integration tests always go through the `TestRepo` harness in
`cli/tests/common/mod.rs`. It builds a throwaway repository in a temp
directory and isolates it: `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME` inside the
sandbox, and `NO_COLOR=1`. Never invoke the binary in a test without it, or
your own git config decides whether the test passes. Test repositories live
at `<tmpdir>/repo` so that sibling worktrees land inside the sandbox.

Anything that talks to a model uses the fake provider in the same file:

```rust
let (url, server) = fake_server(ok("text/event-stream"), GROQ_ANSWER);
t.wh()
    .args(["why", "a.txt:2"])
    .env("WH_PROVIDER", "groq")
    .env("GROQ_API_KEY", "gsk_test")
    .env("WH_GROQ_URL", &url)
    .assert()
    .success();
let request = server.join().unwrap();
assert!(request.contains("the line in question, a.txt:2:"));
```

It is one-shot, binds an ephemeral port, and returns the raw request text
when you join it, which is how a test asserts what actually went out on the
wire. `cli/tests/why.rs` and `cli/tests/models.rs` are the shortest ones to
copy from.

**web.** Vitest, node environment, no DOM. Put the logic in `lib/` and test
it there.

## commits and pull requests

Subjects name the surface, then say what changed in lowercase:

```
Cli: wh why <path>:<line>
Web: lookups run without a key: gate only explains, follow-ups, and drafts
Web+Cli: ask the provider for its models
README: hand the reference to the docs site
```

No conventional-commit types, no trailing period. The body is prose wrapped
near 72 columns that explains **why**, not a list of what: the problem
first, then the mechanism, then the tradeoff. Bullets are fine as a
secondary list after the prose. If you consciously left something out, say
so in a `Deferred:` paragraph.

Branches are `<type>/<slug>` in kebab case: `fix/blame-blank-line`.

Two standing rules:

- **The README is updated in the same change as the feature**, not after.
- **User-facing behaviour also needs the docs**, which live in the
  `wh-site` repository.

## design and copy

Every surface should look like it belongs to the same tool: monospace
throughout, 13px base, hairline 1px borders, flat surfaces, small radii. No
shadows, no gradients. Copy is lowercase and quiet, with no emoji, no
spinners, and no exclamation marks. Green `→` marks a success line and
nothing else, muted gray is information, amber is a warning or a section
label.

The palette and the type stack are written out in `CLAUDE.md`; the live
values are the CSS variables in `web/app/globals.css`.

Cli output strings are part of the interface and several are asserted in
tests, so changing one is a deliberate act, not a wording tweak.

## a note on the roadmap

The project's roadmap and its decisions log are kept in a local file that is
not in this repository, so you will not find the original reasoning behind
the rules above. That is why they are restated here. If something in this
guide seems to contradict the code, the code is right and the guide has
drifted: please say so in an issue.

## license

GPL-3.0-only. Contributions are accepted under the same license. There is no
CLA and no sign-off requirement.
