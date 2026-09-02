// sign in again and come back: the page goes to github and returns to
// the same repo page, where the transcript is waiting (sessionStorage).
// what to do on return is left in sessionStorage too: rerun a command,
// or reopen the row whose fetch died with the session.

export interface Resume {
  cmd?: string; // the command to rerun
  line?: number; // the block line and row to reopen
  open?: string;
}

const KEY = (repo: string) => `wh_resume:${repo}`;

export function signInAgain(repo: string, resume: Resume): void {
  try {
    sessionStorage.setItem(KEY(repo), JSON.stringify(resume));
  } catch {
    // ignore: the sign-in still works, only the rerun is lost
  }
  const back = encodeURIComponent(window.location.pathname);
  window.location.href = `/api/auth/login?return=${back}`;
}

// the pending resume for this repo, taken exactly once
export function takeResume(repo: string): Resume | null {
  try {
    const raw = sessionStorage.getItem(KEY(repo));
    if (!raw) return null;
    sessionStorage.removeItem(KEY(repo));
    return JSON.parse(raw) as Resume;
  } catch {
    return null;
  }
}
