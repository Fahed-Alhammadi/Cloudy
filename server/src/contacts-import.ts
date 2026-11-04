// Contact import: vCard files (2.1, 3.0, 4.0 — one or many cards per file) and CSV exports (Google Contacts,
// Outlook, or any sheet with name/email/phone columns). vCard 2.1 as written by older phones and Outlook is
// normalized to 3.0 first (quoted-printable, CHARSET, bare TYPE parameters), since ical.js only reads 3.0/4.0.
import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';

/** Same shape as the JSON API's contact body (see applyContact in api/groupware.ts). */
export interface ContactFields {
  fn?: string;
  givenName?: string;
  familyName?: string;
  emails: string[];
  phones: string[];
  org?: string;
  title?: string;
  address?: string;
  birthday?: string;
  note?: string;
}

export interface ParsedFile {
  format: 'vcard' | 'csv';
  /** Normalized vCard texts, each with UID and FN. */
  vcards: string[];
  /** CSV rows, turned into vCards by the caller. */
  contacts: ContactFields[];
  skipped: number;
  errors: string[];
}

export const MAX_CONTACTS = 20_000;

// ---------------------------------------------------------------- text decoding

/** UTF-8 (with or without BOM), UTF-16 with BOM, otherwise Windows-1252 (old Outlook/Excel exports). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function decodeCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
    }
  }
  return decodeCharset(Buffer.from(bytes), charset);
}

// ---------------------------------------------------------------- vCard

const BINARY_PROPS = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY']);
const TEXT_ESCAPED = new Set(['FN', 'NOTE', 'TITLE', 'ROLE', 'NICKNAME', 'CATEGORIES']);
const MAX_LINE = 512 * 1024; // drop huge embedded photos

/** Splits a property line at the first ':' that isn't inside a quoted parameter value. */
function splitProp(line: string): [string, string] | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

