// clears a dead session (revoked or expired token) without the logout
// POST dance; reached via redirects and the "sign in again" link an
// opened row shows when its fetch came back 401.
import { NextRequest, NextResponse } from "next/server";
import { appOrigin } from "@/lib/origin";
import { getSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const home = appOrigin() || req.nextUrl.origin;
  // a get that ends the session must not be reachable from another site
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.redirect(new URL("/", home));
  }
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/?error=session", home));
}
