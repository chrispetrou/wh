// branch names for the chat's completion menu; failures come back as an
// empty list so the menu just stays quiet
import { NextRequest, NextResponse } from "next/server";
import { branchNames } from "@/lib/github";
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
  try {
    const branches = await branchNames(session.token, owner, repo);
    return NextResponse.json({ branches });
  } catch {
    return NextResponse.json({ branches: [] });
  }
}
