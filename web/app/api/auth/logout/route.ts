import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && process.env.APP_URL && origin !== process.env.APP_URL) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/", process.env.APP_URL), 303);
}
