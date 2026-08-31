// clears a dead session (revoked or expired token) without the logout
// POST dance; reached via redirects and the "sign in again" link an
// opened row shows when its fetch came back 401.
import { NextRequest, NextResponse } from "next/server";
import { appOrigin, sameOrigin } from "@/lib/origin";
import { getSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const home = appOrigin() || req.nextUrl.origin;
  // a get that ends the session must not be reachable from another site;
  // browsers without sec-fetch-site fall back to the referer's origin
  const site = req.headers.get("sec-fetch-site");
  let referer: string | null = null;
  try {
    referer = new URL(req.headers.get("referer") ?? "").origin;
  } catch {
    referer = null;
  }
  if (site === "cross-site" || (!site && !sameOrigin(referer, req.nextUrl.origin))) {
    return NextResponse.redirect(new URL("/", home));
  }
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/?error=session", home));
}
