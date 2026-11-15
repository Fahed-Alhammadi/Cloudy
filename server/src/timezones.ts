// Time zones for calendar events: IANA names → iCalendar VTIMEZONE components, built from the runtime's own time zone
// data (Intl), so no table has to be shipped or updated. Repeating events need them: a weekly 09:00 meeting stored as
// a fixed UTC time moved to 10:00 when the clocks changed.

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
 * fixed offset, knows nothing of the clock changes a calendar needs). Stored names and event TZIDs use this form.
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

interface Transition { at: number; from: number; to: number }

/** Offset changes of `tz` between the two instants, found day by day and narrowed down to the minute. */
function transitions(tz: string, fromMs: number, toMs: number): Transition[] {
  const out: Transition[] = [];
  const DAY = 86400_000;
  let prevMs = fromMs;
  let prev = offsetAt(tz, prevMs);
  for (let ms = fromMs + DAY; ms <= toMs; ms += DAY) {
    const cur = offsetAt(tz, ms);
    if (cur !== prev) {
      let lo = prevMs;
      let hi = ms;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (offsetAt(tz, mid) === prev) lo = mid; else hi = mid;
      }
      out.push({ at: hi, from: prev, to: cur });
    }
    prevMs = ms;
    prev = cur;
  }
  return out;
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
const offsetText = (min: number) => `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The local wall time (in the offset before the change) at which a transition happens. */
function describe(t: Transition) {
  const local = new Date(t.at + t.from * 60_000); // UTC fields of this Date = wall time before the change
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  const d = local.getUTCDate();
  const stamp = `${y}${pad(m)}${pad(d)}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`;
  return { stamp, year: y, month: m, day: d, weekday: local.getUTCDay(), clock: stamp.slice(9), daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

/**
 * The yearly rule that produces every one of these changes (all of one kind, one per year), or null. Tried: "the nth
 * (or last) weekday of the month", then "the weekday on or after day X" (Chile: the Sunday after the first Saturday
 * of April, which is the second Sunday in some years).
 */
function yearlyRule(list: ReturnType<typeof describe>[]): string | null {
  const f = list[0];
  if (!list.every((d) => d.month === f.month && d.weekday === f.weekday && d.clock === f.clock)) return null;
  const nth = (d: typeof f) => (d.day + 7 > d.daysInMonth ? -1 : Math.ceil(d.day / 7));
  if (list.every((d) => nth(d) === nth(f))) return `FREQ=YEARLY;BYMONTH=${f.month};BYDAY=${nth(f)}${DAYS[f.weekday]}`;
  const first = Math.min(...list.map((d) => d.day));
  if (list.every((d) => d.day < first + 7) && first + 6 <= 28) {
    const days = Array.from({ length: 7 }, (_, i) => first + i).join(',');
    return `FREQ=YEARLY;BYMONTH=${f.month};BYDAY=${DAYS[f.weekday]};BYMONTHDAY=${days}`;
  }
  return null;
}

const cache = new Map<string, string>();

/**
 * A VTIMEZONE for `tz`, valid from the year before `aroundMs` (the event's start) for 20 years. Zones that change by
 * a fixed yearly rule ("last Sunday of March at 02:00") get the rule, checked against all 20 years; zones without
 * changes their one offset; anything else each change listed one by one.
 */
export function vtimezone(tz: string, aroundMs: number): string {
  const year = new Date(aroundMs).getUTCFullYear() - 1;
  const key = `${tz}|${year}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const YEAR = 365.25 * 86400_000;
  const start = Date.UTC(year, 0, 1);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  const all = transitions(tz, start, start + 20 * YEAR);
  if (!all.length) {
    const off = offsetAt(tz, aroundMs);
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${offsetText(off)}`, `TZOFFSETTO:${offsetText(off)}`, 'END:STANDARD');
  } else {
    const kinds = new Map<string, ReturnType<typeof describe>[]>();
    for (const t of all) {
      const k = `${t.from}>${t.to}`;
      kinds.set(k, [...(kinds.get(k) ?? []), describe(t)]);
    }
    const rules = [...kinds.values()].map(yearlyRule);
    if (kinds.size === 2 && rules.every(Boolean) && [...kinds.values()].every((l) => l.length >= 15)) {
      [...kinds.keys()].forEach((k, i) => {
        const [from, to] = k.split('>').map(Number);
        const kind = to > from ? 'DAYLIGHT' : 'STANDARD';
        lines.push(`BEGIN:${kind}`, `DTSTART:${kinds.get(k)![0].stamp}`, `TZOFFSETFROM:${offsetText(from)}`, `TZOFFSETTO:${offsetText(to)}`,
          `RRULE:${rules[i]}`, `END:${kind}`);
      });
    } else {
      // Irregular: the offset in force at the start, then every change.
      const first = offsetAt(tz, start);
      lines.push('BEGIN:STANDARD', `DTSTART:${describe({ at: start, from: first, to: first }).stamp}`,
        `TZOFFSETFROM:${offsetText(first)}`, `TZOFFSETTO:${offsetText(first)}`, 'END:STANDARD');
      for (const t of all) {
        const kind = t.to > t.from ? 'DAYLIGHT' : 'STANDARD';
        lines.push(`BEGIN:${kind}`, `DTSTART:${describe(t).stamp}`, `TZOFFSETFROM:${offsetText(t.from)}`, `TZOFFSETTO:${offsetText(t.to)}`, `END:${kind}`);
      }
    }
  }
  const out = [...lines, 'END:VTIMEZONE'].join('\r\n');
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

/**
 * The instant at which the wall clock in `tz` shows the given local time, read as RFC 5545 §3.3.5 says: a time that
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
