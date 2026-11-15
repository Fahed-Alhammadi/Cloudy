// Time zones for calendar events (server 1.19): the VTIMEZONE written next to an event must give every calendar app the
// same local times as the zone itself, across daylight-saving changes, in every zone this Node knows.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { vtimezone, wallTime, offsetAt, zonedToUtc, validTimeZone } from '../src/timezones.ts';

const pad = (n: number) => String(n).padStart(2, '0');

test('a weekly 09:30 event stays at 09:30 local time for three years, in every zone', () => {
  const wrongZones: string[] = [];
  for (const tz of Intl.supportedValuesOf('timeZone')) {
    const guess = Date.UTC(2026, 0, 5, 9, 30);
    const startMs = guess - offsetAt(tz, guess) * 60_000; // 09:30 local on 5 January 2026
    const w = wallTime(tz, startMs);
    const local = `${w.year}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}00`;
    const data = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', vtimezone(tz, startMs), 'BEGIN:VEVENT', 'UID:t',
      'DTSTAMP:20260101T000000Z', `DTSTART;TZID=${tz}:${local}`, 'RRULE:FREQ=WEEKLY;COUNT=160', 'SUMMARY:t', 'END:VEVENT',
      'END:VCALENDAR', ''].join('\r\n');
    const it = new ICAL.Event(new ICAL.Component(ICAL.parse(data)).getFirstSubcomponent('vevent')).iterator();
    for (let next; (next = it.next());) {
      const at = wallTime(tz, next.toJSDate().getTime());
      if (at.hour !== 9 || at.minute !== 30) {
        wrongZones.push(`${tz} on ${next.toString()}: ${at.hour}:${pad(at.minute)}`);
        break;
      }
    }
  }
  assert.deepEqual(wrongZones, []);
});

test('local times turn into the right instants, also around daylight-saving changes', () => {
  // [zone, local y-m-d h:m:s, expected UTC]
  const cases: [string, number[], string][] = [
    ['Europe/Berlin', [2026, 12, 31, 23, 59, 59], '2026-12-31T22:59:59.000Z'],
    ['Europe/Berlin', [2026, 7, 1, 9, 0, 0], '2026-07-01T07:00:00.000Z'],
    ['Asia/Dubai', [2026, 12, 31, 23, 59, 59], '2026-12-31T19:59:59.000Z'],
    ['America/New_York', [2026, 1, 15, 12, 0, 0], '2026-01-15T17:00:00.000Z'],
    // 02:30 does not exist on the spring-forward day: the result is a real instant one hour later in local terms.
    ['America/Los_Angeles', [2026, 3, 8, 2, 30, 0], '2026-03-08T10:30:00.000Z'],
  ];
  for (const [tz, f, want] of cases) {
    const [y, mo, d, h, mi, s] = f;
    assert.equal(new Date(zonedToUtc(tz, y, mo, d, h, mi, s)).toISOString(), want, `${tz} ${f.join(',')}`);
  }
  // A time that exists twice (autumn) maps to one of its two instants, and back to the same wall time.
  const ms = zonedToUtc('America/Los_Angeles', 2026, 11, 1, 1, 30, 0);
  const back = wallTime('America/Los_Angeles', ms);
  assert.deepEqual([back.hour, back.minute], [1, 30]);
});

test('time zone names are checked', () => {
  assert.equal(validTimeZone('Europe/Berlin'), true);
  assert.equal(validTimeZone('UTC'), true);
  for (const bad of ['', 'Mars/Olympus', 'Europe/Berlin\nX', 42, null, 'x'.repeat(200)]) assert.equal(validTimeZone(bad), false, String(bad));
});
