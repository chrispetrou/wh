## what and why

<!-- what changed, and the reason for it. the problem first, then the
     mechanism. this becomes the commit body, so prose beats bullets. -->

<!-- feature prs are not being merged yet: please open an issue first.
     see CONTRIBUTING.md. -->

## checks

- [ ] `cd cli && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- [ ] `cd web && npm test && npm run build` (node 22)
- [ ] no em dashes anywhere, including this description and the commit messages
- [ ] the README is updated in this change, not a later one

## when it applies

- [ ] **touched `cli/`**: `cargo build --release` and the binary is still
      under 3355443 bytes
- [ ] **touched `shared/prompts/`**: the spec changed first, both
      implementations follow, the golden fixtures still reproduce byte for
      byte, and the regenerated `web/lib/explain/shared.gen.ts` is committed
- [ ] **changed user-facing behaviour**: the pages under `docs/` are updated
      in this pull request, and `node scripts/check-docs.mjs` passes
- [ ] **added logic to `web/`**: it lives in `lib/` with a test, since
      `components/` and `app/` are not covered by vitest
- [ ] **added a cli integration test**: it goes through the `TestRepo`
      harness in `cli/tests/common/mod.rs`
