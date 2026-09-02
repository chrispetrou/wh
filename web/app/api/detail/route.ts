// one commit or pull request in full, for the expanded row of a log or
// prs block: parents, author, message, files; or one commit as a plan
// row (files and clashes against a target) for a row dropped into a
// plan. read-only, fetched lazily
import { NextRequest, NextResponse } from "next/server";
import {
  commitDetail,
  fileDetail,
  GithubError,
  planRow,
  prDetail,
  validPath,
  validRef,
  validSlug,
} from "@/lib/github";
import { getSession, touch } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.token) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  await touch(session);
  const q = req.nextUrl.searchParams;
  const owner = q.get("owner");
  const repo = q.get("repo");
  const kind = q.get("kind");
  const id = q.get("id") ?? "";
  if (!owner || !repo || !id || !validSlug(owner, repo)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    if (kind === "commit" && /^[0-9a-f]{7,40}$/i.test(id)) {
      return NextResponse.json(await commitDetail(session.token, owner, repo, id));
    }
    if (kind === "pr" && /^\d{1,6}$/.test(id)) {
      return NextResponse.json(await prDetail(session.token, owner, repo, Number(id)));
    }
    const onto = q.get("onto") ?? "";
    if (kind === "planrow" && /^[0-9a-f]{7,40}$/i.test(id) && onto && !onto.includes("..")) {
      return NextResponse.json(await planRow(session.token, owner, repo, id, onto));
    }
    // the view block's text: id is the path, plus the ref it was pinned to
    const ref = q.get("ref") ?? "";
    if (kind === "file" && validPath(id) && validRef(ref)) {
      return NextResponse.json(await fileDetail(session.token, owner, repo, id, ref));
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
