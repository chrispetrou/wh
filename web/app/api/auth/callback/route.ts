import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { appOrigin, githubApi, githubWeb } from "@/lib/origin";
import { getSession } from "@/lib/session";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function GET(req: NextRequest) {
  const url = new URL("/", appOrigin() || req.nextUrl.origin);
  const fail = () => NextResponse.redirect(new URL("/?error=auth", url));

  const jar = await cookies();
  const expected = jar.get("wd_oauth_state")?.value;
  jar.delete("wd_oauth_state");
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  if (!expected || !state || !code || !safeEqual(expected, state)) {
    return fail();
  }

  const tokenRes = await fetch(`${githubWeb()}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${appOrigin()}/api/auth/callback`,
    }),
  });
  const token = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenRes.ok || token.error || !token.access_token) return fail();

  const userRes = await fetch(`${githubApi()}/user`, {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "x-github-api-version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!userRes.ok) return fail();
  const user = (await userRes.json()) as { login?: string };

  const session = await getSession();
  session.token = token.access_token;
  session.login = user.login ?? "";
  session.since = Date.now();
  await session.save();

  // back to the transcript the session ended in, else the picker
  const back = jar.get("wd_oauth_return")?.value;
  jar.delete("wd_oauth_return");
  return NextResponse.redirect(new URL(back && back.startsWith("/repos/") ? back : "/repos", url));
}
