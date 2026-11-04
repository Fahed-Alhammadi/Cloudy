import ICAL from 'ical.js';
import { createHash, randomUUID } from 'node:crypto';
import { q, one, tx } from './db.ts';
import { HttpError } from './http.ts';


// ---------------------------------------------------------------- recurrence loop guard
// ical.js's RecurIterator.next() searches day by day (or hour, minute…) until the contracting BY* rules match. Rules
// that never match (FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30) make that loop endless inside one synchronous call, which
// freezes the whole server; only MONTHLY/YEARLY have an escape. Each check costs a few µs, so: at most this many
// steps to find one occurrence, and this many for everything one iterator does (a listing, a COUNT walk).
const MAX_STEPS_PER_OCCURRENCE = 50_000;
const MAX_STEPS_PER_ITERATOR = 250_000;

export class RecurrenceTooComplex extends Error {}

{
  const proto = ICAL.RecurIterator.prototype as any;
  const next = proto.next;
  const check = proto.check_contracting_rules;
  proto.next = function (this: any, ...args: unknown[]) {
    this.cloudySteps = 0;
    return next.apply(this, args);
  };
  proto.check_contracting_rules = function (this: any) {
    this.cloudyTotal = (this.cloudyTotal ?? 0) + 1;
    if (++this.cloudySteps > MAX_STEPS_PER_OCCURRENCE || this.cloudyTotal > MAX_STEPS_PER_ITERATOR) {
      throw new RecurrenceTooComplex('This repeat rule never or too rarely produces a date');
    }
    return check.call(this);
  };
}

export interface Kind {
  key: 'cal' | 'card';
  coll: 'calendars' | 'addressbooks';
  objs: 'calendar_objects' | 'cards';
  ext: string;
  contentType: string;
}

export const CAL: Kind = { key: 'cal', coll: 'calendars', objs: 'calendar_objects', ext: '.ics', contentType: 'text/calendar; charset=utf-8' };
export const CARD: Kind = { key: 'card', coll: 'addressbooks', objs: 'cards', ext: '.vcf', contentType: 'text/vcard; charset=utf-8' };

export interface Collection { id: number; owner: string; uri: string; name: string; color: string; ctag: number }
export interface DavObject {
  id: number; collection_id: number; uri: string; uid: string; etag: string; data: string;
  component: string; first_start: Date | null; last_end: Date | null; updated_at: Date;
}

export const URI_RE = /^[A-Za-z0-9@._+=-]{1,200}$/;

// ---------------------------------------------------------------- collections

export async function listCollections(k: Kind, owner: string): Promise<Collection[]> {
  return q<Collection>(`SELECT * FROM ${k.coll} WHERE owner = $1 ORDER BY id`, [owner]);
}

export async function getCollection(k: Kind, owner: string, uri: string): Promise<Collection | undefined> {
  return one<Collection>(`SELECT * FROM ${k.coll} WHERE owner = $1 AND uri = $2`, [owner, uri]);
}

export async function collectionById(k: Kind, owner: string, id: string | number): Promise<Collection> {
  const c = /^\d+$/.test(String(id)) ? await one<Collection>(`SELECT * FROM ${k.coll} WHERE owner = $1 AND id = $2`, [owner, id]) : undefined;
  if (!c) throw new HttpError(404, 'Not found');
  return c;
}

export async function createCollection(k: Kind, owner: string, uri: string, name: string, color = ''): Promise<Collection> {
  if (!URI_RE.test(uri)) throw new HttpError(400, 'Invalid collection name');
  const c = await one<Collection>(
    `INSERT INTO ${k.coll} (owner, uri, name, color) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING *`,
    [owner, uri, name || uri, color || (k.key === 'cal' ? '#0082c9' : '')],
  );
  if (!c) throw new HttpError(409, 'Already exists');
  return c;
}

export async function updateCollection(k: Kind, id: number, f: { name?: string; color?: string }): Promise<void> {
  if (f.name != null) await q(`UPDATE ${k.coll} SET name = $2, ctag = ctag + 1 WHERE id = $1`, [id, f.name]);
  if (f.color != null) await q(`UPDATE ${k.coll} SET color = $2, ctag = ctag + 1 WHERE id = $1`, [id, f.color]);
}

export async function deleteCollection(k: Kind, id: number): Promise<void> {
  await q(`DELETE FROM ${k.coll} WHERE id = $1`, [id]);
  await q(`DELETE FROM dav_changes WHERE kind = $1 AND collection_id = $2`, [k.key, id]);
}

