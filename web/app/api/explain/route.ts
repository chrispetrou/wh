import { NextRequest, NextResponse } from "next/server";
import { LOG_DEFAULT, parseCommand } from "@/lib/commands";
import { sameOrigin } from "@/lib/origin";
import {
  branchesText,
  commitInput,
  compareRange,
  GithubError,
  historyBlock,
  lastNCommits,
  logBlock,
  mergeInputs,
  planBlock,
  prInput,
  prsBlock,
  sinceInput,
  tagsText,
  whyInput,
  type ExplainInput,
  type PlanSource,
} from "@/lib/github";
import { describeTurn } from "@/lib/explain/context";
import { filterDiff } from "@/lib/explain/filter";
import { defaultCaps, defaultRules, preprocess, stats } from "@/lib/explain/preprocess";
import { prompt, type PromptMode } from "@/lib/explain/prompt";
import type { DiffMeta, ExplainMeta } from "@/lib/explain/meta";
import {
  buildFollowupRequest,
  buildRequest,
  decodeStream,
  DEFAULT_MODELS,
  detectProvider,
  droppedFailure,
  EFFORTS,
  MODEL_RE,
  networkFailure,
  providerFailure,
  type ChatMessage,
  type ProviderName,
  type ProviderRequest,
} from "@/lib/explain/providers";
import { headroom } from "@/lib/explain/usage";
import { getSession, touch } from "@/lib/session";
import { validSlug } from "@/lib/github";

export const runtime = "nodejs";

// follow-up conversations stay client-side; these bound what we relay
const MAX_QUESTION = 4_000;
const MAX_MESSAGES = 26;
const MAX_TOTAL_CHARS = 400_000;

function err(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

// a lookup answer: meta line, then text, no model
function plain(meta: ExplainMeta, text: string): NextResponse {
  return new NextResponse(JSON.stringify(meta) + "\n" + text, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function githubFailure(e: unknown, destroy: () => void): NextResponse {
  if (e instanceof GithubError) {
    if (e.status === 401) destroy();
    return err(e.status, e.message);
  }
  return err(502, "github request failed");
}

function validHistory(history: unknown): history is ChatMessage[] {
  if (!Array.isArray(history) || history.length === 0) return false;
  if (history.length > MAX_MESSAGES) return false;
  let total = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i] as ChatMessage;
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== expected || typeof m.content !== "string") return false;
    total += m.content.length;
  }
  return total <= MAX_TOTAL_CHARS && history.length % 2 === 0;
}

