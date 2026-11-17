// Time zones (IANA names) from the runtime's own data (Intl), so no table has to be shipped or updated. Used for the
// account's time zone and for share links that expire at the end of a day where the person is.

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Whether `tz` is a time zone name this runtime knows ("Europe/Berlin"). */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone's own IANA name ("europe/berlin" → "Europe/Berlin"), or null: unknown, or no region's name ("+05:30", a
 * fixed offset, knows nothing of clock changes). Stored names use this form.
 */
export function canonicalTimeZone(tz: unknown): string | null {
  if (!validTimeZone(tz)) return null;
  const name = formatter(tz).resolvedOptions().timeZone;
  return /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(name) ? name : null;
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of the instant `ms` in `tz`. */
export function wallTime(tz: string, ms: number) {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Offset of `tz` from UTC at the instant `ms`, in minutes (east positive). */
export function offsetAt(tz: string, ms: number): number {
  const w = wallTime(tz, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * The instant at which the wall clock in `tz` shows the given local time: a time that
 * occurs twice (clocks going back) is its first occurrence; a time in the hour skipped when clocks go forward is read
 * with the offset from before the change.
 */
export function zonedToUtc(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  // The offsets a day before and a day after: at most one change lies between them.
  const early = wall - offsetAt(tz, wall - 86_400_000) * 60_000;
  const late = wall - offsetAt(tz, wall + 86_400_000) * 60_000;
  const shows = (ms: number) => offsetAt(tz, ms) * 60_000 === wall - ms;
  if (shows(early) && shows(late)) return Math.min(early, late);
  if (shows(late)) return late;
  return early; // shows this time, or the time was skipped: the offset from before the change
}
