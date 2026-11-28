// Browser tests of the web app (Playwright, Chromium), run in CI against the running container:
//   cd tests/web && npm ci && npx playwright install --with-deps chromium && node run.mjs http://localhost:8080 admin <password>
// They drive the real pages the way people use them: upload by button and by dropping files, dropping onto a folder,
// moving with Undo, the Move dialog, selection, sorting, list/grid, the editor, sharing, the trash, right-to-left,
// and Administration (confirming with the administrator's password, the limits).
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

/** A plain RGB PNG that browsers decode (a picture to upload as a profile picture). */
function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const [BASE, ADMIN, ADMIN_PW] = process.argv.slice(2);
if (!ADMIN_PW) { console.error('usage: node run.mjs <base url> <admin> <password>'); process.exit(2); }
const H = { 'X-Cloudy-Request': '1', 'Content-Type': 'application/json' };
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail).slice(0, 400)}`);
  ok ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookies = new Map();
async function cookieOf(user, password) {
  if (!cookies.has(user)) {
    const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ user, password }) });
    cookies.set(user, r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
  }
  return cookies.get(user);
}

async function apiSession(user, password) {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ user, password }) });
  if (r.status !== 200) throw new Error(`login ${user}: ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return async (method, p, body) => {
    const res = await fetch(BASE + p, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  };
}

// A user of its own, with a few folders and files.
const USER = `web${Date.now().toString(36)}`;
const PW = 'web-test-pass-123';
const admin = await apiSession(ADMIN, ADMIN_PW);
await admin('POST', '/api/admin/users', { id: USER, password: PW, displayName: 'Web Test' });
const api = await apiSession(USER, PW);
const me = (await api('GET', '/api/me')).body;
const mk = async (parent, name) => (await api('POST', `/api/nodes/${parent}/folders`, { name })).body;
const put = async (parent, name, content) => (await api('POST', `/api/nodes/${parent}/files`, { name, content })).body;
const invoices = await mk(me.rootId, 'Invoices');
const work = await mk(me.rootId, 'Work');
await mk(me.rootId, 'Photos');
for (const n of [1, 2, 10, 11]) await put(invoices.id, `Invoice ${n}.txt`, 'x'.repeat(n));
await put(me.rootId, 'notes.md', '# Notes\n');
await put(me.rootId, 'big.txt', 'x'.repeat(5000));

