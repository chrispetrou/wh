// one commit or pull request in full, for the expanded row of a log or
// prs block: parents, author, message, files. read-only, fetched lazily
import { NextRequest, NextResponse } from "next/server";
import { commitDetail, GithubError, prDetail } from "@/lib/github";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.token) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const q = req.nextUrl.searchParams;
  const owner = q.get("owner");
  const repo = q.get("repo");
  const kind = q.get("kind");
  const id = q.get("id") ?? "";
  if (!owner || !repo || !id) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    if (kind === "commit" && /^[0-9a-f]{7,40}$/i.test(id)) {
      return NextResponse.json(await commitDetail(session.token, owner, repo, id));
    }
    if (kind === "pr" && /^\d{1,6}$/.test(id)) {
      return NextResponse.json(await prDetail(session.token, owner, repo, Number(id)));
    }
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  } catch (e) {
    if (e instanceof GithubError) {
      if (e.status === 401) session.destroy();
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "github request failed" }, { status: 502 });
  }
}
