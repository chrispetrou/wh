// sign in again without leaving the page: github's consent page cannot
// be framed, so it opens in a small window; the callback posts back and
// closes. resolves true once the session is back, false if the window
// was closed first. a blocked popup falls back to a plain redirect.

const NAME = "wd-signin";

export function signInAgain(): Promise<boolean> {
  const w = 600;
  const h = 720;
  const left = Math.max(0, (window.screen.width - w) / 2);
  const top = Math.max(0, (window.screen.height - h) / 2);
  const win = window.open(
    "/api/auth/login?popup=1",
    NAME,
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`
  );
  if (!win) {
    window.location.href = "/api/auth/login";
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      resolve(ok);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && (e.data as { wd?: string })?.wd === "signed-in") {
        finish(true);
      }
    };
    window.addEventListener("message", onMessage);
    const poll = setInterval(() => {
      if (win.closed) finish(false);
    }, 500);
  });
}
