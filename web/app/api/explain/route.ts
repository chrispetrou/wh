import { NextRequest, NextResponse } from "next/server";
import { LOG_DEFAULT, parseCommand } from "@/lib/commands";
import {
  branchesText,
  commitInput,
  compareRange,
  GithubError,
  lastNCommits,
  logText,
  prInput,
  prsText,
  sinceInput,
  tagsText,
  type ExplainInput,
} from "@/lib/github";
import { defaultCaps, defaultRules, preprocess, stats } from "@/lib/explain/preprocess";
import { prompt } from "@/lib/explain/prompt";
import {
  buildFollowupRequest,
  buildRequest,
  detectProvider,
  EFFORTS,
  MODEL_RE,
  sseToText,
  type ChatMessage,
  type ProviderName,
  type ProviderRequest,
} from "@/lib/explain/providers";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

// follow-up conversations stay client-side; these bound what we relay
const MAX_QUESTION = 4_000;
const MAX_MESSAGES = 26;
const MAX_TOTAL_CHARS = 400_000;

function err(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

// a lookup answer: meta line, then text, no model
function plain(meta: object, text: string): NextResponse {
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
  meta: string
): Promise<NextResponse> {
  const upstream = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });
  if (!upstream.ok || !upstream.body) {
    const body = (await upstream.text()).slice(0, 200);
    if (upstream.status === 401) return err(401, "provider rejected the key");
    if (upstream.status === 429) return err(429, "provider rate limit");
    return err(502, `provider error: ${body.trim()}`);
  }

  const encoder = new TextEncoder();
  const textStream = upstream.body.pipeThrough(sseToText(provider));
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(meta));
      const reader = textStream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        controller.enqueue(encoder.encode("\n[wd:error] stream interrupted\n"));
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
  const origin = req.headers.get("origin");
  if (origin && process.env.APP_URL && origin !== process.env.APP_URL) {
    return err(403, "cross-origin request rejected");
  }

  const session = await getSession();
  if (!session.token) return err(401, "sign in required");

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

  const { owner, repo, input, raw, followup } = (await req.json()) as {
    owner?: string;
    repo?: string;
    input?: string;
    raw?: boolean;
    followup?: { history?: unknown; question?: unknown };
  };
  if (!owner || !repo) return err(400, "bad request");

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
    return streamProvider(request, provider, JSON.stringify({ followup: true }) + "\n");
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
  if (command.kind === "log") {
    try {
      const log = await logText(session.token, owner, repo, command.n ?? LOG_DEFAULT, command.ref);
      return plain({ log: true, count: log.count, rails: log.rails, rows: log.rows }, log.text);
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
      const prs = await prsText(session.token, owner, repo, command.state, session.login ?? "");
      return plain({ prs: true, rows: prs.rows }, prs.text);
    } catch (e) {
      return githubFailure(e, destroy);
    }
  }
  // row numbers only mean something next to the client's last log
  if (command.kind === "row") return err(400, "run log first, then explain a row number");

  // the browser's utc offset, so "today" is the user's day
  const tz = Math.max(-840, Math.min(840, Number(req.headers.get("x-wd-tz") ?? 0) || 0));

  let data: ExplainInput;
  try {
    if (command.kind === "since") {
      const r = await sinceInput(session.token, owner, repo, {
        period: command.period,
        author: command.author,
        login: session.login ?? "",
        now: Date.now(),
        tz,
      });
      if ("empty" in r) return plain({ empty: r.empty }, "");
      data = r;
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

  const { files, added, deleted } = stats(data.numstat);
  const metaBase = {
    commits: data.commitCount,
    files,
    additions: added,
    deletions: deleted,
    truncated: data.truncated,
    title: data.title ?? null,
    note: data.note ?? null,
    mode: command.mode ?? null,
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
  const { system, user } = prompt(payload, command.mode ?? "explain");
  const request = buildRequest(provider, key, system, user, model || undefined, effort || undefined);
  // context lets the client hold the conversation for follow-up turns
  const meta = JSON.stringify({ ...metaBase, context: user }) + "\n";
  return streamProvider(request, provider, meta);
}
