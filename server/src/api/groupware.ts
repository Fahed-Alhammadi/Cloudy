import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import type { Router, Ctx } from '../http.ts';
import { json, noContent, readJson, readBuffer, HttpError } from '../http.ts';
import type { User } from '../auth.ts';
import * as G from '../groupware.ts';
import { parseContactsFile } from '../contacts-import.ts';
import { contentDisposition } from '../download.ts';
import type { Kind, DavObject } from '../groupware.ts';
import { validTimeZone, canonicalTimeZone, vtimezone, wallTime } from '../timezones.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;
type Wrap = (h: Authed) => (ctx: Ctx) => Promise<void>;
type Comp = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

const collJson = (c: G.Collection) => ({ id: c.id, uri: c.uri, name: c.name, color: c.color });

const slug = (name: string) =>
  (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list').slice(0, 40) + '-' + randomUUID().slice(0, 6);

function timeOut(t: Time): string {
  return t.isDate ? t.toString() : t.toJSDate().toISOString();
}

function timeIn(value: unknown, allDay: boolean): Time {
  const s = String(value ?? '');
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new HttpError(400, 'All-day dates must be YYYY-MM-DD');
    return ICAL.Time.fromDateString(s.slice(0, 10));
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid date/time');
  return ICAL.Time.fromJSDate(d, true);
}

/** Control characters other than tab and line breaks: invisible, and not valid in the XML that DAV clients read. */
const cleanText = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe\uffff]/g, '').trim();

/** A value written anew is plain text: a vCard 2.1 encoding or charset left on it would make it unreadable. */
function plain(prop: ICAL.Property | null) {
  prop?.removeParameter('encoding');
  prop?.removeParameter('charset');
}

function setText(comp: Comp, name: string, value: unknown) {
  comp.removeAllProperties(name);
  if (typeof value === 'string' && cleanText(value)) comp.addPropertyWithValue(name, cleanText(value));
}

// ---------------------------------------------------------------- events

interface EventOut {
  calendarId: number; uri: string; uid: string; summary: string; location: string; description: string;
  start: string; end: string; allDay: boolean; recurring: boolean; rrule: string;
  masterStart: string; masterEnd: string;
}

function expand(calendarId: number, obj: DavObject, from: Date, to: Date): EventOut[] {
  const vcal = G.parseComponent(obj.data);
  const vevents = vcal.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id'));
  // Only changed occurrences of a series kept elsewhere (an invitation to one meeting of a series): each is an event
  // of its own here (they were not shown at all).
  if (!master) return vevents.flatMap((v) => expandSingle(calendarId, obj, v, from, to));
  const ev = new ICAL.Event(master, { exceptions: vevents.filter((v) => v !== master) });
  if (!ev.startDate) return [];
  const endOf = (s: Time, e: Time | null) => e ?? (s.isDate ? (() => { const x = s.clone(); x.day += 1; return x; })() : s);
  const rrule = master.getFirstPropertyValue('rrule') as any;
  const base = {
    calendarId, uri: obj.uri, uid: ev.uid ?? '', location: ev.location ?? '', description: ev.description ?? '',
    allDay: ev.startDate.isDate, recurring: ev.isRecurring(), rrule: rrule?.freq ?? '',
    masterStart: timeOut(ev.startDate), masterEnd: timeOut(endOf(ev.startDate, ev.endDate)),
  };
  const out: EventOut[] = [];
  if (!ev.isRecurring()) {
    const end = endOf(ev.startDate, ev.endDate);
    if (ev.startDate.toJSDate() < to && end.toJSDate() > from) {
      out.push({ ...base, summary: ev.summary ?? '', start: timeOut(ev.startDate), end: timeOut(end) });
    }
    return out;
  }
  try {
    const it = ev.iterator(); // primes the first dates already, so inside the guard
    for (let i = 0, next: Time | null; i < 20000 && (next = it.next()); i++) {
      if (next.toJSDate() >= to) break;
      const occ = ev.getOccurrenceDetails(next);
      const end = endOf(occ.startDate, occ.endDate);
      if (end.toJSDate() <= from) continue;
      out.push({ ...base, summary: occ.item.summary ?? '', start: timeOut(occ.startDate), end: timeOut(end) });
      if (out.length > 1000) break;
    }
  } catch (e) {
    // A stored rule that needs too much searching (G.RecurrenceTooComplex): show what was found, keep the listing.
    if (!(e instanceof G.RecurrenceTooComplex)) throw e;
  }
  return out;
}