// ---------------------------------------------------------------- objects

export async function listObjects(k: Kind, collId: number, range?: { start?: Date; end?: Date; component?: string }): Promise<DavObject[]> {
  const where = ['collection_id = $1'];
  const params: unknown[] = [collId];
  if (range?.component) {
    params.push(range.component);
    where.push(`component = $${params.length}`);
  }
  if (range?.end) {
    params.push(range.end);
    where.push(`(first_start IS NULL OR first_start < $${params.length})`);
  }
  if (range?.start) {
    params.push(range.start);
    where.push(`(last_end IS NULL OR last_end > $${params.length})`);
  }
  return q<DavObject>(`SELECT * FROM ${k.objs} WHERE ${where.join(' AND ')} ORDER BY uri`, params);
}

export async function getObject(k: Kind, collId: number, uri: string): Promise<DavObject | undefined> {
  return one<DavObject>(`SELECT * FROM ${k.objs} WHERE collection_id = $1 AND uri = $2`, [collId, uri]);
}

/**
 * Parses iCalendar / vCard text into an ical.js component. Embedded VTIMEZONEs are NOT registered in ical.js's
 * process-wide TimezoneService (they used to be): the first user to upload "Europe/Berlin" would have defined it for
 * everyone else's events. ical.js resolves a TZID from the VTIMEZONE in the same object by itself.
 */
export function parseComponent(data: string): ICAL.Component {
  let parsed: any;
  try {
    parsed = ICAL.parse(data);
  } catch (e: any) {
    throw new HttpError(400, `Invalid data: ${e?.message ?? e}`);
  }
  if (Array.isArray(parsed) && Array.isArray(parsed[0])) parsed = parsed[0];
  return new ICAL.Component(parsed);
}

interface Analysis { uid: string; component: string; first_start: Date | null; last_end: Date | null }

function analyze(k: Kind, data: string): Analysis {
  const comp = parseComponent(data);
  if (k.key === 'card') {
    if (comp.name !== 'vcard') throw new HttpError(400, 'Expected a VCARD');
    return { uid: String(comp.getFirstPropertyValue('uid') ?? ''), component: 'VCARD', first_start: null, last_end: null };
  }
  if (comp.name !== 'vcalendar') throw new HttpError(400, 'Expected a VCALENDAR');
  const items = comp.getAllSubcomponents().filter((c) => ['vevent', 'vtodo', 'vjournal'].includes(c.name));
  if (!items.length) throw new HttpError(400, 'No calendar component');
  const master = items.find((c) => !c.hasProperty('recurrence-id')) ?? items[0];
  const out: Analysis = { uid: String(master.getFirstPropertyValue('uid') ?? ''), component: master.name.toUpperCase(), first_start: null, last_end: null };
  if (master.name === 'vevent') {
    const ev = new ICAL.Event(master);
    if (ev.startDate) {
      out.first_start = ev.startDate.toJSDate();
      out.last_end = (ev.endDate ?? ev.startDate).toJSDate();
      if (ev.isRecurring()) {
        const rrule = master.getFirstPropertyValue('rrule') as any;
        const duration = out.last_end.getTime() - out.first_start.getTime();
        out.last_end = null; // unbounded unless UNTIL/COUNT say otherwise
        // A rule that can't find its second date would hang every listing of this calendar: refuse it now.
        // (Other ical.js complaints about a rule keep the old behaviour: stored, shown unbounded.)
        try {
          const probe = ev.iterator();
          probe.next();
          probe.next();
        } catch (e) {
          if (e instanceof RecurrenceTooComplex) throw new HttpError(400, `Invalid data: ${e.message}`);
        }
        if (rrule?.until) {
          out.last_end = new Date(rrule.until.toJSDate().getTime() + duration + 86400000);
        } else if (rrule?.count && rrule.count <= 10000) {
          try {
            const it = ev.iterator();
            let last: Date | null = null;
            for (let i = 0, next; i < rrule.count && (next = it.next()); i++) last = next.toJSDate();
            if (last) out.last_end = new Date(last.getTime() + duration + 86400000);
          } catch {
            out.last_end = null; // too expensive (or unreadable) to walk: treat as unbounded
          }
        }
      }
      // Moved occurrences (RECURRENCE-ID overrides) can lie outside the series: one moved past the last occurrence
      // must still be found by a calendar-query for its new date.
      for (const ex of items) {
        if (ex === master) continue;
        const e = new ICAL.Event(ex);
        if (!e.startDate) continue;
        if (e.startDate.toJSDate() < out.first_start!) out.first_start = e.startDate.toJSDate();
        const end = (e.endDate ?? e.startDate).toJSDate();
        if (out.last_end && end > out.last_end) out.last_end = end;
      }
    }
  }
  return out;
}

