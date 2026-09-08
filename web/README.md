# wh · web

The browser surface of wh: sign in with GitHub, pick a repo, and ask about
it in a terminal. Explains ranges, commits and pull requests, draws the log
graph, follows a file's history, answers why a line exists, and lays out
rebase or cherry-pick plans as git commands to paste. Never writes to
GitHub. Keys stay in the browser.

This file is how to run and deploy it. What you can ask, the blocks, the
slash commands, and the keyboard are documented at
**[wh-site.pages.dev/docs/web](https://wh-site.pages.dev/docs/web/run-it)**.

```
nvm use                  # node 22, see .nvmrc
npm install
npm run dev              # http://localhost:3000
npm test                 # vitest: grammar, preprocessing, providers, usage
npm run build
```

The first visit on localhost (dev server only, never behind a proxy) shows
a one-time setup screen that creates the GitHub OAuth app link and writes
`.env.local`. The explain prompts and diff preprocessing are specified once
in `../shared/prompts/` and shared with the cli.

## environment

Deployed instances are configured through the environment (`.env.example`
has the same list):

```
GITHUB_CLIENT_ID       oauth app; callback must be $APP_URL/api/auth/callback
GITHUB_CLIENT_SECRET
SESSION_SECRET         32+ random chars (openssl rand -hex 32)
APP_URL                base url of this instance; https turns on secure cookies
WH_ALLOWED_LOGINS      optional: github logins that may sign in, comma-separated
GITHUB_API_URL         optional, for github enterprise (and GITHUB_GRAPHQL_URL)
WH_ANTHROPIC_URL       optional provider gateways, same names as the cli
WH_OPENAI_URL
WH_GROQ_URL
```

## deploy

The app is stateless: no database, no volume, keys and transcripts stay
in each visitor's browser. Hosting it is one node process (or one
container) and the environment above. The setup screen only appears on a
localhost dev server, on purpose: a hosted instance is configured
through env vars alone.

1. Create a GitHub OAuth app (Settings > Developer settings > OAuth
   Apps) with the callback url set to exactly
   `$APP_URL/api/auth/callback`.
2. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`,
   and `APP_URL`. Keep `SESSION_SECRET` stable across restarts, or
   every session cookie dies with it.
3. Optionally set `WH_ALLOWED_LOGINS` to the github logins allowed to
   sign in (comma-separated, case-insensitive). Unset, anyone with a
   github account can use the instance. Removing a login signs that
   account out on its next request.

Behind a reverse proxy, `APP_URL` must be the public origin: it drives
the oauth redirect uri, the same-origin guards, and the cookie secure
flag (an `https://` `APP_URL` sets secure cookies even though the node
process itself speaks http; a mismatched scheme is the one way to break
sign-in). Nothing trusts `x-forwarded-*` headers.

With docker, build from the repo root (the image needs
`../shared/prompts`):

```
docker build -f web/Dockerfile -t wh-web .
docker run -p 3000:3000 \
  -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... \
  -e SESSION_SECRET=... -e APP_URL=https://wh.example.com \
  wh-web
```

or with compose:

```yaml
services:
  wh:
    image: wh-web
    ports: ["3000:3000"]
    environment:
      GITHUB_CLIENT_ID: "..."
      GITHUB_CLIENT_SECRET: "..."
      SESSION_SECRET: "..."
      APP_URL: "https://wh.example.com"
      WH_ALLOWED_LOGINS: "alice,bob"
    restart: unless-stopped
```

## sessions

Sign-in requests the `repo` scope so private repos appear in the picker
(GitHub has no read-only scope for private repos; wh only ever reads). The
session slides: every request renews it, so it ends after a week of silence
or 30 days after sign-in, whichever comes first. An ended session says so in
the transcript and `sign in again →` brings you back to the same repo with
the transcript intact and reruns what failed.

## limits

`base..head` uses GitHub's three-dot compare (changes on head since it
diverged from base). Ahead/behind counts are computed for the first 15
branches and tag dates for the newest 15. A `since` window covers the
latest 100 commits; `by <login>` fetches that person's commits one by one
up to 20, past which the answer covers the whole span and a note says so.
