// branch and tag names for the chat's completion menu; failures come
// back as empty lists so the menu just stays quiet
import { NextRequest, NextResponse } from "next/server";
import { branchNames, tagNames } from "@/lib/github";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.token) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const owner = req.nextUrl.searchParams.get("owner");
  const repo = req.nextUrl.searchParams.get("repo");
  if (!owner || !repo) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const [branches, tags] = await Promise.all([
    branchNames(session.token, owner, repo).catch(() => [] as string[]),
    tagNames(session.token, owner, repo).catch(() => [] as string[]),
  ]);
  return NextResponse.json({ branches, tags });
}
