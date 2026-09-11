# provider failures and usage

What the cli (`cli/src/llm.rs`, `cli/src/usage.rs`) and the web
(`web/lib/explain/providers.ts`, `web/lib/explain/usage.ts`) say when a
model call fails, and what they show about tokens. Spec once here,
implement twice; the wording below is the contract, tests on both sides
quote it.

Copy rules apply: lowercase, no em dashes, no exclamation marks, never
the provider's raw json, never an org or request id.

## failures

Classify by HTTP status first, then by the body. The body's message is
`error.message` (openai, groq, anthropic) or `error` when it is a string
(ollama), else the body itself collapsed to one line and cut to 300
characters. The code is openai's `error.code`, anthropic's `error.type`
and `error.details.error_code`.

Detection order:

1. **key**: status 401 or 403.
2. **credit**: status 402, or code `billing_error`, `insufficient_quota`,
   `credit_balance_exhausted`, or the message contains "credit balance".
3. **spend limit**: code `enforced_spend_limit_reached`,
   `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`,
   `organization_usage_limit_exceeded`, or the message contains
   "specified api usage limits" or "spend limit" (anthropic returns this
   as a 400, and as a 429 with no `retry-after`).
4. **rate limit, momentary or daily**: status 429 and the message
   contains "used " or "try again in" (groq's shape: "Rate limit reached
   ... on tokens per minute (TPM): Limit 6000, Used 5000, Requested 1500.
   Please try again in 5.2s"). Daily when the message contains "per day",
   "tpd", or "rpd".
5. **too large**: the message matches, case-insensitively,
   `request_too_large|too large|too long|context length|maximum context|too many tokens|context_length_exceeded`.
   Never "tokens per minute" on its own: that is a 429 (step 4). Counts
   come from "Limit N, Requested M" (groq), "context length is N tokens
   ... requested M tokens" (openai), "M tokens > N maximum" (anthropic).
6. **rate limit, other**: any other 429.
7. **unknown model**: status 404, or the message matches
   `model.*not (found|exist)|does not exist|unknown model`.
8. **overloaded**: status 500 or above, or code `overloaded_error`, or
   the message contains "overloaded".
9. **generic**: anything else.

| class | error line | hint |
|---|---|---|
| key | `provider rejected the key` | web `/key <value> replaces it`; cli `set GROQ_API_KEY to a valid key` (the provider's variable) |
| credit | `your groq key is out of credit` | web `top up at <billing url>, or /model another provider's`; cli `top up at <billing url>, or use another key` |
| spend limit | `your groq key hit its spend limit` | `raise it at <limits url>` |
| rate limit, daily | `provider daily limit reached, resets in 3h 12m` (`resets tomorrow` when no wait is known) | none |
| rate limit | `provider rate limit, try again in 12s` when a wait is known, else `provider rate limit, try again in a moment` | none |
| too large | `the diff is too big for <model>: 17842 tokens, limit 8000` (the counts when known) | web `try fewer commits, cut it to a path (add: in src/), or /model one with a larger context`; cli `try fewer commits, a narrower range, or WH_MODEL with a larger context` |
| unknown model | `provider has no model <model>` | web `/model lists the ones it knows`; cli `wh models lists the ones the provider offers` |
| overloaded | `provider is overloaded, try again in a moment` | none |
| generic | `provider error: <message>` | none |
| network, nothing received | `could not reach <host>` | cli: curl's last stderr line, its `curl: (6) ` prefix stripped |
| dropped mid-answer | `lost the connection to <host>` | none |
| empty body | `provider returned no text` | none |

The cli bounds every call, so a stalled provider never hangs a script or
an agent's shell: curl gives up when it cannot connect within 15s, or when
less than one byte a second arrives for 300s. Never a total time limit: a
long answer streams to the end, and a silent reasoning pass or a cold
ollama model load gets five minutes. A stall before any text is `could
not reach <host>` with curl's `operation too slow` line as the hint; a
stall after text is `lost the connection to <host>`. The web has no such
bound yet.

The web wraps these as `{"error", "hint"}` json with status 401 (key),
402 (credit, spend limit), 429 (rate limits), 413 (too large), 404
(unknown model), 503 (overloaded), 502 (generic, network). An error frame
that arrives after text (anthropic `{"type":"error",...}`, an openai-shaped
`{"error":...}` with no `choices`) is classified by its body alone and
delivered in-stream (web: a `[wh:error] ` line, then `[wh:hint] `; cli:
the text is flushed, then the error, exit 1).

Urls, the one thing here that may drift:

| provider | host | billing | limits |
|---|---|---|---|
| anthropic | api.anthropic.com | platform.claude.com/settings/billing | platform.claude.com/settings/limits |
| openai | api.openai.com | platform.openai.com/settings/organization/billing | platform.openai.com/settings/organization/limits |
| groq | api.groq.com | console.groq.com/settings/billing | console.groq.com/settings/limits |

### models

Both surfaces can ask the provider which models it offers, so neither has
to ship a list that rots: the web's `/model sync [provider]`, the cli's `wh models`.
The endpoint hangs off the same configurable base url as the chat call,
so a gateway is followed automatically.

| provider | path | auth | ids at |
|---|---|---|---|
| anthropic | `/v1/models` | `x-api-key`, `anthropic-version` | `data[].id` |
| openai | `/v1/models` | `Authorization: Bearer` | `data[].id` |
| groq | `/v1/models` (its base already ends `/openai`) | `Authorization: Bearer` | `data[].id` |
| ollama | `/api/tags` | none | `models[].name` |

A catalog is not a model list: these endpoints also return embedding,
speech, and image models. Both implementations drop ids matching
`embed`, `whisper`, `tts`, `dall-e`, `moderation`, `guard`, `rerank`, or
`stable-diffusion`, drop any id the request body would reject anyway
(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$`), and keep the provider's own
order. The 200-id cap is a safety bound on a pathological response,
never a curation device: a truncated list would make "is the pinned
default still offered" answer against a slice rather than the catalog,
and report a live model as retired.
The rule is a heuristic, not a contract, and the two sides must apply the
same one.

A 404 here means the base url has no models endpoint (a gateway that
only proxies chat), never an unknown model: `provider has no models
endpoint`, with the base url on the second line. Every other failure
class is classified exactly as above.

The shipped suggestions stay as a seed, for the moment before a key is
pasted and for a gateway with no endpoint. The default model per provider
is pinned and never follows "latest": a default that moves changes cost
and behaviour for everyone. When a sync finds the pinned default missing
from the catalog, both surfaces say so and change nothing.

### waits

The wait in "try again in 12s" and "resets in 3h 12m" is the first of:

1. `retry-after` in integer seconds (an http-date: the web computes the
   delta, the cli treats it as unknown).
2. the reset header: openai and groq `x-ratelimit-reset-tokens` then
   `x-ratelimit-reset-requests` (durations like `6m0s`, `2m59.56s`,
   `7.66s`, `1h23m`), anthropic `anthropic-ratelimit-tokens-reset` then
   `-requests-reset` (RFC 3339: the web computes the delta, the cli
   treats it as unknown).
3. the message phrase `try again in <duration>`.

Duration grammar: `(\d+h)?(\d+m)?(\d+(\.\d+)?s)?`, at least one part,
fractions rounded up to whole seconds. Anything else is unknown.

`fmtWait(seconds)`: under 60 -> `12s`; under 3600 -> `3m` (minutes
rounded up); else `1h 20m`, or `2h` when the minutes are 0.

## usage

Ask for it and read it:

| provider | request | input tokens | output tokens |
|---|---|---|---|
| openai | `"stream_options":{"include_usage":true}` | last chunk `usage.prompt_tokens` | `usage.completion_tokens` |
| groq | same | same (groq also sends `x_groq.usage` with the same names) | same |
| anthropic | nothing | `message_start`: `message.usage.input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` | last `message_delta`: `usage.output_tokens` (cumulative, last wins; never `message_start`'s) |
| ollama | nothing | `done:true` frame: `prompt_eval_count` | `eval_count` |

Some openai-compatible gateways reject `stream_options` with a 400; that
lands in the generic class with their message, which is fine.

Headroom comes from response headers, only read when both the remaining
and the limit are present:

| provider | tokens | requests | reset |
|---|---|---|---|
| openai, groq | `x-ratelimit-remaining-tokens` / `x-ratelimit-limit-tokens` (groq: per minute) | `x-ratelimit-remaining-requests` / `-limit-requests` (groq: per day) | `x-ratelimit-reset-tokens`, `-requests` |
| anthropic | `anthropic-ratelimit-tokens-remaining` / `-tokens-limit` | `anthropic-ratelimit-requests-remaining` / `-requests-limit` | `anthropic-ratelimit-tokens-reset` |

No provider exposes an account balance to a normal api key (openai and
anthropic have admin-key usage apis, groq has none), so totals are
counted locally from these per-answer numbers. Tokens only, never money:
prices drift.

### lines

- closing line, after every model answer, muted:
  `· 8.4s · claude-opus-5 · 1.2k in · 340 out`; the `in`/`out` parts are
  left out when the provider sent no usage.
- headroom warning, amber, only when `remaining < limit / 10` for tokens
  or requests: `low on groq tokens: 8.2k of 100k left, resets in 42s`
  (`low on groq requests: ...`; the `, resets in` part only when known).
- web footer: `groq · openai/gpt-oss-120b · effort high · 12.4k tokens`
  (in + out since the key was saved; left out at 0).
- web `/usage`: one row per provider, `anthropic  1.2m in · 84.3k out ·
  41 answers · since aug 12`, `(active)` after the active one, `no key`
  for the rest; then `headroom   1.9m tokens · 14.2k requests left (as of
  the last answer)` when known.
- the cli keeps no state, so it shows the closing line and the warning
  only.

`fmtTokens(n)`, integer arithmetic so both sides agree on ties:

- `n < 1000`: the number, `842`
- `n < 999_950`: `tenths = (n * 10 + 500) / 1000` (integer division);
  print `tenths / 10`, then `.` and `tenths % 10` unless that is 0, then
  `k`: `1000 -> 1k`, `1250 -> 1.3k`, `12400 -> 12.4k`, `999_949 -> 999.9k`
- else the same over millions with `m`: `999_950 -> 1m`, `1_234_567 -> 1.2m`
