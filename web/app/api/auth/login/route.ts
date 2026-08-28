import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// ?popup=1: the sign-in runs in a small window opened from a page whose
// session ended; the callback then reports back and closes instead of
// navigating, so that page keeps its transcript
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
  if (req.nextUrl.searchParams.get("popup") === "1") jar.set("wd_oauth_popup", "1", cookie);
  else jar.delete("wd_oauth_popup");
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