/** One VEVENT without a series of its own (a changed occurrence whose series is not here). */
function expandSingle(calendarId: number, obj: DavObject, v: Comp, from: Date, to: Date): EventOut[] {
  const ev = new ICAL.Event(v);
  if (!ev.startDate) return [];
  const end = ev.endDate ?? (ev.startDate.isDate ? (() => { const x = ev.startDate.clone(); x.day += 1; return x; })() : ev.startDate);
  if (!(ev.startDate.toJSDate() < to && end.toJSDate() > from)) return [];
  const start = timeOut(ev.startDate);
  return [{
    calendarId, uri: obj.uri, uid: ev.uid ?? '', summary: ev.summary ?? '', location: ev.location ?? '', description: ev.description ?? '',
    start, end: timeOut(end), allDay: ev.startDate.isDate, recurring: false, rrule: '', masterStart: start, masterEnd: timeOut(end),
  }];
}

const FREQS = ['', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** Now, in UTC (DTSTAMP and LAST-MODIFIED must be UTC; ICAL.Time.now() is a floating local time). */
const utcNow = () => ICAL.Time.fromJSDate(new Date(), true);

/**
 * The time `ms` in the zone `tzid`, using the VTIMEZONE in this calendar object (one is added for an IANA zone the
 * object does not have yet). null when the zone is unknown and cannot be described.
 */
function timeInZone(vcal: Comp, tzid: string, ms: number): Time | null {
  let comp = vcal.getAllSubcomponents('vtimezone').find((c) => c.getFirstPropertyValue('tzid') === tzid);
  if (!comp) {
    if (!validTimeZone(tzid)) return null;
    comp = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${vtimezone(tzid, ms)}\r\nEND:VCALENDAR\r\n`)).getFirstSubcomponent('vtimezone')!;
    // Before the events that use it: the order is free in the standard, but some programs read top to bottom.
    const rest = vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone');
    for (const c of rest) vcal.removeSubcomponent(c);
    vcal.addSubcomponent(comp);
    for (const c of rest) vcal.addSubcomponent(c);
  }
  const zone = new ICAL.Timezone(comp);
  const at = (f: { year: number; month: number; day: number; hour: number; minute: number; second: number }) =>
    new ICAL.Time({ year: f.year, month: f.month, day: f.day, hour: f.hour, minute: f.minute, second: f.second, isDate: false }, zone);
  // The zone's wall clock at that instant. ical.js's convertToZone picks the offset by reading the UTC time as if it
  // were local, so within a few hours of a clock change (a Saturday evening in America, a Sunday morning in Australia)
  // events were stored an hour off.
  if (validTimeZone(tzid)) return at(wallTime(tzid, ms));
  // A zone known only from the object's own VTIMEZONE (e.g. Outlook's names): the offsets in force a day before and a
  // day after (at most one clock change lies between), and the local time that one of them maps back to this very
  // instant. The second pass of a repeated hour cannot be written with a zone name (RFC 5545 reads its first one).
  const localWith = (offsetSec: number) => {
    const d = new Date(ms + offsetSec * 1000);
    return at({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() });
  };
  const offsetNear = (deltaMs: number) => zone.utcOffset(ICAL.Time.fromJSDate(new Date(ms + deltaMs), true).convertToZone(zone));
  const offsets = [...new Set([offsetNear(-86_400_000), offsetNear(86_400_000)])];
  const sec = Math.floor(ms / 1000);
  const tries = offsets.map((o) => localWith(o));
  const exact = tries.find((t) => t.toUnixTime() === sec);
  if (exact) return exact;
  // The first pass of the hour that repeats when the clocks go back, which ical.js reads as the second pass: the clock
  // showed it with the earlier offset, and that is how RFC 5545 readers take it.
  if (tries.length === 2 && offsets[0] > offsets[1] && tries[0].toUnixTime() === sec + (offsets[0] - offsets[1])) return tries[0];
  return tries[tries.length - 1];
}

function setTime(vevent: Comp, name: string, time: Time, tzid: string | null): void {
  vevent.removeAllProperties(name);
  const p = new ICAL.Property(name, vevent);
  p.setValue(time);
  if (tzid) p.setParameter('tzid', tzid);
  vevent.addProperty(p);
}

/**
 * Applies the editor's fields to an event. Timed events are written in a time zone, so a repeating event keeps its
 * local time when the clocks change (they were stored in UTC, and a weekly 09:00 meeting became 10:00): the zone the
 * event already has, else the one the client sends (`tz`), else the account's. Times that did not change are left
 * exactly as stored (an edit of the title used to rewrite a phone's series in UTC).
 */
function applyEvent(vcal: Comp, vevent: Comp, b: any, accountTz: string | null) {
  if (!String(b.summary ?? '').trim()) throw new HttpError(400, 'Title required');
  const allDay = !!b.allDay;
  const start = timeIn(b.start, allDay);
  const end = timeIn(b.end ?? b.start, allDay);
  if (end.compare(start) < 0) throw new HttpError(400, 'End is before start');
  if (allDay && end.compare(start) === 0) end.day += 1;
  setText(vevent, 'summary', b.summary);
  setText(vevent, 'location', b.location);
  setText(vevent, 'description', b.description);
  const stored = (name: string) => vevent.getFirstPropertyValue(name) as Time | null;
  const oldStart = stored('dtstart');
  const oldEnd = stored('dtend');
  const unchanged = (old: Time | null, t: Time) => !!old && old.isDate === t.isDate && (t.isDate
    ? old.toString() === t.toString()
    : old.toJSDate().getTime() === t.toJSDate().getTime());
  const keepStart = unchanged(oldStart, start);
  const keepEnd = unchanged(oldEnd, end) && !vevent.hasProperty('duration');
  if (!(keepStart && keepEnd)) {
    vevent.removeAllProperties('duration');
    if (allDay) {
      if (!keepStart) setTime(vevent, 'dtstart', start, null);
      if (!keepEnd) setTime(vevent, 'dtend', end, null);
    } else {
      const storedTz = vevent.getFirstProperty('dtstart')?.getParameter('tzid');
      const tzid = (typeof storedTz === 'string' && storedTz) || canonicalTimeZone(b.tz) || canonicalTimeZone(accountTz);
      const zoned = (t: Time) => (tzid ? timeInZone(vcal, tzid, t.toJSDate().getTime()) : null);
      const zs = keepStart ? null : zoned(start);
      const ze = keepEnd ? null : zoned(end);
      if (!keepStart) setTime(vevent, 'dtstart', zs ?? start, zs ? tzid : null);
      if (!keepEnd) setTime(vevent, 'dtend', ze ?? end, ze ? tzid : null);
    }
  }
  const freq = String(b.rrule ?? '').toUpperCase();
  if (!FREQS.includes(freq)) throw new HttpError(400, 'Invalid repeat');
  const current = vevent.getFirstPropertyValue('rrule') as any;
  if (!freq) vevent.removeAllProperties('rrule');
  else if (current?.freq !== freq) {
    vevent.removeAllProperties('rrule');
    vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(`FREQ=${freq}`));
  }
  const now = utcNow();
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  vevent.updatePropertyWithValue('sequence', Number(vevent.getFirstPropertyValue('sequence') ?? 0) + 1);
}

// ---------------------------------------------------------------- contacts

function contactOut(obj: DavObject) {
  const v = G.parseComponent(obj.data);
  const n = v.getFirstPropertyValue('n') as any;
  const nParts = Array.isArray(n) ? n : typeof n === 'string' ? n.split(';') : [];
  const adr = v.getFirstPropertyValue('adr') as any;
  const adrParts = Array.isArray(adr) ? adr : typeof adr === 'string' ? adr.split(';') : [];
  const org = v.getFirstPropertyValue('org') as any;
  return {
    uri: obj.uri,
    uid: String(v.getFirstPropertyValue('uid') ?? ''),
    fn: String(v.getFirstPropertyValue('fn') ?? ''),
    givenName: String(nParts[1] ?? ''),
    familyName: String(nParts[0] ?? ''),
    emails: v.getAllProperties('email').map((p) => String(p.getFirstValue())),
    phones: v.getAllProperties('tel').map((p) => telText(p.getFirstValue())),
    org: String(Array.isArray(org) ? org[0] : org ?? ''),
    title: String(v.getFirstPropertyValue('title') ?? ''),
    address: adrParts.flat().filter(Boolean).join(', '),
    birthday: String(v.getFirstPropertyValue('bday') ?? ''),
    note: String(v.getFirstPropertyValue('note') ?? ''),
  };
}

/** Same person: same name plus a shared email or phone (phone compared by digits). */
function dupKeys(c: { fn: string; emails: string[]; phones: string[] }): string[] {
  const name = c.fn.trim().toLowerCase();
  const keys = [
    ...c.emails.map((e) => `${name}|e|${e.trim().toLowerCase()}`),
    ...c.phones.map((p) => p.replace(/\D/g, '')).filter((d) => d.length >= 5).map((d) => `${name}|p|${d.slice(-9)}`),
  ];
  // Only a name (no email, no phone): the name alone (re-importing the same file used to duplicate these).
  return keys.length ? keys : [`${name}|n`];
}

/** A TEL value as people read it: vCard 4 writes numbers as "tel:" URIs. */
const telText = (v: unknown) => String(v ?? '').replace(/^tel:/i, '');

/**
 * Applies the editor's fields to a vCard. The editors (web and apps) show a simple form; everything they do not show
 * is kept: a field whose value comes back unchanged is not touched, a phone number or email still in the list keeps
 * its label (mobile, work…) and group, and only the first address and the first part of the organisation are edited.
 * Every save used to rebuild these fields from the form, so fixing a typo stripped labels, middle names, departments
 * and second addresses on every synced phone.
 */
function applyContact(v: Comp, b: any) {
  const shown = contactOut({ uri: '', data: v.toString() } as DavObject);
  const text = (x: unknown) => String(x ?? '').trim();
  const given = text(b.givenName);
  const family = text(b.familyName);
  const emails = (Array.isArray(b.emails) ? b.emails : []).map(text).filter(Boolean);
  const phones = (Array.isArray(b.phones) ? b.phones : []).map(text).filter(Boolean);
  // The display name: a name, else the company, else the first email or phone number (a contact may have only those).
  // One that was chosen (a "Dr. Anna Maria Meier", a "Mom") stays while the name and company stay: the web and the
  // apps send no display name, and it used to be rebuilt from the name parts at every save.
  // Several given names ("Anna,Maria") read with spaces: "Anna Maria Meier".
  const words = (part: string) => part.split(',').map((x) => x.trim()).filter(Boolean).join(' ');
  const derive = (c: { givenName: string; familyName: string; org: string; emails: string[]; phones: string[] }) =>
    [words(c.givenName), words(c.familyName)].filter(Boolean).join(' ') || c.org || c.emails[0] || c.phones[0] || '';
  const nameChanged = given !== shown.givenName || family !== shown.familyName || text(b.org) !== shown.org;
  const chosen = !!shown.fn && shown.fn !== derive(shown) && !nameChanged;
  const fn = text(b.fn) || (chosen ? shown.fn : derive({ givenName: given, familyName: family, org: text(b.org), emails, phones }));
  if (!fn) throw new HttpError(400, 'Name required');
  if (fn !== shown.fn) { v.updatePropertyWithValue('fn', fn); plain(v.getFirstProperty('fn')); }
  if (given !== shown.givenName || family !== shown.familyName || !v.hasProperty('n')) {
    const old = v.getFirstPropertyValue('n') as any;
    const parts = Array.isArray(old) ? [...old] : typeof old === 'string' ? old.split(';') : [];
    while (parts.length < 5) parts.push('');
    // Only the part that changed: several given names ("Jean,Paul") were written back as one, middle names,
    // prefixes and suffixes stay.
    if (family !== shown.familyName || !v.hasProperty('n')) parts[0] = family;
    if (given !== shown.givenName || !v.hasProperty('n')) parts[1] = given;
    const prop = v.getFirstProperty('n') ?? (() => { const n = new ICAL.Property('n', v); v.addProperty(n); return n; })();
    prop.setValue(parts as any);
    plain(prop);
  }
  // Lists: properties whose value is still there stay as they are (with their labels); removed values go, with the
  // label of their group (item1.TEL + item1.X-ABLABEL); new values are added plainly.
  // Counted, not just looked up: one number as home and as work is two entries (the second was removed).
  const syncList = (name: 'email' | 'tel', wanted: string[], read: (p: any) => string) => {
    const left = new Map<string, number>();
    for (const value of wanted) left.set(value, (left.get(value) ?? 0) + 1);
    for (const prop of v.getAllProperties(name)) {
      const value = read(prop.getFirstValue());
      const n = left.get(value) ?? 0;
      if (n > 0) { left.set(value, n - 1); continue; }
      const group = prop.getParameter('group');
      v.removeProperty(prop);
      if (group) for (const other of v.getAllProperties()) if (other.getParameter('group') === group && !['email', 'tel'].includes(other.name)) v.removeProperty(other);
    }
    for (const [value, n] of left) for (let i = 0; i < n; i++) v.addPropertyWithValue(name, value);
  };
  syncList('email', emails, (x) => String(x ?? '').trim());
  syncList('tel', phones, (x) => telText(x).trim());
  if (text(b.title) !== shown.title) setText(v, 'title', b.title);
  if (text(b.note) !== shown.note.trim()) setText(v, 'note', b.note);
  const org = text(b.org);
  if (org !== shown.org) {
    const prop = v.getFirstProperty('org');
    if (!org) v.removeAllProperties('org');
    else if (prop) {
      const old = prop.getFirstValue() as any;
      const units = Array.isArray(old) ? old.slice(1) : []; // the department and other units stay
      prop.setValue([org, ...units] as any);
      plain(prop);
    } else {
      const p2 = new ICAL.Property('org', v);
      p2.setValue([org] as any);
      v.addProperty(p2);
    }
  }
  const address = text(b.address);
  if (address !== shown.address) {
    // The form shows the first address as one line: only that one is replaced (its label stays); others stay too.
    const first = v.getFirstProperty('adr');
    if (!address) { if (first) v.removeProperty(first); }
    else if (first) {
      first.setValue(['', '', address, '', '', '', ''] as any);
      first.removeParameter('label'); // vCard 4's printed form of the old address
      plain(first);
    }
    else {
      const p2 = new ICAL.Property('adr', v);
      p2.setValue(['', '', address, '', '', '', ''] as any);
      v.addProperty(p2);
    }
  }
  // Birthday: YYYY-MM-DD, or --MM-DD (no year, as phones store it). A value the client sends back unchanged (what
  // contactOut showed it, e.g. a date-time from another CardDAV client) or doesn't send at all stays as it is: the
  // apps' editors only know YYYY-MM-DD, and every save used to erase other forms.
  const bday = String(b.birthday ?? '').trim();
  const stored = String(v.getFirstPropertyValue('bday') ?? '');
  if (b.birthday !== undefined && !(bday && bday === stored)) {
    v.removeAllProperties('bday');
    if (/^\d{4}-\d{2}-\d{2}$/.test(bday)) v.addPropertyWithValue('bday', ICAL.Time.fromDateString(bday));
    else if (/^--\d{2}-\d{2}$/.test(bday)) v.addPropertyWithValue('bday', ICAL.VCardTime.fromDateAndOrTimeString(bday, 'date'));
  }
  // REV as a UTC timestamp, valid in vCard 3 and 4 (it was written in local time, and as VALUE=DATE-TIME in vCard 4).
  v.removeAllProperties('rev');
  const version = String(v.getFirstPropertyValue('version') ?? '3.0');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  v.addProperty(ICAL.Property.fromString(`REV:${stamp}`, version.startsWith('4') ? ICAL.design.vcard : ICAL.design.vcard3));
}

// ---------------------------------------------------------------- routes

export function registerGroupware(r: Router, authed: Wrap) {
  for (const [k, path] of [[G.CAL, 'calendars'], [G.CARD, 'addressbooks']] as [Kind, string][]) {
    r.get(`/api/${path}`, authed(async ({ res }, user) => json(res, (await G.listCollections(k, user.id)).map(collJson))));

    r.post(`/api/${path}`, authed(async ({ req, res }, user) => {
      const b = await readJson(req);
      const name = String(b.name ?? '').trim();
      if (!name) throw new HttpError(400, 'Name required');
      json(res, collJson(await G.createCollection(k, user.id, slug(name), name, b.color)), 201);
    }));

    r.patch(`/api/${path}/:id`, authed(async ({ req, res, params }, user) => {
      const c = await G.collectionById(k, user.id, params.id);
      const b = await readJson(req);
      await G.updateCollection(k, c.id, {
        name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined,
        color: typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : undefined,
      });
      noContent(res);
    }));

    r.delete(`/api/${path}/:id`, authed(async ({ res, params }, user) => {
      await G.deleteCollection(k, (await G.collectionById(k, user.id, params.id)).id);
      noContent(res);
    }));
  }

  // Events in a time window (recurrences expanded).
  r.get('/api/calendars/:id/events', authed(async ({ res, params, url }, user) => {
    const c = await G.collectionById(G.CAL, user.id, params.id);
    const from = new Date(url.searchParams.get('start') ?? '');
    const to = new Date(url.searchParams.get('end') ?? '');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, 'start and end required');
    const out: EventOut[] = [];
    for (const o of await G.listObjects(G.CAL, c.id, { start: from, end: to, component: 'VEVENT' })) {
      try {
        out.push(...expand(c.id, o, from, to));
      } catch {
        /* skip unparsable objects */
      }
    }
    json(res, out);
  }));

  r.post('/api/calendars/:id/events', authed(async ({ req, res, params }, user) => {
    const c = await G.collectionById(G.CAL, user.id, params.id);
    const vcal = G.parseComponent('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Cloudy//EN\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    const vevent = vcal.getFirstSubcomponent('vevent')!;
    const uid = randomUUID();
    vevent.addPropertyWithValue('uid', uid);
    applyEvent(vcal, vevent, await readJson(req), user.timezone ?? null);
    const { obj } = await G.putObject(G.CAL, c, `${uid}.ics`, vcal.toString() + '\r\n', { ifNoneMatch: '*' });
    json(res, { uri: obj.uri }, 201);
  }));

  r.put('/api/calendars/:id/events/:uri', authed(async ({ req, res, params }, user) => {
    const c = await G.collectionById(G.CAL, user.id, params.id);
    const obj = await G.getObject(G.CAL, c.id, params.uri);
    if (!obj) throw new HttpError(404, 'Event not found');
    const vcal = G.parseComponent(obj.data);
    const vevent = vcal.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'));
    if (!vevent) throw new HttpError(400, 'Not an event');
    applyEvent(vcal, vevent, await readJson(req), user.timezone ?? null);
    await G.putObject(G.CAL, c, obj.uri, vcal.toString() + '\r\n', { ifMatch: obj.etag });
    noContent(res);
  }));

  r.delete('/api/calendars/:id/events/:uri', authed(async ({ res, params }, user) => {
    const c = await G.collectionById(G.CAL, user.id, params.id);
    if (!(await G.deleteObject(G.CAL, c, params.uri))) throw new HttpError(404, 'Event not found');
    noContent(res);
  }));

  r.get('/api/addressbooks/:id/contacts', authed(async ({ res, params }, user) => {
    const c = await G.collectionById(G.CARD, user.id, params.id);
    const out = [];
    for (const o of await G.listObjects(G.CARD, c.id)) {
      try {
        out.push(contactOut(o));
      } catch {
        /* skip unparsable cards */
      }
    }
    out.sort((a, b) => a.fn.localeCompare(b.fn));
    json(res, out);
  }));

  r.post('/api/addressbooks/:id/contacts', authed(async ({ req, res, params }, user) => {
    const c = await G.collectionById(G.CARD, user.id, params.id);
    const v = G.parseComponent('BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n');
    const uid = randomUUID();
    v.addPropertyWithValue('uid', uid);
    applyContact(v, await readJson(req));
    const { obj } = await G.putObject(G.CARD, c, `${uid}.vcf`, v.toString() + '\r\n', { ifNoneMatch: '*' });
    json(res, contactOut(obj), 201);
  }));

  r.put('/api/addressbooks/:id/contacts/:uri', authed(async ({ req, res, params }, user) => {
    const c = await G.collectionById(G.CARD, user.id, params.id);
    const obj = await G.getObject(G.CARD, c.id, params.uri);
    if (!obj) throw new HttpError(404, 'Contact not found');
    const v = G.parseComponent(obj.data);
    applyContact(v, await readJson(req));
    const { obj: saved } = await G.putObject(G.CARD, c, obj.uri, v.toString() + '\r\n', { ifMatch: obj.etag });
    json(res, contactOut(saved));
  }));

  r.delete('/api/addressbooks/:id/contacts/:uri', authed(async ({ res, params }, user) => {
    const c = await G.collectionById(G.CARD, user.id, params.id);
    if (!(await G.deleteObject(G.CARD, c, params.uri))) throw new HttpError(404, 'Contact not found');
    noContent(res);
  }));

  // Import a .vcf (one or many cards, vCard 2.1–4.0) or a CSV export (Google, Outlook, simple sheets).
  // A card whose UID is already in the address book replaces it; a contact with the same name and a
  // shared email or phone as an existing one is skipped, so importing the same file twice is harmless.
  r.post('/api/addressbooks/:id/import', authed(async ({ req, res, params }, user) => {
    const c = await G.collectionById(G.CARD, user.id, params.id);
    let parsed;
    try {
      parsed = parseContactsFile(await readBuffer(req, 20 * 1024 * 1024));
    } catch (e: any) {
      throw e instanceof HttpError ? e : new HttpError(400, e.message);
    }
    const existing = await G.listObjects(G.CARD, c.id);
    const byUid = new Map(existing.filter((o) => o.uid).map((o) => [o.uid, o]));
    const seen = new Set<string>();
    const remember = (k: ReturnType<typeof contactOut>) => dupKeys(k).forEach((x) => seen.add(x));
    for (const o of existing) { try { remember(contactOut(o)); } catch { /* unparsable */ } }

    const result = { format: parsed.format, imported: 0, updated: 0, duplicates: 0, skipped: parsed.skipped, errors: parsed.errors };
    const cards = [...parsed.vcards];
    for (const fields of parsed.contacts) {
      try {
        const v = G.parseComponent('BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n');
        v.addPropertyWithValue('uid', randomUUID());
        applyContact(v, fields);
        cards.push(v.toString() + '\r\n');
      } catch (e: any) {
        result.skipped++;
        if (result.errors.length < 10) result.errors.push(e.message);
      }
    }
    for (const data of cards) {
      try {
        const uid = String(G.parseComponent(data).getFirstPropertyValue('uid') ?? '');
        const prev = uid ? byUid.get(uid) : undefined;
        if (prev) {
          await G.putObject(G.CARD, c, prev.uri, data);
          result.updated++;
          continue;
        }
        const out = contactOut({ data, uri: '' } as any);
        if (dupKeys(out).some((k) => seen.has(k))) { result.duplicates++; continue; }
        const { obj } = await G.putObject(G.CARD, c, G.newUri(G.CARD), data, { ifNoneMatch: '*' });
        byUid.set(obj.uid, obj);
        remember(out);
        result.imported++;
      } catch (e: any) {
        result.skipped++;
        if (result.errors.length < 10) result.errors.push(e.message);
      }
    }
    json(res, result);
  }));

  // All contacts of an address book as one .vcf file.
  r.get('/api/addressbooks/:id/export', authed(async ({ res, params }, user) => {
    const c = await G.collectionById(G.CARD, user.id, params.id);
    const body = (await G.listObjects(G.CARD, c.id)).map((o) => o.data.trimEnd() + '\r\n').join('');
    res.writeHead(200, {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': contentDisposition('attachment', `${c.name || 'Contacts'}.vcf`),
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }));
}
