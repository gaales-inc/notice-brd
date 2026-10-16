/**
 * Calendars: messages that show themselves during meetings.
 *
 * A board can follow calendar feeds — the iCalendar ("secret address" / ICS)
 * link that Google Calendar, Outlook, iCloud and most others publish. No
 * sign-in to anyone's calendar provider is needed, and the link only reads.
 * Every few minutes each feed is fetched and its meetings around now are
 * worked out — recurring ones expanded, moved and cancelled occurrences
 * respected — keeping only those with a call link (Meet, Zoom, Teams, …) in
 * any of their fields.
 *
 * A message set to show during meetings goes on its screens when one of those
 * meetings starts and comes off when the last one ends. It doesn't replace
 * what the screen was told to show: when the meeting is over, the screen goes
 * back to that. Messages scheduled for set times (shared/schedule.ts) come and
 * go the same way, worked out alongside.
 */
import ICAL from "ical.js";
import { currentSpan, Schedule } from "../shared/schedule";
import { zonedToEpoch } from "../shared/zones";
import { Db } from "./db";
import type { Live } from "./screens";

export interface Meeting {
  uid: string;
  title: string;
  /** Epoch ms. */
  start: number;
  end: number;
  link: string;
}

/** What a meeting or a scheduled time puts on a screen meanwhile. */
export interface AutoOverride {
  boardId: string;
  messageId: string;
  kind: "meeting" | "schedule";
  /** The meeting's calendar and title; null for a scheduled time. */
  calendarId: string | null;
  title: string | null;
  /** Epoch ms it comes off; null for a schedule that keeps it on past the next two weeks. */
  end: number | null;
}

export const FETCH_EVERY_MS = 3 * 60_000;
const WINDOW_BEFORE_MS = 24 * 60 * 60_000;
const WINDOW_AFTER_MS = 3 * 24 * 60 * 60_000;
const MAX_FEED_BYTES = 15 * 1024 * 1024;
const MAX_MEETINGS = 300;

/**
 * Call links from the services people meet on. A link to the service's home
 * page (a "download Zoom" footer, say) doesn't count: it has to name a room.
 */
