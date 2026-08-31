// the hosts the auth routes talk to, read at call time so a first-run
// setup that writes .env.local is seen without a restart

// APP_URL as a bare origin: a trailing slash or a path in the config
// must not break the same-origin check or the oauth redirect uri
export function appOrigin(): string {
  try {
    return new URL(process.env.APP_URL ?? "").origin;
  } catch {
    return "";
  }
}

// `fallback` is the request's own origin, used when APP_URL is unset
// so the guard never silently disables
export function sameOrigin(origin: string | null, fallback = ""): boolean {
  const app = appOrigin() || fallback;
  return !origin || !app || origin === app;
}

export function githubApi(): string {
  return (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
}

// github's web host for oauth: github.com, or the enterprise host the
// api url points at
export function githubWeb(): string {
  const api = githubApi();
  if (api === "https://api.github.com") return "https://github.com";
  try {
    return new URL(api).origin;
  } catch {
    return "https://github.com";
  }
}