async function recordChange(db: any, k: Kind, collId: number, uri: string, deleted: boolean): Promise<void> {
  const { ctag } = (await one<{ ctag: number }>(`UPDATE ${k.coll} SET ctag = ctag + 1 WHERE id = $1 RETURNING ctag`, [collId], db))!;
  await q(`INSERT INTO dav_changes (kind, collection_id, uri, token, deleted) VALUES ($1, $2, $3, $4, $5)`,
    [k.key, collId, uri, ctag, deleted], db);
}

export async function putObject(
  k: Kind,
  coll: Collection,
  uri: string,
  data: string,
  cond: { ifMatch?: string; ifNoneMatch?: string } = {},
): Promise<{ obj: DavObject; created: boolean }> {
  if (!URI_RE.test(uri)) throw new HttpError(400, 'Invalid resource name');
  let a: Analysis;
  try {
    a = analyze(k, data);
  } catch (e: any) {
    // ical.js throws plain errors for data it parsed but can't evaluate (bad DTSTART, RRULE…): the client's fault.
    throw e instanceof HttpError ? e : new HttpError(400, `Invalid data: ${e?.message ?? e}`);
  }
  const etag = createHash('md5').update(data).digest('hex');
  return tx(async (db) => {
    const existing = await one<DavObject>(`SELECT * FROM ${k.objs} WHERE collection_id = $1 AND uri = $2 FOR UPDATE`, [coll.id, uri], db);
    if (cond.ifNoneMatch === '*' && existing) throw new HttpError(412, 'Already exists');
    if (cond.ifMatch && (!existing || (cond.ifMatch !== '*' && cond.ifMatch.replace(/"/g, '') !== existing.etag))) {
      throw new HttpError(412, 'ETag mismatch');
    }
    if (!existing && a.uid) {
      const dup = await one(`SELECT 1 FROM ${k.objs} WHERE collection_id = $1 AND uid = $2`, [coll.id, a.uid], db);
      if (dup) throw new HttpError(409, 'An object with this UID already exists');
    }
    const obj = (await one<DavObject>(
      `INSERT INTO ${k.objs} (collection_id, uri, uid, etag, data, component, first_start, last_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (collection_id, uri) DO UPDATE SET uid = $3, etag = $4, data = $5, component = $6,
         first_start = $7, last_end = $8, updated_at = now()
       RETURNING *`,
      [coll.id, uri, a.uid, etag, data, a.component, a.first_start, a.last_end],
      db,
    ))!;
    await recordChange(db, k, coll.id, uri, false);
    return { obj, created: !existing };
  });
}

export async function deleteObject(k: Kind, coll: Collection, uri: string, ifMatch?: string): Promise<boolean> {
  return tx(async (db) => {
    const existing = await one<DavObject>(`SELECT * FROM ${k.objs} WHERE collection_id = $1 AND uri = $2 FOR UPDATE`, [coll.id, uri], db);
    if (!existing) return false;
    if (ifMatch && ifMatch !== '*' && ifMatch.replace(/"/g, '') !== existing.etag) throw new HttpError(412, 'ETag mismatch');
    await q(`DELETE FROM ${k.objs} WHERE id = $1`, [existing.id], db);
    await recordChange(db, k, coll.id, uri, true);
    return true;
  });
}

/** RFC 6578 changes after `token`; null when the token is unknown. */
export async function changesSince(k: Kind, coll: Collection, token: number): Promise<{ uri: string; deleted: boolean }[] | null> {
  if (!Number.isSafeInteger(token) || token < 0 || token > coll.ctag) return null;
  return q(
    `SELECT DISTINCT ON (uri) uri, deleted FROM dav_changes
      WHERE kind = $1 AND collection_id = $2 AND token > $3 ORDER BY uri, token DESC`,
    [k.key, coll.id, token],
  );
}

export const newUri = (k: Kind) => randomUUID() + k.ext;