const CALL_LINKS: RegExp[] = [
  /https?:\/\/meet\.google\.com\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}[^\s"'<>)\]]*/i,
  /https?:\/\/(?:[\w-]+\.)*(?:zoom\.us|zoom\.com|zoomgov\.com)\/(?:j|my|w|wc|s)\/[^\s"'<>)\]]+/i,
  /https?:\/\/teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)\]]+/i,
  /https?:\/\/teams\.live\.com\/meet\/[^\s"'<>)\]]+/i,
  /https?:\/\/(?:[\w-]+\.)*webex\.com\/(?:meet|join|[\w-]+\/j\.php|[\w-]+\/meet)[^\s"'<>)\]]*/i,
  /https?:\/\/whereby\.com\/[\w-]+/i,
  /https?:\/\/meet\.jit\.si\/[^\s"'<>)\]]+/i,
  /https?:\/\/8x8\.vc\/[^\s"'<>)\]]+/i,
  /https?:\/\/facetime\.apple\.com\/join[^\s"'<>)\]]+/i,
  /https?:\/\/(?:app\.)?chime\.aws\/\d+[^\s"'<>)\]]*/i,
  /https?:\/\/(?:[\w-]+\.)?gotomeeting\.com\/join\/[^\s"'<>)\]]+/i,
  /https?:\/\/meet\.goto\.com\/[^\s"'<>)\]]+/i,
  /https?:\/\/(?:[\w-]+\.)?bluejeans\.com\/\d+[^\s"'<>)\]]*/i,
  /https?:\/\/join\.skype\.com\/[^\s"'<>)\]]+/i,
  /https?:\/\/(?:app\.)?slack\.com\/huddle\/[^\s"'<>)\]]+/i,
  /https?:\/\/v\.ringcentral\.com\/join\/[^\s"'<>)\]]+/i,
  /https?:\/\/meetings\.ringcentral\.com\/j\/[^\s"'<>)\]]+/i,
];

export function findCallLink(text: string): string | null {
  for (const re of CALL_LINKS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

// ------------------------------------------------------------------- feeds

/**
 * Checks a feed address and returns the one to fetch. webcal:// is how
 * calendar apps spell https:// for subscriptions. Only public https hosts:
 * the server fetches it, so it must not be pointed at anything internal.
 */
export function normalizeFeedUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let raw = value.trim();
  if (!raw || raw.length > 2000) return null;
  raw = raw.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/.test(host)) return null;
  // No IP addresses: a calendar provider has a name.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null;
  if (url.port && url.port !== "443") return null;
  return url.toString();
}

/** "calendar.google.com/…/basic.ics": enough to recognise a feed without giving its secret away. */
export function describeFeed(url: string): string {
  try {
    const u = new URL(url);
    const file = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return file ? `${u.hostname}/…/${file.length > 24 ? `${file.slice(0, 10)}…` : file}` : u.hostname;
  } catch {
    return "calendar";
  }
}

export type FeedFetcher = (url: string) => Promise<string>;

export const fetchFeed: FeedFetcher = async (url) => {
  const res = await fetch(url, {
    headers: { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5", "User-Agent": "NoticeBrd (+https://noticebrd.gaales.com)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new FeedError(res.status === 404 || res.status === 410 ? "The calendar address wasn't found." : `The calendar answered with an error (${res.status}).`);
  const length = Number(res.headers.get("content-length") || 0);
  if (length > MAX_FEED_BYTES) throw new FeedError("That calendar is too large to follow.");
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new FeedError("That calendar is too large to follow.");
  return text;
};

/** An error whose message is fit to show to the person who added the calendar. */
export class FeedError extends Error {}

// ----------------------------------------------------------------- parsing

/**
 * A time from the feed → epoch ms. ical.js converts times in zones the feed
 * defines (VTIMEZONE) or UTC. A feed that names a zone without defining it —
 * common outside Google and Outlook — leaves ical.js with a floating time, so
 * the zone named on the property (`tzid`), then the calendar's own
 * (X-WR-TIMEZONE), are applied through Intl.
 */
function toEpoch(time: ICAL.Time, tzid: string | null, calendarZone: string | null): number {
  const zone = time.zone;
  if (zone && zone.tzid && zone.tzid !== "floating") return time.toUnixTime() * 1000;
  const parts: [number, number, number, number, number, number] = [time.year, time.month, time.day, time.hour, time.minute, time.second];
  for (const candidate of [tzid, calendarZone]) {
    if (!candidate || candidate === "floating") continue;
    const epoch = zonedToEpoch(parts, candidate);
    if (epoch !== null) return epoch;
  }
  return Date.UTC(...parts.map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number, number, number, number]);
}

/** Every text value on the event, so a link anywhere — location, notes, conference data — counts. */
function eventText(component: ICAL.Component): string {
  const out: string[] = [];
  for (const prop of component.getAllProperties()) {
    for (const value of prop.getValues()) {
      if (typeof value === "string") out.push(value);
      else if (value && typeof (value as { toString?: unknown }).toString === "function") out.push(String(value));
    }
  }
  return out.join("\n");
}

/**
 * The meetings with a call link that overlap [from, to], from an iCalendar
 * feed. Recurring meetings are expanded, with their moved and cancelled
 * occurrences; all-day events and cancelled meetings never count.
 */
export function meetingsFromIcs(ics: string, from: number, to: number): Meeting[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new FeedError("That address doesn't point to a calendar (it isn't an iCalendar feed).");
  }
  if (root.name !== "vcalendar") throw new FeedError("That address doesn't point to a calendar (it isn't an iCalendar feed).");

  // Zones the feed defines (VTIMEZONE) are found by ical.js from the feed
  // itself, so nothing is registered globally where feeds could clash.
  const calendarZone = (root.getFirstPropertyValue("x-wr-timezone") as string | null) || null;

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  const singles: ICAL.Event[] = [];
  for (const vevent of root.getAllSubcomponents("vevent")) {
    let event: ICAL.Event;
    try {
      event = new ICAL.Event(vevent);
    } catch {
      continue;
    }
    if (!event.startDate) continue;
    if (event.isRecurrenceException()) exceptions.push(event);
    else if (event.uid && !masters.has(event.uid)) masters.set(event.uid, event);
    else singles.push(event);
  }
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else singles.push(ex);
  }

  const tzidOf = (component: ICAL.Component, name: string): string | null => {
    const value = component.getFirstProperty(name)?.getParameter("tzid");
    return typeof value === "string" ? value : null;
  };

  const meetings: Meeting[] = [];
  const consider = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null) => {
    if (start.isDate) return; // all-day
    const component = item.component;
    if (String(component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED") return;
    const startZone = tzidOf(component, "dtstart");
    const startMs = toEpoch(start, startZone, calendarZone);
    const endMs = end ? toEpoch(end, tzidOf(component, "dtend") ?? startZone, calendarZone) : startMs + 30 * 60_000;
    if (endMs <= from || startMs >= to || endMs <= startMs) return;
    const link = findCallLink(eventText(component));
    if (!link) return;
    meetings.push({ uid: item.uid || "", title: (item.summary || "Meeting").slice(0, 200), start: startMs, end: endMs, link });
  };

  for (const event of [...masters.values(), ...singles]) {
    try {
      if (!event.isRecurring()) {
        consider(event, event.startDate, event.endDate);
        continue;
      }
      const it = event.iterator();
      const zone = tzidOf(event.component, "dtstart");
      // Stop a little past the window: a moved occurrence can land later than its slot.
      const stopAt = to + WINDOW_AFTER_MS;
      for (let i = 0, next = it.next(); next && i < 20_000; i++, next = it.next()) {
        const slot = toEpoch(next, zone, calendarZone);
        if (slot > stopAt) break;
        if (slot < from - WINDOW_BEFORE_MS) continue;
        const details = event.getOccurrenceDetails(next);
        consider(details.item, details.startDate, details.endDate);
      }
    } catch {
      /* one bad event mustn't lose the rest */
    }
  }

  meetings.sort((a, b) => a.start - b.start);
  return meetings.slice(0, MAX_MEETINGS);
}

// --------------------------------------------------------------- scheduling

interface AutoMessage {
  id: string;
  auto_calendar: boolean;
  auto_calendar_id: string | null;
  auto_screen_ids: string[] | null;
  schedule: Schedule | null;
}

const onScreen = (screenIds: string[] | null, screenId: string) => !Array.isArray(screenIds) || screenIds.includes(screenId);

/**
 * Fetches feeds when they're due and, every 15 s and just after each whole
 * minute (when scheduled times start and end), works out which screens a
 * meeting or a schedule is putting a message on. Also run straight after
 * anything that could change the answer: a message's settings, a new
 * calendar, a screen moving.
 */
export class CalendarSync {
  private timers: NodeJS.Timeout[] = [];
  private minuteTimer: NodeJS.Timeout | null = null;
  private syncing = new Set<string>();

  constructor(
    private live: Live,
    private fetcher: FeedFetcher = fetchFeed,
    private now: () => number = Date.now
  ) {}

  private get db(): Db {
    return this.live.db;
  }

  start() {
    const tick = (fn: () => Promise<void>, ms: number) => {
      const t = setInterval(() => void fn().catch((err) => console.error("Calendar job failed:", err)), ms);
      t.unref();
      this.timers.push(t);
    };
    tick(() => this.syncDue(), 30_000);
    tick(() => this.evaluateAll(), 15_000);
    const onTheMinute = () => {
      this.minuteTimer = setTimeout(() => {
        void this.evaluateAll().catch((err) => console.error("Calendar job failed:", err));
        onTheMinute();
      }, 60_000 - (this.now() % 60_000) + 250);
      this.minuteTimer.unref();
    };
    onTheMinute();
    void this.evaluateAll().catch((err) => console.error("Calendar job failed:", err));
    void this.syncDue().catch((err) => console.error("Calendar job failed:", err));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    if (this.minuteTimer) clearTimeout(this.minuteTimer);
  }

  /** Fetches the feeds not fetched for a while. */
  async syncDue() {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM calendars
        WHERE fetched_at IS NULL OR fetched_at < $1::timestamptz
        ORDER BY fetched_at NULLS FIRST LIMIT 25`,
      [new Date(this.now() - FETCH_EVERY_MS).toISOString()]
    );
    for (const { id } of rows) await this.sync(id).catch(() => undefined);
  }

  /** Fetches one feed now. Throws a FeedError worth showing if it can't be followed. */
  async sync(calendarId: string): Promise<void> {
    if (this.syncing.has(calendarId)) return;
    this.syncing.add(calendarId);
    try {
      const { rows } = await this.db.query<{ url: string; board_id: string }>("SELECT url, board_id FROM calendars WHERE id = $1", [
        calendarId,
      ]);
      const cal = rows[0];
      if (!cal) return;
      try {
        let text: string;
        try {
          text = await this.fetcher(cal.url);
        } catch (err) {
          throw err instanceof FeedError ? err : new FeedError("Couldn't reach that calendar address.");
        }
        const now = this.now();
        const meetings = meetingsFromIcs(text, now - WINDOW_BEFORE_MS, now + WINDOW_AFTER_MS);
        await this.db.query("UPDATE calendars SET fetched_at = NOW(), error = NULL, meetings = $2::jsonb WHERE id = $1", [
          calendarId,
          JSON.stringify(meetings),
        ]);
      } catch (err) {
        // Keep the meetings already known: a feed that's down for a minute
        // shouldn't take a sign off the door mid-meeting.
        const message = err instanceof FeedError ? err.message : "Couldn't read that calendar.";
        await this.db.query("UPDATE calendars SET fetched_at = NOW(), error = $2 WHERE id = $1", [calendarId, message]);
        throw err instanceof FeedError ? err : new FeedError(message);
      } finally {
        await this.evaluate(cal.board_id);
      }
    } finally {
      this.syncing.delete(calendarId);
    }
  }

  async evaluateAll() {
    const { rows } = await this.db.query<{ board_id: string }>(
      "SELECT DISTINCT board_id FROM messages WHERE auto_calendar OR schedule IS NOT NULL"
    );
    const boards = new Set(rows.map((r) => r.board_id));
    // Boards whose last meeting- or schedule-driven message needs taking down.
    for (const o of this.live.overrides.values()) boards.add(o.boardId);
    for (const id of boards) await this.evaluate(id);
  }

  /** Works out which of the board's screens a meeting or a schedule is putting a message on right now. */
  async evaluate(boardId: string) {
    const now = this.now();
    const [{ rows: messages }, { rows: calendars }, { rows: screens }] = await Promise.all([
      this.db.query<AutoMessage>(
        `SELECT id, auto_calendar, auto_calendar_id, auto_screen_ids, schedule FROM messages
          WHERE board_id = $1 AND (auto_calendar OR schedule IS NOT NULL) ORDER BY updated_at DESC, id`,
        [boardId]
      ),
      this.db.query<{ id: string; meetings: Meeting[] }>("SELECT id, meetings FROM calendars WHERE board_id = $1", [boardId]),
      this.db.query<{ id: string }>("SELECT id FROM screens WHERE board_id = $1", [boardId]),
    ]);

    const next = new Map<string, AutoOverride>();
    for (const m of messages) {
      let live: { meeting: Meeting; calendarId: string } | null = null;
      if (m.auto_calendar) {
        for (const c of calendars.filter((c) => !m.auto_calendar_id || c.id === m.auto_calendar_id)) {
          for (const meeting of c.meetings ?? []) {
            if (meeting.start <= now && now < meeting.end && (!live || meeting.end > live.meeting.end)) live = { meeting, calendarId: c.id };
          }
        }
      }
      let scheduled: { end: number | null } | null = null;
      try {
        scheduled = m.schedule ? currentSpan(m.schedule, now) : null;
      } catch {
        /* one bad schedule mustn't stop the rest */
      }
      if (!live && !scheduled) continue;
      for (const s of screens) {
        if (next.has(s.id)) continue; // the most recently edited message wins a screen
        if (live && onScreen(m.auto_screen_ids, s.id)) {
          next.set(s.id, { boardId, messageId: m.id, kind: "meeting", calendarId: live.calendarId, title: live.meeting.title, end: live.meeting.end });
        } else if (scheduled && onScreen(m.schedule!.screenIds, s.id)) {
          next.set(s.id, { boardId, messageId: m.id, kind: "schedule", calendarId: null, title: null, end: scheduled.end });
        }
      }
    }

    let changed = false;
    for (const [screenId, o] of this.live.overrides) {
      if (o.boardId !== boardId) continue;
      const n = next.get(screenId);
      if (!n || n.messageId !== o.messageId || n.kind !== o.kind || n.end !== o.end || n.title !== o.title) {
        this.live.overrides.delete(screenId);
        changed = true;
      }
    }
    for (const [screenId, o] of next) {
      if (!this.live.overrides.has(screenId)) {
        this.live.overrides.set(screenId, o);
        changed = true;
      }
    }
    if (changed) await this.live.boardChanged(boardId);
  }
}
