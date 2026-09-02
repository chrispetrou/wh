/// <reference types="react/experimental" />

import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
import { experimental_taintUniqueValue as taintUniqueValue } from "react";
import { cookies } from "next/headers";
import { loginAllowed } from "./allowlist";
import { secureCookies } from "./origin";

export interface WdSession {
  token?: string;
  login?: string;
  since?: number; // sign-in time, epoch ms: the ceiling counts from here
}

// a session slides for a week of silence but never past this from the
// sign-in itself, so a stolen cookie cannot be kept alive indefinitely
export const MAX_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// read per call: a first-run setup writes the secret while the process
// runs
export const sessionOptions = (): SessionOptions => ({
  cookieName: "wd_session",
  password: process.env.SESSION_SECRET ?? "",
  ttl: 60 * 60 * 24 * 7,
  cookieOptions: {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
  },
});

export async function getSession(): Promise<IronSession<WdSession>> {
  const session = await getIronSession<WdSession>(await cookies(), sessionOptions());
  // a login dropped from WD_ALLOWED_LOGINS loses access on its next
  // request: strip the in-memory session, never destroy() (cookie
  // writes are illegal during server-component render). touch() then
  // never re-seals it, so the stale cookie lapses within its ttl
  if (session.token && !loginAllowed(session.login)) {
    session.token = undefined;
    session.login = undefined;
    session.since = undefined;
  }
  // the github token stays on the server: react throws if it is ever
  // passed to a client component or serialized into the rsc payload
  if (session.token) {
    taintUniqueValue("the github token must not leave the server", session, session.token);
  }
  return session;
}

// sliding expiry: every api call re-issues the cookie, so a session ends
// after a week of silence, never in the middle of a working day. past the
// ceiling it is not renewed; it then runs out on its own within the week
export async function touch(session: IronSession<WdSession>): Promise<void> {
  if (!session.token) return;
  if (session.since && Date.now() - session.since > MAX_SESSION_MS) return;
  await session.save();
}
