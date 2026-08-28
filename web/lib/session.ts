import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface WdSession {
  token?: string;
  login?: string;
  since?: number; // sign-in time, epoch ms: the ceiling counts from here
}

// a session slides for a week of silence but never past this from the
// sign-in itself, so a stolen cookie cannot be kept alive indefinitely
export const MAX_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export const sessionOptions: SessionOptions = {
  cookieName: "wd_session",
  password: process.env.SESSION_SECRET ?? "",
  ttl: 60 * 60 * 24 * 7,
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  },
};

export async function getSession(): Promise<IronSession<WdSession>> {
  return getIronSession<WdSession>(await cookies(), sessionOptions);
}

// sliding expiry: every api call re-issues the cookie, so a session ends
// after a week of silence, never in the middle of a working day. past the
// ceiling it is not renewed; it then runs out on its own within the week
export async function touch(session: IronSession<WdSession>): Promise<void> {
  if (!session.token) return;
  if (session.since && Date.now() - session.since > MAX_SESSION_MS) return;
  await session.save();
}
