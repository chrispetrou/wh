import { describe, expect, it } from "vitest";
import { isPeriod, resolvePeriod } from "./time";

// thursday 2026-08-27 02:30 in athens (utc+3, offset -180): still
// wednesday in utc, which is exactly the case the tz handling exists for
const NOW = Date.parse("2026-08-26T23:30:00Z");
const ATHENS = -180;

describe("resolvePeriod", () => {
  it("uses the local day, not the utc day", () => {
    expect(resolvePeriod("today", NOW, ATHENS)).toEqual({
      since: "2026-08-26T21:00:00.000Z", // thursday 00:00 athens
      label: "today",
    });
    expect(resolvePeriod("today", NOW, 0)!.since).toBe("2026-08-26T00:00:00.000Z");
  });

  it("bounds yesterday and last week on both sides", () => {
    expect(resolvePeriod("yesterday", NOW, ATHENS)).toEqual({
      since: "2026-08-25T21:00:00.000Z",
      until: "2026-08-26T21:00:00.000Z",
      label: "yesterday",
    });
    // this week started monday 24th; last week is the 17th to the 24th
    expect(resolvePeriod("this week", NOW, ATHENS)!.since).toBe("2026-08-23T21:00:00.000Z");
    expect(resolvePeriod("last week", NOW, ATHENS)).toEqual({
      since: "2026-08-16T21:00:00.000Z",
      until: "2026-08-23T21:00:00.000Z",
      label: "last week",
    });
  });

  it("finds the most recent weekday, a week back when it is today", () => {
    expect(resolvePeriod("since monday".replace("since ", ""), NOW, ATHENS)!.since).toBe(
      "2026-08-23T21:00:00.000Z"
    );
    expect(resolvePeriod("last friday", NOW, ATHENS)!.since).toBe("2026-08-20T21:00:00.000Z");
    expect(resolvePeriod("thursday", NOW, ATHENS)!.since).toBe("2026-08-19T21:00:00.000Z");
  });

  it("standup means the last working day", () => {
    // thursday: yesterday
    expect(resolvePeriod("standup", NOW, ATHENS)!.since).toBe("2026-08-25T21:00:00.000Z");
    // monday 31st: friday 28th
    const monday = Date.parse("2026-08-31T08:00:00Z");
    expect(resolvePeriod("standup", monday, 0)!.since).toBe("2026-08-28T00:00:00.000Z");
    // sunday 30th: friday too
    const sunday = Date.parse("2026-08-30T08:00:00Z");
    expect(resolvePeriod("standup", sunday, 0)!.since).toBe("2026-08-28T00:00:00.000Z");
  });

  it("takes day counts and iso dates", () => {
    expect(resolvePeriod("3 days", NOW, 0)!.since).toBe("2026-08-23T00:00:00.000Z");
    expect(resolvePeriod("last 10 days", NOW, 0)!.label).toBe("in the last 10 days");
    expect(resolvePeriod("2026-08-20", NOW, ATHENS)!.since).toBe("2026-08-19T21:00:00.000Z");
    expect(resolvePeriod("2026-13-45", NOW, ATHENS)).toBeNull();
  });

  it("returns null for refs", () => {
    expect(resolvePeriod("v1.2", NOW, 0)).toBeNull();
    expect(resolvePeriod("main", NOW, 0)).toBeNull();
    expect(isPeriod("yesterday")).toBe(true);
    expect(isPeriod("feat/x")).toBe(false);
  });
});
