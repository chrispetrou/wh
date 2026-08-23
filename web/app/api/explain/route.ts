import { NextRequest, NextResponse } from "next/server";
import { parseCommand } from "@/lib/commands";
import {
  compareRange,
  GithubError,
  lastNCommits,
  prInput,
  type ExplainInput,
} from "@/lib/github";
import { defaultCaps, defaultRules, preprocess, stats } from "@/lib/explain/preprocess";
import { prompt } from "@/lib/explain/prompt";
import { buildRequest, detectProvider, MODEL_RE, sseToText } from "@/lib/explain/providers";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

function err(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
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

  const { owner, repo, input, raw } = (await req.json()) as {
    owner?: string;
    repo?: string;
    input?: string;
    raw?: boolean;
  };
  if (!owner || !repo || !input) return err(400, "bad request");
  const command = parseCommand(input);
  if (!command) return err(400, "unknown command");

  let data: ExplainInput;
  try {
    data =
      command.kind === "last"
        ? await lastNCommits(session.token, owner, repo, command.n)
        : command.kind === "pr"
          ? await prInput(session.token, owner, repo, command.num)
          : await compareRange(session.token, owner, repo, command.base, command.head);
  } catch (e) {
    if (e instanceof GithubError) {
      if (e.status === 401) session.destroy();
      return err(e.status, e.message);
    }
    return err(502, "github request failed");
  }

  const { files, added, deleted } = stats(data.numstat);
  const meta =
    JSON.stringify({
      commits: data.commitCount,
      files,
      additions: added,
      deletions: deleted,
      truncated: data.truncated,
      title: data.title ?? null,
      note: data.note ?? null,
    }) + "\n";

  if (!data.diff.trim()) {
    return new NextResponse(meta, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const payload = preprocess(data.diff, data.commits, data.numstat, defaultCaps, defaultRules());

  // raw mode (/show): the preprocessed payload itself, no model call
  if (raw) {
    return new NextResponse(meta + payload, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!key) return err(401, "paste an api key first");
  const model = req.headers.get("x-wd-model") ?? "";
  if (model && !MODEL_RE.test(model)) return err(400, "invalid model name");
  const { system, user } = prompt(payload);
  const provider = detectProvider(key);
  const request = buildRequest(provider, key, system, user, model || undefined);

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
