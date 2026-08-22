// clears a dead session (revoked token) without the logout POST dance;
// only ever reached via server redirects, never linked.
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/?error=session", process.env.APP_URL));
}
