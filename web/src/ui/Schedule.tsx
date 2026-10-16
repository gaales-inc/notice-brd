import {
  currentSpan,
  epochToLocal,
  localToEpoch,
  MAX_SLOTS,
  nextStart,
  OnceSlot,
  Schedule,
  Slot,
  slotProblem,
  WeeklySlot,
} from "../../../shared/schedule";
import { isTimeZone } from "../../../shared/zones";
import { Icon, ScreenChooser, Segmented } from "./common";

/** Monday first. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const HOUR = 3_600_000;
const REPEAT_LABEL: Record<Slot["type"], string> = { once: "Once", weekly: "Every week" };

/** This browser's time zone, which a new schedule is set in. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The schedule's zone if this browser knows it (it nearly always does), else this browser's. */
export const usableZone = (zone: string) => (isTimeZone(zone) ? zone : browserZone());

export const blankSchedule = (): Schedule => ({ timeZone: browserZone(), screenIds: null, slots: [] });

/** The next whole hour, for an hour. */
function newOnce(zone: string): OnceSlot {
  const start = `${epochToLocal(Date.now() + HOUR, zone).slice(0, 14)}00`;
  return { type: "once", start, end: epochToLocal((localToEpoch(start, zone) ?? Date.now()) + HOUR, zone) };
}

const newWeekly = (): WeeklySlot => ({ type: "weekly", days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" });

// ---------------------------------------------------------------- in words

const dayName = (d: number, weekday: "short" | "long") =>
  new Date(Date.UTC(2026, 0, 4 + d)).toLocaleDateString([], { weekday, timeZone: "UTC" }); // 4 January 2026 was a Sunday

/** "09:00" as this browser writes a time of day. */
const timeText = (time: string) =>
  new Date(Date.UTC(2000, 0, 1, Number(time.slice(0, 2)), Number(time.slice(3, 5)))).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** "2026-10-17" → "Sat 17 Oct". */
const dateText = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Days of the week, with three or more in a row as a range: "Mon–Fri", "Mon, Wed, Fri". */
export function daysText(days: number[]): string {
  if (days.length === 7) return "Every day";
  const ordered = WEEK.filter((d) => days.includes(d));
  const parts: string[] = [];
  for (let i = 0; i < ordered.length; ) {
    let j = i;
    while (j + 1 < ordered.length && WEEK.indexOf(ordered[j + 1]!) === WEEK.indexOf(ordered[j]!) + 1) j++;
    if (j - i >= 2) parts.push(`${dayName(ordered[i]!, "short")}–${dayName(ordered[j]!, "short")}`);
    else for (let k = i; k <= j; k++) parts.push(dayName(ordered[k]!, "short"));
    i = j + 1;
  }
  return parts.join(", ");
}

const isAllDay = (slot: WeeklySlot) => slot.from === "00:00" && slot.to === "00:00";

export function slotText(slot: Slot): string {
  if (slot.type === "weekly") {
    const hours = isAllDay(slot)
      ? "all day"
      : slot.from === slot.to
        ? `24 hours from ${timeText(slot.from)}`
        : `${timeText(slot.from)}–${timeText(slot.to)}`;
    return `${daysText(slot.days)}, ${hours}`;
  }
  const [startDate, startTime] = slot.start.split("T") as [string, string];
  const [endDate, endTime] = slot.end.split("T") as [string, string];
  return startDate === endDate
    ? `${dateText(startDate)}, ${timeText(startTime)}–${timeText(endTime)}`
    : `${dateText(startDate)} ${timeText(startTime)} – ${dateText(endDate)} ${timeText(endTime)}`;
}

/** "Today 9:00", "Tomorrow 9:00", "Sat 17 Oct 9:00" — in the schedule's zone. */
export function whenText(epoch: number, zone: string, now = Date.now()): string {
  const local = epochToLocal(epoch, zone);
  const time = timeText(local.slice(11));
  const date = local.slice(0, 10);
  if (date === epochToLocal(now, zone).slice(0, 10)) return `Today ${time}`;
  if (date === epochToLocal(now + 24 * HOUR, zone).slice(0, 10)) return `Tomorrow ${time}`;
  return `${dateText(date)} ${time}`;
}

/** Like whenText, but just the time if it's today. */
export function untilText(epoch: number, zone: string, now = Date.now()): string {
  const when = whenText(epoch, zone, now);
  return when.startsWith("Today ") ? when.slice(6) : when;
}

// ---------------------------------------------------------------- editing

/** "Show at set times": when, and on which screens. */
export function SchedulePicker({
  on,
  value,
  onChange,
  screens,
}: {
  on: boolean;
  value: Schedule;
  onChange: (on: boolean, value: Schedule) => void;
  screens: { id: string; name: string }[];
}) {
  const zone = usableZone(value.timeZone);
  const now = Date.now();
  const set = (slots: Slot[]) => onChange(true, { ...value, slots });
  const valid = value.slots.length > 0 && value.slots.every((s) => !slotProblem(s, zone));

  let when = "";
  if (valid) {
    const current = currentSpan(value, now);
    const next = nextStart(value, now);
    when = current
      ? `On now${current.end ? `, until ${untilText(current.end, zone, now)}` : ""}.`
      : next
        ? `Next: ${whenText(next, zone, now)}.`
        : "None of these times are still to come.";
  }

  return (
    <div class="auto-cal">
      <label class="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const checked = (e.target as HTMLInputElement).checked;
            onChange(checked, checked && !value.slots.length ? { ...value, slots: [newOnce(zone)] } : value);
          }}
        />
        <span>Show automatically at set times</span>
      </label>
      {on && (
        <div class="auto-cal-options">
          <ul class="slot-list">
            {value.slots.map((slot, i) => (
              <SlotEditor
                key={i}
                slot={slot}
                zone={zone}
                now={now}
                onChange={(s) => set(value.slots.map((old, j) => (j === i ? s : old)))}
                onRemove={value.slots.length > 1 ? () => set(value.slots.filter((_, j) => j !== i)) : undefined}
              />
            ))}
          </ul>
          {value.slots.length < MAX_SLOTS && (
            <button
              type="button"
              class="button subtle add-slot"
              onClick={() => set([...value.slots, value.slots[value.slots.length - 1]?.type === "weekly" ? newWeekly() : newOnce(zone)])}
            >
              <Icon name="plus" />
              <span>Add another time</span>
            </button>
          )}
          <ScreenChooser value={value.screenIds} onChange={(screenIds) => onChange(true, { ...value, screenIds })} screens={screens} />
          <p class="faint small auto-cal-note">
            {when} It comes on at each time and goes off at its end — then each screen goes back to what it was showing.
            {zone !== browserZone() && ` Times are in ${zone.replace(/_/g, " ")}.`}
          </p>
        </div>
      )}
    </div>
  );
}

