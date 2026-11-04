import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import type { Router, Ctx } from '../http.ts';
import { json, noContent, readJson, readBuffer, HttpError } from '../http.ts';
import type { User } from '../auth.ts';
import * as G from '../groupware.ts';
import { parseContactsFile } from '../contacts-import.ts';
import { contentDisposition } from '../download.ts';
import type { Kind, DavObject } from '../groupware.ts';

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

function setText(comp: Comp, name: string, value: unknown) {
  comp.removeAllProperties(name);
  if (typeof value === 'string' && value.trim()) comp.addPropertyWithValue(name, value.trim());
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
  if (!master) return [];
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

const FREQS = ['', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

function applyEvent(vevent: Comp, b: any) {
  if (!String(b.summary ?? '').trim()) throw new HttpError(400, 'Title required');
  const allDay = !!b.allDay;
  const start = timeIn(b.start, allDay);
  const end = timeIn(b.end ?? b.start, allDay);
  if (end.compare(start) < 0) throw new HttpError(400, 'End is before start');
  if (allDay && end.compare(start) === 0) end.day += 1;
  setText(vevent, 'summary', b.summary);
  setText(vevent, 'location', b.location);
  setText(vevent, 'description', b.description);
  for (const p of ['dtstart', 'dtend', 'duration']) vevent.removeAllProperties(p);
  vevent.addPropertyWithValue('dtstart', start);
  vevent.addPropertyWithValue('dtend', end);
  const freq = String(b.rrule ?? '').toUpperCase();
  if (!FREQS.includes(freq)) throw new HttpError(400, 'Invalid repeat');
  const current = vevent.getFirstPropertyValue('rrule') as any;
  if (!freq) vevent.removeAllProperties('rrule');
  else if (current?.freq !== freq) {
    vevent.removeAllProperties('rrule');
    vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(`FREQ=${freq}`));
  }
  const now = ICAL.Time.now();
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
    phones: v.getAllProperties('tel').map((p) => String(p.getFirstValue())),
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
  return [
    ...c.emails.map((e) => `${name}|e|${e.trim().toLowerCase()}`),
    ...c.phones.map((p) => p.replace(/\D/g, '')).filter((d) => d.length >= 5).map((d) => `${name}|p|${d.slice(-9)}`),
  ];
}

function applyContact(v: Comp, b: any) {
  const given = String(b.givenName ?? '').trim();
  const family = String(b.familyName ?? '').trim();
  const fn = String(b.fn ?? '').trim() || [given, family].filter(Boolean).join(' ') || String(b.org ?? '').trim();
  if (!fn) throw new HttpError(400, 'Name required');
  v.updatePropertyWithValue('fn', fn);
  v.removeAllProperties('n');
  const nProp = new ICAL.Property('n', v);
  nProp.setValue([family, given, '', '', ''] as any);
  v.addProperty(nProp);
  v.removeAllProperties('email');
  for (const e of (Array.isArray(b.emails) ? b.emails : []).map(String).filter((s: string) => s.trim())) v.addPropertyWithValue('email', e.trim());
  v.removeAllProperties('tel');
  for (const t of (Array.isArray(b.phones) ? b.phones : []).map(String).filter((s: string) => s.trim())) v.addPropertyWithValue('tel', t.trim());
  setText(v, 'title', b.title);
  setText(v, 'note', b.note);
  v.removeAllProperties('org');
  if (String(b.org ?? '').trim()) {
    const p = new ICAL.Property('org', v);
    p.setValue([String(b.org).trim()] as any);
    v.addProperty(p);
  }
  v.removeAllProperties('adr');
  if (String(b.address ?? '').trim()) {
    const p = new ICAL.Property('adr', v);
    p.setValue(['', '', String(b.address).trim(), '', '', '', ''] as any);
    v.addProperty(p);
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
  v.updatePropertyWithValue('rev', ICAL.Time.now());
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
    applyEvent(vevent, await readJson(req));
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
    applyEvent(vevent, await readJson(req));
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
    const body = (await G.listObjects(G.CARD, c.id)).map((o) => o.data.replace(/\s*$/, '\r\n')).join('');
    res.writeHead(200, {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': contentDisposition('attachment', `${c.name || 'Contacts'}.vcf`),
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }));
}