async function streamProvider(
  request: ProviderRequest,
  provider: ProviderName,
  model: string,
  meta: string
): Promise<NextResponse> {
  // esc (or a new command) cancels our stream; the provider must stop
  // generating too, or the key keeps being billed
  const ctrl = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: ctrl.signal,
    });
  } catch {
    const f = networkFailure(request.url);
    return NextResponse.json({ error: f.error, hint: null }, { status: f.status });
  }
  if (!upstream.ok || !upstream.body) {
    // in our words, with a hint where there is a way out
    const body = (await upstream.text()).slice(0, 4000);
    const f = providerFailure(upstream.status, body, model, { provider, headers: upstream.headers });
    return NextResponse.json({ error: f.error, hint: f.hint ?? null }, { status: f.status });
  }

  const encoder = new TextEncoder();
  const { stream: textStream, decoder } = decodeStream(provider);
  const left = headroom(provider, upstream.headers);
  let cancelled = false;
  const out = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      ctrl.abort();
    },
    async start(controller) {
      controller.enqueue(encoder.encode(meta));
      const reader = upstream.body!.pipeThrough(textStream).getReader();
      // sentinel lines must start a line of their own, without leaving a
      // blank one behind
      let atLineStart = true;
      const sentinel = (line: string) => {
        controller.enqueue(encoder.encode(`${atLineStart ? "" : "\n"}${line}\n`));
        atLineStart = true;
      };
      let dropped = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.length) atLineStart = value[value.length - 1] === 10;
          controller.enqueue(value);
        }
      } catch {
        if (cancelled) return;
        dropped = true;
        sentinel(`[wd:error] ${droppedFailure(request.url).error}`);
      }
      if (cancelled) return;
      if (!dropped) {
        // an error the provider sent on the 200 stream, in our words
        if (decoder.error) {
          const f = providerFailure(0, decoder.error, model, { provider });
          sentinel(`[wd:error] ${f.error}`);
          if (f.hint) sentinel(`[wd:hint] ${f.hint}`);
        }
        // what the answer cost and what is left, for the client's count
        if (decoder.usage || left) {
          sentinel(`[wd:usage] ${JSON.stringify({ ...(decoder.usage ?? {}), left })}`);
        }
      }
      controller.close();
    },
  });
  return new NextResponse(out, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  // same-origin guard; the session cookie is sameSite=lax already
  if (!sameOrigin(req.headers.get("origin"), req.nextUrl.origin)) {
    return err(403, "cross-origin request rejected");
  }

  const session = await getSession();
  if (!session.token) return err(401, "sign in required");
  await touch(session);

  const key = req.headers.get("x-wd-provider-key") ?? "";
  const model = req.headers.get("x-wd-model") ?? "";
  if (model && !MODEL_RE.test(model)) return err(400, "invalid model name");
  const provider = key ? detectProvider(key) : null;
  let effort = req.headers.get("x-wd-effort") ?? "";
  if (effort && provider) {
    const levels = EFFORTS[provider];
    // a level left over from another provider's key is dropped, not
    // rejected, so switching keys never locks the user out
    if (levels.length === 0) effort = "";
    else if (!levels.includes(effort)) {
      return err(400, `effort '${effort}' is not valid for ${provider} (${levels.join(", ")})`);
    }
  }

  let body: {
    owner?: string;
    repo?: string;
    input?: string;
    raw?: boolean;
    followup?: { history?: unknown; question?: unknown };
  };
  try {
    body = await req.json();
  } catch {
    return err(400, "malformed request body");
  }
  const { owner, repo, input, raw, followup } = body;
  if (!owner || !repo || !validSlug(owner, repo)) return err(400, "bad request");

  // follow-up turn: relay the client-held conversation, no github fetch
  if (followup) {
    if (!key || !provider) return err(401, "paste an api key first");
    const question = followup.question;
    if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) {
      return err(400, "bad question");
    }
    if (!validHistory(followup.history)) return err(400, "bad conversation history");
    const request = buildFollowupRequest(
      provider,
      key,
      prompt("").followup,
      followup.history,
      question.trim(),
      model || undefined,
      effort || undefined
    );
    return streamProvider(
      request,
      provider,
      model || DEFAULT_MODELS[provider],
      JSON.stringify({ followup: true } satisfies ExplainMeta) + "\n"
    );
  }

  if (!input) return err(400, "bad request");
  const command = parseCommand(input);
  if (!command) return err(400, "unknown command");

  const destroy = () => session.destroy();

  // lookups: no diff, no model
  if (command.kind === "branches") {
    try {
      return plain({ branches: true }, await branchesText(session.token, owner, repo));
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }
  // the browser's utc offset, so "today" is the user's day
  const tz = Math.max(-840, Math.min(840, Number(req.headers.get("x-wd-tz") ?? 0) || 0));

  // blocks: structured rows the terminal renders as a grid, no model
  if (command.kind === "log") {
    try {
      const filter =
        command.since || command.author
          ? {
              since: command.since,
              author: command.author,
              login: session.login ?? "",
              now: Date.now(),
              tz,
            }
          : undefined;
      const log = await logBlock(
        session.token,
        owner,
        repo,
        command.n ?? LOG_DEFAULT,
        command.ref,
        filter
      );
      return plain({ block: log.block, rows: log.rows, spans: log.spans }, "");
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }
  if (command.kind === "tags") {
    try {
      return plain({ tags: true }, await tagsText(session.token, owner, repo));
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }
  if (command.kind === "prs") {
    try {
      const prs = await prsBlock(session.token, owner, repo, command.state, session.login ?? "");
      return plain({ block: prs.block, rows: prs.rows }, "");
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }
  if (command.kind === "history") {
    try {
      const h = await historyBlock(session.token, owner, repo, command.path, command.ref);
      return plain({ block: h.block, rows: h.rows, spans: h.spans }, "");
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }
  // row numbers only mean something next to the client's last log
  if (command.kind === "row") return err(400, "run log first, then explain a row number");
  // plans: rows to edit and commands to paste, never run here
  if (command.kind === "plan") {
    if (command.source.kind === "row") return err(400, "run log first, then rebase a row span");
    try {
      const plan = await planBlock(session.token, owner, repo, command.source as PlanSource);
      return plain({ block: plan.block }, "");
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }
  if (command.kind === "pick") {
    if (command.rows) return err(400, "run log first, then pick row numbers");
    const source: PlanSource = command.pr
      ? { kind: "pr", num: command.pr }
      : { kind: "shas", shas: command.shas ?? [] };
    if (source.kind === "shas" && !source.shas.length) return err(400, "nothing to pick");
    try {
      const plan = await planBlock(session.token, owner, repo, source, command.onto);
      return plain({ block: plan.block }, "");
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }

  let data: ExplainInput;
  // after the payload: why sends the line itself, describe its context block
  let question = "";
  let mode: PromptMode = command.mode ?? "explain";
  try {
    if (command.kind === "why") {
      const w = await whyInput(
        session.token,
        owner,
        repo,
        command.path,
        command.line,
        command.ref
      );
      question = w.question;
      mode = "why";
      data = w;
    } else if (command.kind === "since") {
      const r = await sinceInput(session.token, owner, repo, {
        period: command.period,
        author: command.author,
        login: session.login ?? "",
        now: Date.now(),
        tz,
      });
      if ("empty" in r) return plain({ empty: r.empty }, "");
      data = r;
    } else if (command.kind === "message") {
      // a commit message for one commit, or the few being squashed into it
      const token = session.token;
      data = mergeInputs(
        await Promise.all(command.shas.map((sha) => commitInput(token, owner, repo, sha)))
      );
      mode = "message";
    } else {
      data =
        command.kind === "last"
          ? await lastNCommits(session.token, owner, repo, command.n, command.ref)
          : command.kind === "pr"
            ? await prInput(session.token, owner, repo, command.num)
            : command.kind === "commit"
              ? await commitInput(session.token, owner, repo, command.sha)
              : await compareRange(session.token, owner, repo, command.base, command.head);
    }
  } catch (e) {
    return githubFailure(e, destroy);
  }

  // a path cuts the diff down before anything is counted
  if (command.path) {
    const cut = filterDiff(data.diff, data.numstat, command.path);
    if (!cut.kept) return plain({ empty: `nothing under ${command.path} in this range` }, "");
    data = {
      ...data,
      diff: cut.diff,
      numstat: cut.numstat,
      note: [data.note, `${cut.kept} of ${cut.total} files, under ${command.path}`]
        .filter(Boolean)
        .join(" · "),
    };
  }

  if (mode === "describe") question = describeTurn(data.describe);

  const { files, added, deleted } = stats(data.numstat);
  const metaBase: DiffMeta = {
    commits: data.commitCount,
    files,
    additions: added,
    deletions: deleted,
    truncated: data.truncated,
    title: data.title ?? null,
    note: data.note ?? null,
    mode,
  };

  if (!data.diff.trim()) {
    return new NextResponse(JSON.stringify(metaBase) + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const payload = preprocess(data.diff, data.commits, data.numstat, defaultCaps, defaultRules());

  // raw mode (/show): the preprocessed payload itself, no model call
  if (raw) {
    return new NextResponse(JSON.stringify(metaBase) + "\n" + payload, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!key || !provider) return err(401, "paste an api key first");
  const { system, user: userBase } = prompt(payload, mode);
  const user = userBase + question;
  const request = buildRequest(provider, key, system, user, model || undefined, effort || undefined);
  // context lets the client hold the conversation for follow-up turns
  const meta = JSON.stringify({ ...metaBase, context: user } satisfies ExplainMeta) + "\n";
  return streamProvider(request, provider, model || DEFAULT_MODELS[provider], meta);
}