/** Turns one BEGIN:VCARD…END:VCARD block (raw lines) into clean vCard 3.0/4.0 text, or throws. */
function normalizeCard(raw: string[]): string {
  // 1. Join folded lines and quoted-printable soft line breaks.
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    if (!line.trim()) continue;
    const isQP = /;(ENCODING=)?QUOTED-PRINTABLE[;:]/i.test(line.slice(0, (splitProp(line)?.[0].length ?? 0) + 1));
    if (isQP && line.endsWith('=') && i + 1 < raw.length) {
      // Collected and joined once (appending in the loop was quadratic: a few MB of soft breaks took minutes).
      // A property that grows past MAX_LINE (an embedded photo) is dropped, its continuation lines still consumed.
      const parts = [line.slice(0, -1)];
      let length = parts[0].length;
      while (i + 1 < raw.length) {
        const next = raw[++i];
        const more = next.endsWith('=');
        if (length <= MAX_LINE) parts.push(more ? next.slice(0, -1) : next);
        length += next.length;
        if (!more) break;
      }
      if (length > MAX_LINE) continue;
      line = parts.join('');
    }
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }

  // 2. Rewrite each property in vCard 3.0 style. vCard 2.1 doesn't escape text, 3.0 does (a bare comma
  //    would split a NOTE into several values), so 2.1 text is escaped on the way.
  const v21 = lines.some((l) => /^VERSION:\s*2\.1\s*$/i.test(l));
  let version = '3.0';
  const props: string[] = [];
  let hasUid = false;
  let fn = '';
  let n: string[] = [];
  let org = '';
  let firstContact = '';
  for (const line of lines) {
    const parts = splitProp(line);
    if (!parts) continue;
    const [head, rawValue] = parts;
    const [nameWithGroup, ...params] = head.split(';');
    const name = nameWithGroup.split('.').pop()!.toUpperCase();
    if (name === 'BEGIN' || name === 'END') continue;
    if (name === 'VERSION') { version = rawValue.trim() === '4.0' ? '4.0' : '3.0'; continue; }
    if (line.length > MAX_LINE) continue;
    let qp = false;
    let charset = 'utf-8';
    const outParams: string[] = [];
    for (const p of params) {
      const eq = p.indexOf('=');
      const key = (eq < 0 ? '' : p.slice(0, eq)).toUpperCase();
      const val = eq < 0 ? p : p.slice(eq + 1);
      if (key === 'CHARSET') charset = val.replace(/"/g, '');
      else if (key === 'ENCODING' || (!key && /^(QUOTED-PRINTABLE|BASE64|8BIT|7BIT|B)$/i.test(val))) {
        if (/^QUOTED-PRINTABLE$/i.test(val)) qp = true;
        else if (/^(BASE64|B)$/i.test(val)) outParams.push('ENCODING=b');
      } else if (!key) {
        if (val) outParams.push(`TYPE=${val}`); // vCard 2.1: TEL;CELL;HOME → TYPE=CELL;TYPE=HOME
      } else outParams.push(`${key}=${val}`);
    }
    if (BINARY_PROPS.has(name) && version !== '4.0' && !outParams.includes('ENCODING=b') && !/^(https?|data):/i.test(rawValue)) continue;
    let value = qp ? decodeQuotedPrintable(rawValue, charset) : rawValue;
    if ((qp || v21) && TEXT_ESCAPED.has(name)) value = value.replace(/[\\,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
    else if (qp) value = value.replace(/\r?\n/g, ' ');
    if (name === 'UID') { if (!value.trim()) continue; hasUid = true; }
    if (name === 'FN') fn = value.trim();
    if (name === 'N') n = value.split(';').map((s) => s.trim());
    if (name === 'ORG') org = value.split(';')[0].trim();
    if ((name === 'EMAIL' || name === 'TEL') && !firstContact) firstContact = value.trim();
    props.push(`${name}${outParams.length ? ';' + outParams.join(';') : ''}:${value}`);
  }

  // 3. Every card needs a name and a UID.
  if (!fn) {
    fn = [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(' ') || org || firstContact;
    if (!fn) throw new Error('a contact without name, organization, email or phone');
    props.push(`FN:${fn.replace(/[,;\\]/g, (c) => '\\' + c)}`);
  }
  if (!n.length && version === '3.0') props.push(`N:${fn.replace(/[,;\\]/g, (c) => '\\' + c)};;;;`); // N is required in 3.0
  if (!hasUid) props.push(`UID:${randomUUID()}`);

  const text = ['BEGIN:VCARD', `VERSION:${version}`, ...props, 'END:VCARD'].join('\r\n') + '\r\n';
  const comp = new ICAL.Component(ICAL.parse(text) as any); // validates; throws on garbage
  if (comp.name !== 'vcard') throw new Error('not a vCard');
  return comp.toString() + '\r\n';
}

function parseVcards(text: string): ParsedFile {
  const out: ParsedFile = { format: 'vcard', vcards: [], contacts: [], skipped: 0, errors: [] };
  let block: string[] | null = null;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (/^BEGIN:VCARD\s*$/i.test(line)) block = [];
    else if (/^END:VCARD\s*$/i.test(line) && block) {
      if (out.vcards.length >= MAX_CONTACTS) { out.skipped++; block = null; continue; }
      try {
        out.vcards.push(normalizeCard(block));
      } catch (e: any) {
        out.skipped++;
        if (out.errors.length < 10) out.errors.push(`Card ${out.vcards.length + out.skipped}: ${e.message}`);
      }
      block = null;
    } else if (block) block.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV with quoted fields; the delimiter (",", ";" or tab) is guessed from the header line. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

type Role = 'given' | 'family' | 'fn' | 'email' | 'phone' | 'org' | 'title' | 'birthday' | 'note' | 'address' | `adr:${string}` | null;

/** Maps a column header of Google, Outlook or simple sheets to a contact field. */
function roleOf(header: string): Role {
  const k = key(header);
  if (/(type|label|displayname)$/.test(k) && !['displayname'].includes(k)) return null;
  if (['firstname', 'givenname', 'first', 'forename'].includes(k)) return 'given';
  if (['lastname', 'familyname', 'surname', 'last'].includes(k)) return 'family';
  if (['name', 'fullname', 'displayname', 'formattedname', 'contactname'].includes(k)) return 'fn';
  if (k.includes('email') || k === 'mail') return 'email';
  if ((k.includes('phone') || k.includes('mobile') || k === 'tel' || k.startsWith('telephone') || k === 'cell') && !k.includes('fax')) return 'phone';
  if (['company', 'organization', 'organisation', 'organizationname', 'organization1name', 'org', 'companyname'].includes(k)) return 'org';
  if (['jobtitle', 'title', 'organizationtitle', 'organization1title', 'position'].includes(k)) return 'title';
  if (['birthday', 'bday', 'dateofbirth', 'birthdate'].includes(k)) return 'birthday';
  if (['notes', 'note', 'comments'].includes(k)) return 'note';
  if (k.includes('address') && k.includes('formatted')) return 'address';
  if (k === 'address' || k === 'homeaddress' || k === 'businessaddress') return 'address';
  const adr = /^(home|business|other)?(street|city|state|region|postalcode|zip|zipcode|country|countryregion)$/.exec(k);
  if (adr) return `adr:${adr[1] ?? 'home'}:${adr[2]}`;
  return null;
}

function normalizeBirthday(v: string): string {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; // other orders are ambiguous
}

function parseCsvContacts(text: string): ParsedFile {
  const out: ParsedFile = { format: 'csv', vcards: [], contacts: [], skipped: 0, errors: [] };
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file has no contacts (expected a header row and one contact per row)');
  const roles = rows[0].map(roleOf);
  if (!roles.some((r) => r === 'fn' || r === 'given' || r === 'family' || r === 'email' || r === 'phone')) {
    throw new Error('No name, email or phone columns found. Use a vCard (.vcf) file, or a CSV with a header row such as "Name,Email,Phone".');
  }
  const ADR_ORDER = ['street', 'city', 'state', 'region', 'postalcode', 'zip', 'zipcode', 'country', 'countryregion'];
  for (const row of rows.slice(1)) {
    if (out.contacts.length >= MAX_CONTACTS) { out.skipped++; continue; }
    const c: ContactFields = { emails: [], phones: [] };
    const adr: Record<string, Record<string, string>> = {};
    row.forEach((cell, i) => {
      const role = roles[i];
      const values = cell.split(' ::: ').map((s) => s.trim()).filter(Boolean); // Google: several values per cell
      if (!role || !values.length) return;
      if (role === 'email') c.emails.push(...values);
      else if (role === 'phone') c.phones.push(...values);
      else if (role === 'given') c.givenName = values[0];
      else if (role === 'family') c.familyName = values[0];
      else if (role === 'fn') c.fn = values[0];
      else if (role === 'org') c.org = values[0];
      else if (role === 'title') c.title = values[0];
      else if (role === 'note') c.note = values.join('\n');
      else if (role === 'birthday') c.birthday = normalizeBirthday(values[0]);
      else if (role === 'address') c.address ??= values[0].replace(/\s*\n\s*/g, ', ');
      else if (role.startsWith('adr:')) {
        const [, where, part] = role.split(':');
        (adr[where] ??= {})[part] = values[0];
      }
    });
    if (!c.address) {
      const parts = adr.home ?? adr.business ?? adr.other;
      if (parts) c.address = ADR_ORDER.map((p) => parts[p]).filter(Boolean).join(', ');
    }
    c.emails = [...new Set(c.emails)];
    c.phones = [...new Set(c.phones)];
    if (!c.fn && !c.givenName && !c.familyName && !c.org && !c.emails.length && !c.phones.length) { out.skipped++; continue; }
    if (!c.fn && !c.givenName && !c.familyName && !c.org) c.fn = c.emails[0] ?? c.phones[0];
    out.contacts.push(c);
  }
  return out;
}

/** Detects the format and parses an uploaded contacts file. */
export function parseContactsFile(buf: Buffer): ParsedFile {
  const text = decodeText(buf).replace(/^﻿/, '');
  if (/^\s*BEGIN:VCARD/im.test(text)) return parseVcards(text);
  return parseCsvContacts(text);
}
