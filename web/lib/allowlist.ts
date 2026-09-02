// who may sign in to this instance, read at call time so env changes
// (and the first-run setup that writes .env.local) are seen per request

// WH_ALLOWED_LOGINS as a lowercase set: comma-separated github logins,
// whitespace tolerated. null means the var is unset or empty: open
// access, anyone with a github account
export function allowedLogins(): Set<string> | null {
  const raw = process.env.WH_ALLOWED_LOGINS ?? "";
  const logins = raw
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  return logins.length > 0 ? new Set(logins) : null;
}

// github logins are case-insensitive; a missing login never passes an
// active list
export function loginAllowed(login: string | undefined): boolean {
  const list = allowedLogins();
  if (!list) return true;
  return list.has((login ?? "").toLowerCase());
}
