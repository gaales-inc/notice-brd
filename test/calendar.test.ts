import { describe, expect, it } from "vitest";
import { describeFeed, findCallLink, meetingsFromIcs, normalizeFeedUrl } from "../server/calendar";
import { GOOGLE_FEED } from "./fixtures";



const at = (iso: string) => new Date(iso).getTime();

describe("meetingsFromIcs", () => {
  it("expands recurring meetings, with moved and cancelled occurrences, and keeps only those with a call link", () => {
    const meetings = meetingsFromIcs(GOOGLE_FEED, at("2026-10-01T00:00:00Z"), at("2026-10-23T00:00:00Z"));
    expect(meetings.map((m) => [m.title, new Date(m.start).toISOString(), new Date(m.end).toISOString()])).toEqual([
      // 10:00 Kampala (UTC+3) is 07:00 UTC; the 8th is excluded.
      ["Weekly sync", "2026-10-01T07:00:00.000Z", "2026-10-01T07:30:00.000Z"],
      ["Weekly sync (moved)", "2026-10-15T11:00:00.000Z", "2026-10-15T12:00:00.000Z"],
      ["Client call", "2026-10-15T16:00:00.000Z", "2026-10-15T16:30:00.000Z"],
      ["Weekly sync", "2026-10-22T07:00:00.000Z", "2026-10-22T07:30:00.000Z"],
    ]);
    expect(meetings[0]!.link).toBe("https://meet.google.com/abc-defg-hij");
    expect(meetings[2]!.link).toContain("zoom.us/j/81234567890");
  });

  it("uses a zone a feed names without defining", () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "DTSTART;TZID=Europe/London:20260715T090000",
      "DTEND;TZID=Europe/London:20260715T100000",
      "UID:x",
      "SUMMARY:Standup",
      "DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [m] = meetingsFromIcs(feed, at("2026-07-14T00:00:00Z"), at("2026-07-16T00:00:00Z"));
    // British Summer Time is UTC+1.
    expect(new Date(m!.start).toISOString()).toBe("2026-07-15T08:00:00.000Z");
  });

  it("refuses something that isn't a calendar", () => {
    expect(() => meetingsFromIcs("<html>Sign in</html>", 0, 1)).toThrow(/isn't an iCalendar feed/);
  });
});

describe("call links", () => {
  it("finds rooms on the usual services, not their home pages", () => {
    expect(findCallLink("Join: https://meet.google.com/abc-defg-hij")).toBeTruthy();
    expect(findCallLink("https://company.zoom.us/j/123456789")).toBeTruthy();
    expect(findCallLink("https://teams.microsoft.com/l/meetup-join/19%3a")).toBeTruthy();
    expect(findCallLink("https://whereby.com/team-room")).toBeTruthy();
    expect(findCallLink("Download Zoom at https://zoom.us/download")).toBeNull();
    expect(findCallLink("https://meet.google.com/")).toBeNull();
    expect(findCallLink("Room 4, second floor")).toBeNull();
  });
});

describe("feed addresses", () => {
  it("takes https and webcal, and nothing internal", () => {
    expect(normalizeFeedUrl("webcal://p01-caldav.icloud.com/published/2/abc")).toBe("https://p01-caldav.icloud.com/published/2/abc");
    expect(normalizeFeedUrl(" https://calendar.google.com/calendar/ical/x/private-y/basic.ics ")).toContain("calendar.google.com");
    expect(normalizeFeedUrl("http://calendar.google.com/x.ics")).toBeNull();
    expect(normalizeFeedUrl("https://mailr:8025/send")).toBeNull();
    expect(normalizeFeedUrl("https://10.0.0.5/cal.ics")).toBeNull();
    expect(normalizeFeedUrl("https://printer.local/cal.ics")).toBeNull();
    expect(normalizeFeedUrl("https://cal.example.com:8443/x.ics")).toBeNull();
    expect(normalizeFeedUrl("not a url")).toBeNull();
  });

  it("describes a feed without giving its secret away", () => {
    const d = describeFeed("https://calendar.google.com/calendar/ical/me%40x.com/private-0123456789abcdef/basic.ics");
    expect(d).toBe("calendar.google.com/…/basic.ics");
    expect(d).not.toContain("private");
  });
});
