/**
 * Schedules: set times when a message shows by itself.
 *
 * A message can be scheduled for times of its own — once, from one moment to
 * another, or every week, on chosen days between two times of day — on all
 * the board's screens or chosen ones. Like a meeting, a scheduled time puts
 * the message on a screen for a while without replacing what the screen was
 * told to show: when the time is up, the screen goes back to that.
 *
 * Times are wall-clock times in the schedule's own time zone (the one the
 * dashboard that set it was in), so "9:00 on weekdays" stays 9:00 when the
 * clocks change. Shared by the API, which checks and runs schedules, and the
 * dashboard, which edits them and says when they next come on.
 */
import { isTimeZone, wallTime, WallTime, zonedToEpoch } from "./zones";

/** From one moment to another, each "YYYY-MM-DDTHH:MM" (as a datetime-local input writes it). */
export interface OnceSlot {
  type: "once";
  start: string;
  end: string;
}

/**
 * Every week, on these days (0 = Sunday … 6 = Saturday), from one time of day
 * ("HH:MM") to another. A `to` earlier than `from` ends the next day; the same
 * time for both is the whole day.
 */
export interface WeeklySlot {
  type: "weekly";
  days: number[];
  from: string;
  to: string;
}

export type Slot = OnceSlot | WeeklySlot;

export interface Schedule {
  timeZone: string;
  /** null: all the board's screens. */
  screenIds: string[] | null;
  slots: Slot[];
}

/** A stretch of time, in epoch ms. */
export interface Span {
  start: number;
  end: number;
}

export const MAX_SLOTS = 20;
export const MAX_ONCE_DAYS = 366;

const DAY = 86_400_000;
/** How far ahead the end of a showing is looked for; one that runs past it (every day, all day) just runs on. */
const HORIZON_DAYS = 14;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "2026-10-17T09:00" in `zone` → epoch ms; null if it isn't a real date and time. */
export function localToEpoch(value: string, zone: string): number | null {
  const m = LOCAL.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return zonedToEpoch([y, mo, d, h, mi, 0], zone);
}

/** Epoch ms → "2026-10-17T09:00" in `zone`, for a datetime-local input. */
export function epochToLocal(epoch: number, zone: string): string {
  const [y, mo, d, h, mi] = wallTime(epoch, zone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${y}-${two(mo)}-${two(d)}T${two(h)}:${two(mi)}`;
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** What's wrong with one time, in words fit to show; null if nothing. */
export function slotProblem(slot: Slot, zone: string): string | null {
  if (slot.type === "once") {
    const start = localToEpoch(slot.start, zone);
    const end = localToEpoch(slot.end, zone);
    if (start === null || end === null) return "Give it a start and an end.";
    if (end <= start) return "It has to end after it starts.";
    if (end - start > MAX_ONCE_DAYS * DAY) return `It can last up to ${MAX_ONCE_DAYS} days.`;
    return null;
  }
  if (!slot.days.length) return "Choose the days it shows on.";
  if (!TIME.test(slot.from) || !TIME.test(slot.to)) return "Give it a start and an end.";
  return null;
}

/**
 * Checks a schedule sent to the API: the schedule to keep, or what's wrong
 * with it in words fit to show.
 */
export function parseSchedule(value: unknown): Schedule | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "The schedule isn't valid.";
  const v = value as Record<string, unknown>;
  if (!isTimeZone(v.timeZone)) return "The schedule's time zone isn't one NoticeBrd knows.";
  const timeZone = v.timeZone;

  let screenIds: string[] | null = null;
  if (v.screenIds !== null && v.screenIds !== undefined) {
    const ids = v.screenIds;
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
      return "Choose the screens it should show on.";
    }
    screenIds = [...new Set(ids as string[])];
  }

  if (!Array.isArray(v.slots) || !v.slots.length) return "Add a time for it to show.";
  if (v.slots.length > MAX_SLOTS) return `A message can be scheduled for up to ${MAX_SLOTS} times.`;
  const slots: Slot[] = [];
  for (const raw of v.slots as unknown[]) {
    const s = (raw ?? {}) as Record<string, unknown>;
    let slot: Slot;
    if (s.type === "once" && typeof s.start === "string" && typeof s.end === "string") {
      slot = { type: "once", start: s.start, end: s.end };
    } else if (s.type === "weekly" && typeof s.from === "string" && typeof s.to === "string" && Array.isArray(s.days)) {
      if (!s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return "Choose the days of the week it shows on.";
      slot = { type: "weekly", days: [...new Set(s.days as number[])].sort((a, b) => a - b), from: s.from, to: s.to };
    } else return "The schedule isn't valid.";
    const problem = slotProblem(slot, timeZone);
    if (problem) return `A scheduled time isn't right: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`;
    slots.push(slot);
  }
  return { timeZone, screenIds, slots };
}

