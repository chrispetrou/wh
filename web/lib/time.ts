// resolves the period words of the chat grammar ("yesterday", "this
// week", "monday", "3 days", "2026-08-20", "standup") into an instant
// range, in the user's local day. pure: the clock and the utc offset
// (minutes, as getTimezoneOffset reports it) come in as arguments.

export interface Period {
  since: string; // iso
  until?: string; // iso, exclusive
  label: string; // "since yesterday", for the empty-result line
}

const DAY = 86_400_000;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// midnight of the local day containing `t`, as a real instant
function startOfDay(t: number, tz: number): number {
  const local = t - tz * 60_000;
  return Math.floor(local / DAY) * DAY + tz * 60_000;
}

function weekday(t: number, tz: number): number {
  return new Date(t - tz * 60_000).getUTCDay();
}

// true when the phrase is a period (not a ref)
export function isPeriod(phrase: string): boolean {
  return resolvePeriod(phrase, 0, 0) !== null;
}

export function resolvePeriod(phrase: string, now: number, tz: number): Period | null {
  const p = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  const today = startOfDay(now, tz);
  const iso = (t: number) => new Date(t).toISOString();

  if (p === "today") return { since: iso(today), label: "today" };
  if (p === "yesterday") {
    return { since: iso(today - DAY), until: iso(today), label: "yesterday" };
  }
  if (p === "this week") {
    const back = (weekday(now, tz) + 6) % 7; // days since monday
    return { since: iso(today - back * DAY), label: "this week" };
  }
  if (p === "last week") {
    const back = (weekday(now, tz) + 6) % 7;
    const monday = today - back * DAY;
    return { since: iso(monday - 7 * DAY), until: iso(monday), label: "last week" };
  }
  // the last working day: friday on a monday or a weekend, else yesterday
  if (p === "standup") {
    const wd = weekday(now, tz);
    const back = wd === 1 ? 3 : wd === 0 ? 2 : 1;
    return { since: iso(today - back * DAY), label: "since the last working day" };
  }
  let m = /^(?:last )?(\d{1,3}) days?(?: ago)?$/.exec(p);
  if (m) {
    const n = parseInt(m[1], 10);
    return { since: iso(today - n * DAY), label: `in the last ${n} ${n === 1 ? "day" : "days"}` };
  }
  m = /^(?:last )?(sun|mon|tues|wednes|thurs|fri|satur)day$/.exec(p);
  if (m) {
    const target = DAYS.indexOf(`${m[1]}day`);
    const back = (weekday(now, tz) - target + 7) % 7 || 7; // today means a week ago
    return { since: iso(today - back * DAY), label: `since ${DAYS[target]}` };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  if (m) {
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (Number.isNaN(utc) || new Date(utc).toISOString().slice(0, 10) !== p) return null;
    const t = utc + tz * 60_000;
    return { since: iso(t), label: `since ${p}` };
  }
  return null;
}
