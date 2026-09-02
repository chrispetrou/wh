import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { appOrigin, githubWeb, secureCookies } from "@/lib/origin";

// ?return=/repos/o/r: where to land after github, so a session that
// ended mid-transcript comes back to that transcript. same-site paths
// only; anything else lands on the repo picker
export async function GET(req: NextRequest) {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/?error=config", appOrigin() || req.nextUrl.origin));
  }
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  const cookie = {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  jar.set("wh_oauth_state", state, cookie);
  const back = req.nextUrl.searchParams.get("return") ?? "";
  if (/^\/repos\/[^/?#]+\/[^/?#]+$/.test(back)) jar.set("wh_oauth_return", back, cookie);
  else jar.delete("wh_oauth_return");
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID ?? "",
    redirect_uri: `${appOrigin()}/api/auth/callback`,
    scope: "repo",
    state,
  });
  return NextResponse.redirect(`${githubWeb()}/login/oauth/authorize?${params}`);
}
