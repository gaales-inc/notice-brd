import { describe, expect, it } from "vitest";
import { currentSpan, nextStart, parseSchedule } from "../shared/schedule";

const at = (iso: string) => new Date(iso).getTime();
/** UTC+3 all year. */
const KAMPALA = "Africa/Kampala";

const weekly = (days: number[], from: string, to: string, timeZone = KAMPALA) => ({
  timeZone,
  slots: [{ type: "weekly" as const, days, from, to }],
});

describe("schedules", () => {
  it("shows on chosen days between two times, in the schedule's own time zone", () => {
    const weekdays = weekly([1, 2, 3, 4, 5], "09:00", "17:00");
    // Thursday 15 October 2026.
    expect(currentSpan(weekdays, at("2026-10-15T05:59:00Z"))).toBeNull();
    expect(currentSpan(weekdays, at("2026-10-15T06:00:00Z"))).toEqual({ start: at("2026-10-15T06:00:00Z"), end: at("2026-10-15T14:00:00Z") });
    expect(currentSpan(weekdays, at("2026-10-15T14:00:00Z"))).toBeNull();
    // Friday evening: next on Monday at 9:00.
    expect(nextStart(weekdays, at("2026-10-16T15:00:00Z"))).toBe(at("2026-10-19T06:00:00Z"));
  });

  it("runs past midnight when it ends before it starts, and joins back-to-back days", () => {
    const fridayNight = weekly([5], "22:00", "02:00");
    expect(currentSpan(fridayNight, at("2026-10-16T22:30:00Z"))).toEqual({ start: at("2026-10-16T19:00:00Z"), end: at("2026-10-16T23:00:00Z") });

    // Saturday and Sunday, all day: one stretch, Saturday 00:00 to Monday 00:00.
    const weekend = weekly([6, 0], "00:00", "00:00");
    expect(currentSpan(weekend, at("2026-10-17T12:00:00Z"))).toEqual({ start: at("2026-10-16T21:00:00Z"), end: at("2026-10-18T21:00:00Z") });

    // Every day, all day: on, with no end in sight.
    expect(currentSpan(weekly([0, 1, 2, 3, 4, 5, 6], "00:00", "00:00"), at("2026-10-15T12:00:00Z"))).toEqual({
      start: expect.any(Number),
      end: null,
    });
  });

  it("keeps 9:00 at 9:00 when the clocks change", () => {
    const sundays = weekly([0], "09:00", "10:00", "Europe/London");
    expect(nextStart(sundays, at("2026-10-17T12:00:00Z"))).toBe(at("2026-10-18T08:00:00Z")); // summer time
    expect(nextStart(sundays, at("2026-10-19T12:00:00Z"))).toBe(at("2026-10-25T09:00:00Z")); // winter time
  });

  it("shows once, from one moment to another", () => {
    const once = { timeZone: KAMPALA, slots: [{ type: "once" as const, start: "2026-10-20T08:30", end: "2026-10-22T18:00" }] };
    expect(nextStart(once, at("2026-10-15T12:00:00Z"))).toBe(at("2026-10-20T05:30:00Z"));
    expect(currentSpan(once, at("2026-10-21T12:00:00Z"))).toEqual({ start: at("2026-10-20T05:30:00Z"), end: at("2026-10-22T15:00:00Z") });
    expect(nextStart(once, at("2026-10-23T00:00:00Z"))).toBeNull();

    const newYear = { timeZone: KAMPALA, slots: [{ type: "once" as const, start: "2027-01-01T00:00", end: "2027-01-01T06:00" }] };
    expect(nextStart(newYear, at("2026-10-15T12:00:00Z"))).toBe(at("2026-12-31T21:00:00Z"));
  });

  it("checks a schedule sent to the API", () => {
    const ok = { timeZone: KAMPALA, screenIds: null, slots: [{ type: "weekly", days: [5, 1, 1], from: "09:00", to: "17:00" }] };
    expect(parseSchedule(ok)).toEqual({ ...ok, slots: [{ type: "weekly", days: [1, 5], from: "09:00", to: "17:00" }] });
    expect(parseSchedule({ ...ok, timeZone: "Mars/Olympus" })).toMatch(/time zone/);
    expect(parseSchedule({ ...ok, slots: [] })).toMatch(/Add a time/);
    expect(parseSchedule({ ...ok, slots: [{ type: "weekly", days: [], from: "09:00", to: "17:00" }] })).toMatch(/days/);
    expect(parseSchedule({ ...ok, slots: [{ type: "weekly", days: [1], from: "9am", to: "17:00" }] })).toMatch(/start and an end/);
    expect(parseSchedule({ ...ok, slots: [{ type: "once", start: "2026-10-20T10:00", end: "2026-10-20T09:00" }] })).toMatch(/end after it starts/);
    expect(parseSchedule({ ...ok, slots: [{ type: "once", start: "2026-02-30T10:00", end: "2026-03-01T09:00" }] })).toMatch(/start and an end/);
    expect(parseSchedule({ ...ok, screenIds: ["not-a-screen"] })).toMatch(/screens/);
  });
});
