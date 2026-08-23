import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/?error=config", process.env.APP_URL));
  }
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("wd_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
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
