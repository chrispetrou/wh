import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface WdSession {
  token?: string;
  login?: string;
}

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
// after a week of silence, never in the middle of a working day
export async function touch(session: IronSession<WdSession>): Promise<void> {
  if (session.token) await session.save();
}