/**
 * The stretches of time the schedule shows for that overlap [from, to), in
 * order, with any that touch or overlap joined — so Monday all day and
 * Tuesday all day are one stretch.
 */
export function scheduleSpans(schedule: Pick<Schedule, "timeZone" | "slots">, from: number, to: number): Span[] {
  const zone = schedule.timeZone;
  const found: Span[] = [];
  const add = (start: number | null, end: number | null) => {
    if (start !== null && end !== null && end > start && end > from && start < to) found.push({ start, end });
  };
  for (const slot of schedule.slots) if (slot.type === "once") add(localToEpoch(slot.start, zone), localToEpoch(slot.end, zone));

  const weekly = schedule.slots.filter((s): s is WeeklySlot => s.type === "weekly");
  if (weekly.length && Number.isFinite(to)) {
    let first: WallTime;
    try {
      // From the day before: a time that started yesterday can run into today.
      first = wallTime(from - DAY, zone);
    } catch {
      return [];
    }
    const [y, mo, d] = first;
    const at = (day: Date, time: string) =>
      zonedToEpoch([day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0], zone);
    const days = Math.ceil((to - from) / DAY) + 2;
    for (let i = 0; i < days; i++) {
      const date = new Date(Date.UTC(y, mo - 1, d + i));
      for (const slot of weekly) {
        if (!slot.days.includes(date.getUTCDay())) continue;
        const nextDay = minutesOf(slot.to) > minutesOf(slot.from) ? 0 : 1;
        add(at(date, slot.from), at(new Date(Date.UTC(y, mo - 1, d + i + nextDay)), slot.to));
      }
    }
  }

  found.sort((a, b) => a.start - b.start);
  const joined: Span[] = [];
  for (const span of found) {
    const last = joined[joined.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else joined.push({ ...span });
  }
  return joined;
}

/**
 * The stretch the schedule is showing for at `now`, if any. Its `end` is null
 * when weekly times keep it on past the next two weeks (every day, all day).
 */
export function currentSpan(schedule: Pick<Schedule, "timeZone" | "slots">, now: number): { start: number; end: number | null } | null {
  const horizon = now + HORIZON_DAYS * DAY;
  const span = scheduleSpans(schedule, now, horizon + DAY).find((s) => s.start <= now && now < s.end);
  if (!span) return null;
  const weekly = schedule.slots.some((s) => s.type === "weekly");
  return { start: span.start, end: weekly && span.end >= horizon ? null : span.end };
}

/** When the schedule next comes on after `now`; null if it never does again. */
export function nextStart(schedule: Pick<Schedule, "timeZone" | "slots">, now: number): number | null {
  const soon = scheduleSpans(schedule, now, now + 8 * DAY).find((s) => s.start > now);
  if (soon) return soon.start;
  // Beyond a week, only a one-off time can come up.
  let best: number | null = null;
  for (const slot of schedule.slots) {
    if (slot.type !== "once") continue;
    const start = localToEpoch(slot.start, schedule.timeZone);
    if (start !== null && start > now && (best === null || start < best)) best = start;
  }
  return best;
}
