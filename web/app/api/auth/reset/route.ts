// clears a dead session (revoked or expired token) without the logout
// POST dance; reached via redirects and the "sign in again" link an
// opened row shows when its fetch came back 401.
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/?error=session", process.env.APP_URL));
}