function SlotEditor({
  slot,
  zone,
  now,
  onChange,
  onRemove,
}: {
  slot: Slot;
  zone: string;
  now: number;
  onChange: (s: Slot) => void;
  onRemove?: () => void;
}) {
  const problem = slotProblem(slot, zone);
  const over = !problem && slot.type === "once" && (localToEpoch(slot.end, zone) ?? 0) <= now;
  const value = (e: Event) => (e.target as HTMLInputElement).value;

  /** A new start keeps the length it had, so moving it doesn't leave the end behind. */
  const moveStart = (once: OnceSlot, start: string) => {
    const [oldStart, oldEnd, newStart] = [localToEpoch(once.start, zone), localToEpoch(once.end, zone), localToEpoch(start, zone)];
    const end = oldStart !== null && oldEnd !== null && newStart !== null && oldEnd > oldStart ? epochToLocal(newStart + oldEnd - oldStart, zone) : once.end;
    onChange({ ...once, start, end });
  };

  return (
    <li class="slot">
      <div class="slot-head">
        <Segmented
          label="How often"
          value={slot.type}
          options={REPEAT_LABEL}
          onChange={(type) => type !== slot.type && onChange(type === "once" ? newOnce(zone) : newWeekly())}
        />
        {onRemove && (
          <button type="button" class="icon-button" aria-label="Remove this time" title="Remove" onClick={onRemove}>
            <Icon name="trash" />
          </button>
        )}
      </div>

      {slot.type === "once" ? (
        <div class="slot-times">
          <label class="field compact">
            <span>From</span>
            <input type="datetime-local" required value={slot.start} onInput={(e) => moveStart(slot, value(e))} />
          </label>
          <label class="field compact">
            <span>Until</span>
            <input type="datetime-local" required value={slot.end} min={slot.start} onInput={(e) => onChange({ ...slot, end: value(e) })} />
          </label>
        </div>
      ) : (
        <>
          <div class="day-picker" role="group" aria-label="Days">
            {WEEK.map((d) => {
              const picked = slot.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={picked}
                  class={picked ? "selected" : ""}
                  title={dayName(d, "long")}
                  onClick={() => onChange({ ...slot, days: picked ? slot.days.filter((x) => x !== d) : [...slot.days, d].sort((a, b) => a - b) })}
                >
                  {dayName(d, "short")}
                </button>
              );
            })}
          </div>
          <label class="check all-day">
            <input
              type="checkbox"
              checked={isAllDay(slot)}
              onChange={(e) => onChange({ ...slot, ...((e.target as HTMLInputElement).checked ? { from: "00:00", to: "00:00" } : { from: "09:00", to: "17:00" }) })}
            />
            <span>All day</span>
          </label>
          {!isAllDay(slot) && (
            <div class="slot-times">
              <label class="field compact">
                <span>From</span>
                <input type="time" required value={slot.from} onInput={(e) => onChange({ ...slot, from: value(e).slice(0, 5) })} />
              </label>
              <label class="field compact">
                <span>Until</span>
                <input type="time" required value={slot.to} onInput={(e) => onChange({ ...slot, to: value(e).slice(0, 5) })} />
              </label>
            </div>
          )}
        </>
      )}

      {problem ? (
        <p class="error small slot-note">{problem}</p>
      ) : over ? (
        <p class="warn small slot-note">This time is over.</p>
      ) : slot.type === "weekly" && !isAllDay(slot) && slot.to <= slot.from ? (
        <p class="faint small slot-note">{slot.to === slot.from ? "It stays on for 24 hours." : "It goes off the next day."}</p>
      ) : null}
    </li>
  );
}
