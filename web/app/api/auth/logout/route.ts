import { NextRequest, NextResponse } from "next/server";
import { appOrigin, sameOrigin } from "@/lib/origin";
import { getSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req.headers.get("origin"))) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/", appOrigin() || req.nextUrl.origin), 303);
}
