import { NextRequest, NextResponse } from "next/server";
import { ensureBaseEnv, isLocalHost, oauthConfigured, saveEnv } from "@/lib/setup";

export const runtime = "nodejs";

const SHAPE = /^[A-Za-z0-9._-]{8,100}$/;

export async function POST(req: NextRequest) {
  if (oauthConfigured()) {
    return NextResponse.json({ error: "already configured" }, { status: 403 });
  }
  if (!isLocalHost(req.headers.get("host"))) {
    return NextResponse.json(
      { error: "setup is only available on localhost" },
      { status: 403 }
    );
  }

  const form = await req.formData();
  const clientId = String(form.get("client_id") ?? "").trim();
  const clientSecret = String(form.get("client_secret") ?? "").trim();
  if (!SHAPE.test(clientId) || !SHAPE.test(clientSecret)) {
    return NextResponse.redirect(new URL("/?error=setup", req.nextUrl.origin), 303);
  }

  ensureBaseEnv(req.nextUrl.origin);
  saveEnv({ GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret });
  // straight into sign-in; the credentials are live in this process already
  return NextResponse.redirect(new URL("/api/auth/login", req.nextUrl.origin), 303);
}