// Files to drop from "the computer".
const dir = mkdtempSync(path.join(tmpdir(), 'cloudy-web-'));
writeFileSync(path.join(dir, 'receipt.txt'), 'receipt');
writeFileSync(path.join(dir, 'notes.md'), '# Other notes\n');
writeFileSync(path.join(dir, 'later.txt'), 'later');
mkdirSync(path.join(dir, 'Trip'));
writeFileSync(path.join(dir, 'Trip', 'day1.txt'), 'day one');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const cdp = await context.newCDPSession(page);
const drag = (type, x, y, files) => cdp.send('Input.dispatchDragEvent', { type, x, y, data: { items: [], files, dragOperationsMask: 1 } });
/** Drags files from the computer to (x, y): enter, two moves (the second gives the element its dragover), drop. */
const dropFiles = async (files, x, y, before) => {
  await drag('dragEnter', x, y, files);
  await drag('dragOver', x, y, files);
  await drag('dragOver', x + 1, y, files);
  await sleep(150);
  if (before) await before();
  await drag('drop', x + 1, y, files);
};
const children = async (id) => (await api('GET', `/api/nodes/${id}`)).body.children;
const center = async (locator) => { const b = await locator.boundingBox(); return { x: b.x + Math.min(b.width / 2, 300), y: b.y + b.height / 2 }; };
const toasts = () => page.locator('.toasts .toast').allTextContents();
/** Stores bytes as a file through the upload API (the JSON file endpoint takes text only). */
const upload = async (parent, name, bytes) => {
  const start = (await api('POST', '/api/uploads', { parentId: parent, name, size: bytes.length })).body;
  const cookie = await cookieOf(USER, PW);
  const r = await fetch(`${BASE}/api/uploads/${start.id}`, { method: 'PUT', headers: { 'X-Cloudy-Request': '1', 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0', cookie }, body: bytes });
  return r.json();
};

console.log('== sign in');
await page.goto(`${BASE}/`);
await page.fill('input[name=username]', USER);
await page.fill('input[name=password]', PW);
await page.click('button[type=submit]');
await page.waitForSelector('.file-row');
check('signed in, files listed', (await page.locator('.file-row').count()) >= 5);
check('tab title names the view', (await page.title()) === 'Files – Cloudy', await page.title());

console.log('== drop files from the computer');
{
  const row = page.locator('.file-row', { hasText: 'Invoices' });
  const p = await center(row);
  let strip = '';
  await dropFiles([path.join(dir, 'receipt.txt')], p.x, p.y, async () => { strip = await page.locator('#drop-strip').innerText(); });
  check('strip names the folder under the pointer', /Invoices/.test(strip), strip);
  await page.waitForSelector('.upload-panel li.done', { timeout: 15000 });
  await sleep(300);
  check('file dropped on a folder row lands in that folder', (await children(invoices.id)).some((c) => c.name === 'receipt.txt'));
  check('message names the destination and offers Show', (await toasts()).some((t) => /Invoices/.test(t) && /Show/.test(t)), await toasts());
}
{
  const side = await page.locator('.sidebar').boundingBox();
  await dropFiles([path.join(dir, 'Trip')], side.x + side.width / 2, side.y + side.height - 150);
  await page.waitForSelector('.upload-panel li.done', { timeout: 15000 });
  await sleep(500);
  const top = await children(me.rootId);
  const trip = top.find((c) => c.name === 'Trip');
  check('a folder dropped beside the list goes into the folder on screen', !!trip && (await children(trip.id)).some((c) => c.name === 'day1.txt'));
  check('the strip is gone after the drop (top bar uncovered)', !(await page.locator('#drop-strip').isVisible()));
}
{
  // A drag that leaves the window or is cancelled: no more dragover events, the strip goes away by itself.
  const p = await center(page.locator('.file-row', { hasText: 'big.txt' }));
  await drag('dragEnter', p.x, p.y, [path.join(dir, 'receipt.txt')]);
  await drag('dragOver', p.x, p.y, [path.join(dir, 'receipt.txt')]);
  await sleep(200);
  const shown = await page.locator('#drop-strip').isVisible();
  await drag('dragCancel', p.x, p.y, [path.join(dir, 'receipt.txt')]);
  await sleep(1300);
  check('a cancelled drag shows the strip, then hides it', shown && !(await page.locator('#drop-strip').isVisible()));
}

console.log('== same name: asked once');
{
  const list = await page.locator('.file-row', { hasText: 'big.txt' });
  const p = await center(list);
  await dropFiles([path.join(dir, 'notes.md')], p.x, p.y);
  const dlg = page.locator('dialog[open]');
  await dlg.waitFor({ timeout: 5000 });
  check('conflict question appears', /already exist/i.test(await dlg.innerText()), await dlg.innerText());
  await page.getByRole('button', { name: 'Keep both' }).click();
  await page.waitForSelector('.upload-panel li.done', { timeout: 15000 });
  await sleep(500);
  const names = (await children(me.rootId)).map((c) => c.name);
  check('keep both: "notes (2).md" next to the old one', names.includes('notes.md') && names.includes('notes (2).md'), names);
}

console.log('== move by dragging rows, with Undo');
{
  await page.goto(`${BASE}/files`); await page.waitForSelector('.file-row');
  const src = await center(page.locator('.file-row', { hasText: 'big.txt' }));
  const dst = await center(page.locator('.file-row', { hasText: 'Work' }));
  await page.mouse.move(src.x, src.y); await page.mouse.down();
  await page.mouse.move(src.x + 10, src.y - 10, { steps: 3 }); await page.mouse.move(dst.x, dst.y, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll('.toasts .toast')].some((x) => /Moved/.test(x.textContent)), null, { timeout: 5000 });
  check('move message names the folder', (await toasts()).some((t) => /Work/.test(t) && /Undo/.test(t)), await toasts());
  check('moved', (await children(work.id)).some((c) => c.name === 'big.txt'));
  await page.locator('.toast-action', { hasText: 'Undo' }).click();
  await sleep(800);
  check('Undo puts it back', (await children(me.rootId)).some((c) => c.name === 'big.txt'));
}

console.log('== Move or copy dialog');
{
  await page.goto(`${BASE}/files/${invoices.id}`); await page.waitForSelector('.file-row');
  await page.locator('.file-row', { hasText: 'Invoice 1.txt' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move or copy' }).click();
  await page.waitForSelector('dialog[open] .picker-list');
  const crumbs = await page.locator('dialog[open] nav.breadcrumb').innerText();
  check('path is readable and starts in the item\'s folder', !/object/i.test(crumbs) && /Invoices\s*$/.test(crumbs.trim()), crumbs);
  await page.keyboard.press('Escape');
}

console.log('== sorting and natural order');
{
  const names = await page.locator('.file-row .name').allTextContents();
  check('names in natural order (2 before 10)', names.indexOf('Invoice 2.txt') < names.indexOf('Invoice 10.txt'), names);
  await page.locator('th .th-sort', { hasText: 'Size' }).click();
  await sleep(300);
  const bySize = await page.locator('.file-row .name').allTextContents();
  check('sort by size from the column heading: largest first', bySize[0] === 'Invoice 11.txt', bySize);
  await page.locator('th .th-sort', { hasText: 'Size' }).click();
  await sleep(300);
  const smallFirst = await page.locator('.file-row .name').allTextContents();
  check('a second click turns the order round', smallFirst[0] === 'Invoice 1.txt', smallFirst);
  await page.locator('th .th-sort', { hasText: 'Name' }).click();
}

console.log('== list and grid');
{
  await page.getByRole('button', { name: 'Grid' }).click();
  await page.waitForSelector('.tile');
  await page.reload(); await page.waitForSelector('.tile');
  check('grid is remembered after a reload', (await page.locator('.tile').count()) > 0);
  // A tile's checkbox and ⋯ are there without the pointer on the tile (they used to appear on hover only).
  await page.mouse.move(5, 5);
  await sleep(200);
  const plain = await page.evaluate(() => {
    const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.opacity === '1' && s.visibility === 'visible' && s.display !== 'none' && r.width > 0 && r.height > 0; };
    const box = document.querySelector('.tile .tile-pick input[type=checkbox]');
    const r = box?.getBoundingClientRect();
    return {
      controls: [...document.querySelectorAll('.tile .tile-pick, .tile .tile-more')].map(seen),
      onTop: !!box && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === box,
    };
  });
  check('a tile shows its checkbox and ⋯ without hovering', plain.controls.length >= 2 && plain.controls.every(Boolean) && plain.onTop, plain);
  await page.getByRole('button', { name: 'List' }).click();
  await page.waitForSelector('table .file-row');
}

console.log('== Back with a dialog open');
{
  // Into a folder by a click (so Back stays inside the app), a dialog opened there, then Back.
  await page.goto(`${BASE}/files`); await page.waitForSelector('.file-row');
  await page.locator('.file-row', { hasText: 'Invoices' }).locator('.name').click();
  await page.waitForSelector('.file-row:has-text("Invoice 1.txt")');
  await page.locator('.file-row', { hasText: 'Invoice 1.txt' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.waitForSelector('dialog.modal[open]');
  await page.goBack();
  await page.waitForSelector('.file-row:has-text("Work")', { timeout: 5000 }).catch(() => {});
  check('Back with a dialog open closes it and shows the page before',
    (await page.locator('dialog[open]').count()) === 0 && !new URL(page.url()).pathname.endsWith(`/${invoices.id}`) && (await page.locator('.file-row', { hasText: 'Work' }).count()) === 1,
    { dialogs: await page.locator('dialog[open]').count(), url: page.url() });
}

console.log('== selection bar');
{
  await page.goto(`${BASE}/files`); await page.waitForSelector('.file-row');
  await page.locator('.file-row').first().locator('input[type=checkbox]').check();
  await page.evaluate(() => window.scrollTo(0, 400));
  const hit = await page.evaluate(() => { const b = document.querySelector('.selection-bar').getBoundingClientRect(); return document.elementFromPoint(b.left + 60, b.top + b.height / 2)?.closest('.selection-bar') ? 'bar' : 'hidden'; });
  check('selection bar stays reachable', hit === 'bar', hit);
  check('no "false" in the bar', !/false/.test(await page.locator('.selection-bar').innerText()));
  await page.keyboard.press('Escape');
  check('Escape clears the selection', await page.locator('.selection-bar').isHidden());
  // Shift-click on a checkbox ticks the range, and every box in it shows its tick (the clicked one used to stay empty).
  const boxes = page.locator('.file-row input[type=checkbox]');
  await boxes.nth(0).check();
  await boxes.nth(2).click({ modifiers: ['Shift'] });
  const ticked = await page.evaluate(() => [...document.querySelectorAll('.file-row')].slice(0, 3).map((r) => r.querySelector('input[type=checkbox]').checked && r.classList.contains('selected')));
  const said = await page.locator('.selection-bar').innerText();
  check('Shift-click on a checkbox ticks the range, the clicked box included', ticked.length === 3 && ticked.every(Boolean) && /3 selected/.test(said), { ticked, said });
  // "Select all" pressed by keyboard: the focus stays in the bar (the bar used to be rebuilt under it).
  await page.locator('.selection-bar button', { hasText: 'Select all' }).focus();
  await page.keyboard.press('Enter');
  const kept = await page.evaluate(() => ({ inBar: !!document.activeElement?.closest('.selection-bar'), all: [...document.querySelectorAll('.file-row input[type=checkbox]')].every((b) => b.checked) }));
  check('Select all by keyboard ticks everything and keeps the focus in the bar', kept.inBar && kept.all, kept);
  await page.locator('.file-row').first().focus();
  await page.keyboard.press('Escape');
}

console.log('== editor');
{
  await page.goto(`${BASE}/files`); await page.waitForSelector('.file-row');
  await page.locator('.file-row', { hasText: 'notes.md' }).first().click();
  await page.waitForSelector('.text-editor');
  await page.locator('.text-editor').press('End'); await page.keyboard.type(' edited here');
  await page.getByRole('button', { name: 'Save' }).click(); await sleep(500);
  const visible = await page.evaluate(() => { const t = document.querySelector('dialog[open] .toast'); if (!t) return false; const r = t.getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.toast'); });
  check('the save message is visible over the editor', visible);
  // Someone else saves meanwhile: the next save asks instead of overwriting.
  const note = (await children(me.rootId)).find((c) => c.name === 'notes.md');
  await fetch(`${BASE}/api/nodes/${note.id}/content`, { method: 'PUT', headers: { 'X-Cloudy-Request': '1', 'Content-Type': 'application/octet-stream', cookie: await cookieOf(USER, PW) }, body: 'their text' });
  await page.locator('.text-editor').press('End'); await page.keyboard.type(' and more');
  await page.getByRole('button', { name: 'Save' }).click();
  const asked = await page.locator('dialog.modal[open]').filter({ hasText: 'changed' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('saving over a newer version asks first', asked);
  if (asked) await page.locator('dialog.modal[open]').getByRole('button', { name: 'Cancel' }).click();
  // Back closes the viewer and asks about the unsaved text.
  await page.goBack();
  const discard = await page.locator('dialog.modal[open]').filter({ hasText: 'Discard' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('Back with unsaved text asks before closing the editor', discard);
  if (discard) await page.locator('dialog.modal[open]').getByRole('button', { name: 'Discard' }).click();
  await sleep(300);
  check('after Back the folder is still on screen', (await page.locator('dialog.viewer[open]').count()) === 0 && (await page.locator('.file-row').count()) > 0);
}

console.log('== trash');
{
  const a = await put(me.rootId, 'taken.txt', 'first');
  await api('DELETE', `/api/nodes/${a.id}`);
  await put(me.rootId, 'taken.txt', 'second');
  await page.goto(`${BASE}/trash`); await page.waitForSelector('.file-row');
  await page.locator('.file-row', { hasText: 'taken.txt' }).getByRole('button', { name: 'Restore' }).click();
  await sleep(600);
  check('restore with a taken name comes back as "taken (2).txt"', (await toasts()).some((t) => /taken \(2\)\.txt/.test(t)), await toasts());
}

console.log('== keyboard, Back, shared folders');
{
  await page.goto(`${BASE}/`); await page.waitForSelector('.file-row');
  // One Tab stop for the whole list: the current row, its checkbox and its ⋯ button (it was three per row).
  const stops = await page.evaluate(() => [...document.querySelectorAll('.file-table tbody *')].filter((el) => el.tabIndex >= 0 && !el.disabled).length);
  check('the list is one Tab stop (a row, its checkbox and ⋯)', stops === 3, stops);
  await page.locator('.file-row').first().focus();
  await page.keyboard.press('ArrowDown');
  const moved = await page.evaluate(() => document.activeElement === document.querySelectorAll('.file-row')[1] && document.activeElement.tabIndex === 0);
  check('arrow keys move the Tab stop along', moved);
  await page.keyboard.press('Shift+F10');
  check('Shift+F10 opens the row\'s actions', await page.locator('.menu').isVisible().catch(() => false));
  await page.keyboard.press('Escape');

  // Back returns to where the folder was scrolled to.
  const many = await mk(me.rootId, 'Many');
  for (let i = 0; i < 60; i++) await mk(many.id, `folder ${String(i).padStart(2, '0')}`);
  await page.goto(`${BASE}/files/${many.id}`); await page.waitForSelector('.file-row');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(200);
  const before = await page.evaluate(() => window.scrollY);
  await page.locator('.file-row', { hasText: 'folder 59' }).locator('.name').click();
  await page.waitForURL((u) => !u.pathname.endsWith(`/${many.id}`)); await sleep(400);
  await page.goBack(); await page.waitForSelector('.file-row', { hasText: 'folder 00' }); await sleep(400);
  const after = await page.evaluate(() => window.scrollY);
  check('Back puts the folder back where it was scrolled to', before > 300 && Math.abs(after - before) < 40, { before, after });

  // A folder shared with you: the sidebar marks "Shared with you", the path leads back there.
  const adminRoot = (await admin('GET', '/api/me')).body.rootId;
  const secret = (await admin('POST', `/api/nodes/${adminRoot}/folders`, { name: `Secret ${USER}` })).body;
  const team = (await admin('POST', `/api/nodes/${secret.id}/folders`, { name: `Team ${USER}` })).body;
  await admin('POST', `/api/nodes/${team.id}/files`, { name: `inside ${USER}.txt`, content: 'x' });
  await admin('POST', `/api/nodes/${team.id}/shares`, { type: 'user', shareWith: USER, canEdit: true });
  // Search: what was shared starts at "/", never under the owner's own folders (it showed "/Secret …").
  const found = (await api('GET', `/api/search?q=${encodeURIComponent(USER)}`)).body;
  const sroot = found.find((f) => f.id === team.id);
  const sin = found.find((f) => f.name === `inside ${USER}.txt`);
  check('search: a shared folder is at "/", its owner\'s folders stay out of sight', sroot?.path === '/' && sroot?.parentVisible === false && !found.some((f) => f.id === secret.id), sroot);
  check('search: inside a shared folder the path starts there', sin?.path === `/Team ${USER}` && sin?.parentVisible === true, sin);
  await page.goto(`${BASE}/files/${team.id}`); await page.waitForSelector('.files-view');
  const marked = await page.locator('.sidebar a.active').getAttribute('data-view');
  check('inside a shared folder the sidebar marks "Shared with you"', marked === 'shared-in', marked);
  // Taking the share away while it is open: the page says so instead of going quietly.
  await page.goto(`${BASE}/shared-in`); await page.waitForSelector('.file-row');
  await page.locator('.file-row', { hasText: `Team ${USER}` }).click({ button: 'right' });
  const entries = await page.getByRole('menuitem').allTextContents();
  check('"Show in folder" is not offered for an item shared on its own', entries.length > 0 && !entries.some((x) => /Show in folder/.test(x)), entries);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/files/${team.id}`); await page.waitForSelector('.files-view');
  const shares = (await admin('GET', `/api/nodes/${team.id}/shares`)).body;
  check('the owner\'s share list names the person', shares.some((s) => s.shareWithName === 'Web Test'), shares);
  await admin('DELETE', `/api/shares/${shares[0].id}`);
  await page.waitForFunction(() => location.pathname !== document.body.dataset.x && !/\/files\/\d+$/.test(location.pathname) || document.querySelector('.toasts .toast'), null, { timeout: 8000 }).catch(() => {});
  await sleep(500);
  check('a folder no longer shared is closed, and the page says so', (await toasts()).some((t) => /no longer available/.test(t)), await toasts());
  await admin('DELETE', `/api/nodes/${secret.id}`);
}

console.log('== an upload that ends keeps a selection');
{
  await page.goto(`${BASE}/files/${invoices.id}`); await page.waitForSelector('.file-row');
  await page.locator('.file-row', { hasText: 'Invoice 1.txt' }).locator('input[type=checkbox]').check();
  const side = await page.locator('.sidebar').boundingBox();
  await dropFiles([path.join(dir, 'later.txt')], side.x + side.width / 2, side.y + side.height - 150);
  await page.waitForSelector('.upload-panel li.done', { timeout: 15000 });
  await sleep(1200);
  const kept = await page.locator('.file-row', { hasText: 'Invoice 1.txt' }).locator('input[type=checkbox]').isChecked();
  check('the selection survives the upload', kept && await page.locator('.selection-bar').isVisible());
  await page.keyboard.press('Escape');
  await page.locator('.file-row', { hasText: 'Invoice 10.txt' }).focus();
  await page.keyboard.press('Escape');
  const shown = await page.waitForSelector('.file-row:has-text("later.txt")', { timeout: 6000 }).then(() => true, () => false);
  check('the new file shows once the selection is cleared', shown);
}

console.log('== findings of the 1.19 review');
{
  // Thumbnails load in the grid (only where the server makes them: in the container, not on a dev machine).
  if (me.thumbnails) {
    const pics = await mk(me.rootId, 'Pics');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR42mP4z8AARIQRAwMDABh7Afd6XqzQAAAAAElFTkSuQmCC', 'base64');
    await upload(pics.id, 'tiny.png', png);
    await page.goto(`${BASE}/files/${pics.id}`); await page.waitForSelector('.file-row');
    await page.locator('.seg button', { hasText: '' }).nth(1).click(); // grid
    const loaded = await page.waitForFunction(() => [...document.querySelectorAll('.tile-art img')].some((i) => i.naturalWidth > 0 && !i.classList.contains('pending')), null, { timeout: 8000 }).then(() => true, () => false);
    check('grid tiles show the thumbnail', loaded);
    await page.locator('.seg button').nth(0).click(); // back to the list for the rest
  } else console.log('  (no thumbnails on this server: the grid picture check runs in the container)');

  // A picture the browser cannot decode is not reported as deleted.
  await put(me.rootId, 'broken.png', 'this is not a picture');
  await page.goto(`${BASE}/`); await page.waitForSelector('.file-row');
  await page.locator('.file-row', { hasText: 'broken.png' }).locator('.name').click();
  const msg = await page.waitForSelector('dialog.viewer .no-preview', { timeout: 8000 }).then((e) => e.innerText(), () => '');
  check('a picture that cannot be shown says so (not "no longer available")', /cannot be shown/.test(msg) && !/no longer available/.test(msg), msg);
  await page.keyboard.press('Escape'); await sleep(300);

  // Selecting text by dragging out of the editor does not close it.
  await page.locator('.file-row', { hasText: 'notes.md' }).first().locator('.name').click();
  const area = await page.waitForSelector('dialog.viewer textarea');
  const box = await area.boundingBox();
  const stageBox = await page.locator('dialog.viewer .viewer-stage').boundingBox();
  // End the drag on the stage itself, beside or below the text area.
  const out = box.x - stageBox.x > 8 ? { x: stageBox.x + 4, y: box.y + 20 } : { x: box.x + 20, y: Math.min(stageBox.y + stageBox.height - 4, box.y + box.height + 6) };
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
  await page.mouse.move(out.x, out.y, { steps: 5 }); await page.mouse.up();
  await sleep(300);
  check('dragging a text selection out of the editor keeps it open', (await page.locator('dialog.viewer[open]').count()) === 1);
  await page.keyboard.press('Escape'); await sleep(300);
  if (await page.locator('dialog.modal[open]').count()) await page.locator('dialog.modal[open]').getByRole('button', { name: 'Discard' }).click();

  // Keyboard: Enter on a column heading keeps the focus there; the Delete key's question starts on "Delete".
  await page.locator('.th-sort', { hasText: 'Size' }).focus();
  await page.keyboard.press('Enter'); await sleep(600);
  check('sorting by keyboard keeps the focus on the heading', await page.evaluate(() => document.activeElement?.dataset?.key === 'sort-size'));
  await page.locator('.th-sort', { hasText: 'Name' }).focus(); await page.keyboard.press('Enter'); await sleep(600);
  await page.locator('.file-row', { hasText: 'big.txt' }).focus();
  await page.keyboard.press('Delete');
  await page.waitForSelector('dialog.modal[open]');
  check('the Delete key\'s question starts on its Delete button', await page.evaluate(() => document.activeElement?.textContent === 'Delete'));
  await page.keyboard.press('Escape'); await sleep(300);
  await page.keyboard.press('Escape'); // clear the selection the key made

  // A big folder: every row can be scrolled to, also after an action far down, which keeps the place.
  const big = await mk(me.rootId, 'Big');
  for (let i = 0; i < 650; i++) await put(big.id, `file ${String(i).padStart(4, '0')}.txt`, 'x');
  await page.goto(`${BASE}/files/${big.id}`); await page.waitForSelector('.file-row');
  await page.mouse.move(700, 500);
  const scrollAll = async () => { for (let i = 0; i < 60 && (await page.locator('.file-row').count()) < 650; i++) { await page.mouse.wheel(0, 5000); await sleep(120); } };
  await scrollAll();
  check('every row of a big folder can be scrolled to', (await page.locator('.file-row').count()) === 650, await page.locator('.file-row').count());
  const far = page.locator('.file-row', { hasText: 'file 0600.txt' });
  await far.scrollIntoViewIfNeeded();
  const y0 = await page.evaluate(() => window.scrollY);
  await far.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click();
  await sleep(1000);
  const y1 = await page.evaluate(() => window.scrollY);
  check('an action far down a big folder keeps the place', y0 > 20000 && Math.abs(y1 - y0) < 60, { y0, y1 });
  await scrollAll();
  check('and the rest of it can still be scrolled to', (await page.locator('.file-row').count()) === 650, await page.locator('.file-row').count());

  // Tablets in portrait: settings fit beside the sidebar.
  await page.setViewportSize({ width: 800, height: 1000 });
  for (const where of ['/settings']) {
    await page.goto(BASE + where); await sleep(900);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`${where} fits an 800 px tablet`, w <= 800, w);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

console.log('== phone');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/files/${invoices.id}`); await page.waitForSelector('.file-row');
  const meta = await page.locator('.file-row .row-meta').first();
  check('phones show the date under the name (the column is hidden)', await meta.isVisible() && (await meta.innerText()).length > 0, await meta.innerText().catch(() => ''));
  await page.setViewportSize({ width: 1440, height: 900 });
}

console.log('== account menu, administration');
{
  // A regular user: their name and username (which opens Settings), then Log out. Nothing about administration.
  await page.goto(`${BASE}/files`); await page.waitForSelector('.file-row');
  await page.locator('.avatar-btn').click();
  const items = await page.getByRole('menuitem').allTextContents();
  check('a regular user\'s menu: name and username, then Log out only',
    items.length === 2 && /Web Test/.test(items[0]) && items[0].includes(USER) && /Log out/.test(items[1]), items);
  await page.getByRole('menuitem').first().click();
  await page.waitForSelector('.settings-view');
  check('the name in the menu opens Settings', new URL(page.url()).pathname === '/settings');
  check('the rail has no Administration entry', (await page.locator('.sidebar a[href="/admin"]').count()) === 0);
  await page.goto(`${BASE}/admin`); await page.waitForSelector('.forbidden');
  check('a regular user typing /admin is told it is for administrators', await page.locator('.forbidden').isVisible() && (await page.locator('.admin-view').count()) === 0);
}

console.log('== profile picture');
{
  const png = path.join(dir, 'me.png');
  writeFileSync(png, solidPng(640, 480, [10, 85, 196])); // wider than tall: the middle square is kept
  await page.goto(`${BASE}/settings`); await page.waitForSelector('.avatar-editor');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload picture' }).click();
  await (await chooser).setFiles(png);
  await page.locator('dialog[open]').getByRole('button', { name: 'Save picture' }).click();
  const shown = await page.waitForFunction(() => document.querySelector('.avatar-btn img')?.naturalWidth > 0, null, { timeout: 8000 }).then(() => true, () => false);
  const saved = (await api('GET', '/api/me')).body.avatar;
  check('a new profile picture is saved and shows in the top bar', shown && typeof saved === 'string' && saved.length > 0, saved);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.avatar-btn img'), null, { timeout: 8000 }).catch(() => {});
  check('removing it brings the initials back', (await api('GET', '/api/me')).body.avatar === null && (await page.locator('.avatar-btn img').count()) === 0);
}

console.log('== invitations');
{
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await adminCtx.request.post(`${BASE}/api/login`, { headers: H, data: { user: ADMIN, password: ADMIN_PW } });
  const ap = await adminCtx.newPage();
  ap.on('pageerror', (e) => errors.push(e.message));
  await ap.goto(`${BASE}/files`); await ap.waitForSelector('.files-view');
  await ap.locator('.avatar-btn').click();
  const items = await ap.getByRole('menuitem').allTextContents();
  check('an administrator\'s menu adds Administration', items.length === 3 && /Administration/.test(items[1]), items);
  await ap.getByRole('menuitem', { name: 'Administration' }).click();
  await ap.waitForSelector('.admin-view');
  const address = `new-${USER}@example.com`;
  await ap.getByRole('button', { name: 'Invite someone' }).click();
  await ap.locator('dialog[open] input[type=email]').fill(address);
  // No email set up on the test server (the e2e run sets it later): the dialog makes a link to send by hand.
  await ap.locator('dialog[open] footer button[type=submit]').click();
  const link = await ap.locator('dialog[open] .link-box input').inputValue().catch(() => '');
  check('inviting gives a one-time link to /invite#…', /\/invite#[\w-]+$/.test(link), link);
  await ap.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();
  await ap.locator('.invites li', { hasText: address }).waitFor({ timeout: 5000 }).catch(() => {});
  check('the invitation is listed until it is used', await ap.locator('.invites li', { hasText: address }).isVisible());
  // The person opens the link in their own browser and picks a username and password.
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const gp = await guest.newPage();
  gp.on('pageerror', (e) => errors.push(e.message));
  const target = BASE + new URL(link).pathname + new URL(link).hash; // the server may answer with its PUBLIC_URL
  await gp.goto(target); await gp.waitForSelector('.login-card input[autocomplete=username]');
  check('the address bar no longer shows the token', new URL(gp.url()).pathname === '/invite' && !new URL(gp.url()).hash, gp.url());
  const invited = `inv${USER}`.slice(0, 64);
  await gp.locator('input[autocomplete=username]').fill(invited);
  await gp.locator('input[autocomplete=new-password]').nth(0).fill('invited-pass-123');
  await gp.locator('input[autocomplete=new-password]').nth(1).fill('invited-pass-123');
  await gp.getByRole('button', { name: 'Create account' }).click();
  await gp.waitForSelector('.files-view', { timeout: 8000 }).catch(() => {});
  check('accepting creates the account and signs the person in', (await gp.locator('.files-view').count()) === 1);
  await gp.locator('.avatar-btn').click();
  const theirs = await gp.getByRole('menuitem').allTextContents();
  check('the invited person is not an administrator', theirs.length === 2 && !theirs.some((x) => /Administration/.test(x)), theirs);
  const users = (await admin('GET', '/api/admin/users')).body;
  const made = users.find((u) => u.id === invited);
  check('their account has the invited address and no admin rights', made?.email === address && made?.isAdmin === false, made);
  // The link worked once.
  const again = await browser.newContext();
  const p2 = await again.newPage();
  await p2.goto(target); await p2.waitForSelector('.login-card');
  check('an invitation link works only once', (await p2.locator('.card-title').innerText()).includes('can'), await p2.locator('.card-title').innerText());
  await ap.reload(); await ap.waitForSelector('.admin-view');
  check('a used invitation leaves the list', (await ap.locator('.invites li', { hasText: address }).count()) === 0);

  console.log('== administration: confirm with your password');
  // A new password for someone (here the person just invited) is confirmed with the administrator's own password.
  await ap.getByRole('button', { name: `Edit ${invited}`, exact: true }).click();
  await ap.locator('dialog[open] input[autocomplete=new-password]').fill('changed-pass-456');
  await ap.locator('dialog[open] footer button[type=submit]').click();
  const confirm = ap.locator('dialog[open]').filter({ has: ap.locator('input[autocomplete=current-password]') });
  const asked = await confirm.waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('setting someone\'s password asks for the administrator\'s own password', asked);
  if (asked) {
    await confirm.locator('input[autocomplete=current-password]').fill('not-the-password');
    await confirm.locator('footer button[type=submit]').click();
    await ap.waitForFunction(() => [...document.querySelectorAll('dialog[open] .error')].some((e) => e.textContent.trim()), null, { timeout: 5000 }).catch(() => {});
    const refused = (await confirm.count()) === 1 ? (await confirm.locator('.error').innerText()).trim() : '';
    check('a wrong password is refused, and the question stays open', refused.length > 0, refused);
    await confirm.locator('input[autocomplete=current-password]').fill(ADMIN_PW);
    await confirm.locator('footer button[type=submit]').click();
    await ap.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 }).catch(() => {});
    const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ user: invited, password: 'changed-pass-456' }) });
    check('with the right one the new password is set', login.status === 200 && (await ap.locator('dialog[open]').count()) === 0, login.status);
  }

  console.log('== administration: limits');
  {
    const before = (await admin('GET', '/api/admin/limits')).body;
    await ap.goto(`${BASE}/admin/limits`); await ap.waitForSelector('.admin-view input[name=trashDays]');
    const devices = ap.locator('input[name=deviceDays]');
    const reserve = ap.locator('input[name=diskReserveMb]');
    const there = (await devices.count()) === 1 && (await reserve.count()) === 1;
    check('Limits shows the days for unused devices and the free space to keep', there, before);
    if (there) {
      // A little more of each: lower numbers ask first (fewer days sign devices out).
      const want = { deviceDays: before.deviceDays ? before.deviceDays + 1 : 0, diskReserveMb: before.diskReserveMb + 1 };
      await devices.fill(String(want.deviceDays));
      await reserve.fill(String(want.diskReserveMb));
      await ap.locator('.admin-view form button[type=submit]').click();
      await ap.waitForFunction(() => [...document.querySelectorAll('.toasts .toast')].some((x) => /Limits saved/.test(x.textContent)), null, { timeout: 5000 }).catch(() => {});
      const after = (await admin('GET', '/api/admin/limits')).body;
      check('both are saved', after.deviceDays === want.deviceDays && after.diskReserveMb === want.diskReserveMb, after);
      await admin('PUT', '/api/admin/limits', before); // as it was
    }
  }
  console.log('== administration: email settings are confirmed with your password');
  {
    await ap.goto(`${BASE}/admin/email`); await ap.waitForSelector('.admin-view input[type=email]');
    const form = ap.locator('.admin-view form');
    await form.locator('label.field', { hasText: 'SMTP server' }).locator('input').fill('smtp.invalid');
    await form.locator('input[type=email]').fill('cloudy@example.com');
    await form.locator('button[type=submit]').click();
    const confirm = ap.locator('dialog[open]').filter({ has: ap.locator('input[autocomplete=current-password]') });
    const asked = await confirm.waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('saving the email settings asks for the administrator\'s own password', asked);
    if (asked) {
      await confirm.locator('input[autocomplete=current-password]').fill(ADMIN_PW);
      await confirm.locator('footer button[type=submit]').click();
      await ap.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 }).catch(() => {});
      const saved = (await admin('GET', '/api/admin/mail')).body;
      check('with it, they are saved', saved?.host === 'smtp.invalid' && saved?.fromEmail === 'cloudy@example.com', saved);
    }
    await admin('PUT', '/api/admin/mail', { host: '', adminPassword: ADMIN_PW }); // email off again, as it was
  }
  console.log('== administration: deleting a user is confirmed with your password');
  {
    const listed = async () => (await admin('GET', '/api/admin/users')).body.some((u) => u.id === invited);
    await ap.goto(`${BASE}/admin`); await ap.waitForSelector('.admin-view table');
    await ap.getByRole('button', { name: `Delete ${invited}`, exact: true }).click();
    const confirm = ap.locator('dialog[open]').filter({ has: ap.locator('input[autocomplete=current-password]') });
    const asked = await confirm.waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('Delete asks for the administrator\'s own password, and says what goes', asked && /ALL their files/.test(await confirm.textContent().catch(() => '')));
    if (asked) {
      await confirm.locator('input[autocomplete=current-password]').fill('not-the-password');
      await confirm.locator('footer button[type=submit]').click();
      await ap.waitForFunction(() => /Wrong password/.test(document.querySelector('dialog[open] .error')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
      check('a wrong password is shown in the dialog and nothing is deleted',
        /Wrong password/.test(await confirm.locator('.error').textContent().catch(() => '')) && await listed());
      await confirm.locator('input[autocomplete=current-password]').fill(ADMIN_PW);
      await confirm.locator('footer button[type=submit]').click();
      await ap.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 8000 }).catch(() => {});
      await ap.waitForFunction((name) => ![...document.querySelectorAll('.admin-view tbody tr')].some((r) => r.textContent.includes(name)), invited, { timeout: 5000 }).catch(() => {});
      check('with it, the user is deleted and leaves the list', !(await listed())
        && !(await ap.getByRole('button', { name: `Delete ${invited}`, exact: true }).count()));
    }
  }
  await Promise.all([guest.close(), again.close(), adminCtx.close()]);
  await admin('DELETE', `/api/admin/users/${invited}`, { adminPassword: ADMIN_PW }); // if the dialog did not
}

console.log('== log out');
{
  // Logging out leaves the folder's address: the sign-in page is at "/", and signing in starts at the files.
  await page.goto(`${BASE}/files/${invoices.id}`); await page.waitForSelector('.file-row');
  await page.locator('.avatar-btn').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForSelector('.login-card');
  check('log out goes back to "/" (the folder\'s address does not stay)', new URL(page.url()).pathname === '/', page.url());
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PW);
  await page.locator('button[type=submit]').click();
  await page.waitForSelector('.files-view');
  check('signing in again after log out opens the files', new URL(page.url()).pathname === '/' || new URL(page.url()).pathname === '/files', page.url());
}

check('no errors in the page', errors.length === 0, errors);
await browser.close();
await admin('DELETE', `/api/admin/users/${USER}`, { adminPassword: ADMIN_PW });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
