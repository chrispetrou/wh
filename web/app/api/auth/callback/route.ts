import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function GET(req: NextRequest) {
  const url = new URL("/", process.env.APP_URL);
  const fail = () => NextResponse.redirect(new URL("/?error=auth", url));

  const jar = await cookies();
  const expected = jar.get("wd_oauth_state")?.value;
  jar.delete("wd_oauth_state");
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  if (!expected || !state || !code || !safeEqual(expected, state)) {
    return fail();
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${process.env.APP_URL}/api/auth/callback`,
    }),
  });
  const token = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenRes.ok || token.error || !token.access_token) return fail();

  const userRes = await fetch("https://api.github.com/user", {
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
  await session.save();

  // a popup sign-in reports back to the page that opened it and closes
  if (jar.get("wd_oauth_popup")?.value === "1") {
    jar.delete("wd_oauth_popup");
    return new NextResponse(POPUP_DONE, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return NextResponse.redirect(new URL("/repos", url));
}

const POPUP_DONE = `<!doctype html><meta charset="utf-8"><title>wd</title>
<body style="margin:0;padding:24px;font:13px/1.7 ui-monospace,'SF Mono',Menlo,monospace;color:#1a1a1a;background:#fff">
signed in, you can close this window.
<script>
try { if (window.opener) window.opener.postMessage({ wd: "signed-in" }, location.origin); } catch (e) {}
window.close();
</script>`;
