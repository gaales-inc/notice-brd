/**
 * Wall-clock time in a named time zone, both ways, through Intl — which knows
 * every zone's daylight-saving rules, in Node and in the browsers the
 * dashboard runs in.
 */

/** Year, month (1–12), day, hour, minute, second. */
export type WallTime = [number, number, number, number, number, number];

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws for a zone Intl doesn't know. */
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time in `zone` at an instant. Throws for a zone Intl doesn't know. */
export function wallTime(epoch: number, zone: string): WallTime {
  const p = Object.fromEntries(formatter(zone).formatToParts(new Date(epoch)).map((x) => [x.type, x.value]));
  // Some engines write midnight as 24 even with h23.
  return [+p.year!, +p.month!, +p.day!, +p.hour! % 24, +p.minute!, +p.second!];
}

/** Wall-clock time in a named zone → epoch ms; null for a zone Intl doesn't know. */
export function zonedToEpoch(parts: WallTime, zone: string): number | null {
  try {
    const offsetAt = (epoch: number) => {
      const [y, mo, d, h, mi, s] = wallTime(epoch, zone);
      return Date.UTC(y, mo - 1, d, h, mi, s) - epoch;
    };
    const naive = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    let epoch = naive - offsetAt(naive);
    // Once more, in case the guess landed on the other side of a DST change.
    epoch = naive - offsetAt(epoch);
    return epoch;
  } catch {
    return null;
  }
}
