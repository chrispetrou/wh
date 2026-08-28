import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// ?return=/repos/o/r: where to land after github, so a session that
// ended mid-transcript comes back to that transcript. same-site paths
// only; anything else lands on the repo picker
export async function GET(req: NextRequest) {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/?error=config", process.env.APP_URL));
  }
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  const cookie = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  jar.set("wd_oauth_state", state, cookie);
  const back = req.nextUrl.searchParams.get("return") ?? "";
  if (/^\/repos\/[^/?#]+\/[^/?#]+$/.test(back)) jar.set("wd_oauth_return", back, cookie);
  else jar.delete("wd_oauth_return");
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID ?? "",
    redirect_uri: `${process.env.APP_URL}/api/auth/callback`,
    scope: "repo",
    state,
  });
  return NextResponse.redirect(
    `https://github.com/login/oauth/authorize?${params}`
  );
}
