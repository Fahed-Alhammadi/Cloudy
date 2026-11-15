// Browser tests of the web app (Playwright, Chromium), run in CI against the running container:
//   cd tests/web && npm ci && npx playwright install --with-deps chromium && node run.mjs http://localhost:8080 admin <password>
// They drive the real pages the way people use them: upload by button and by dropping files, dropping onto a folder,
// moving with Undo, the Move dialog, selection, sorting, list/grid, the editor, sharing, the trash, right-to-left.
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  await page.getByRole('button', { name: 'List' }).click();
  await page.waitForSelector('table .file-row');
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

  // Contacts take .vcf drops themselves: no "Open a folder" strip there.
  await page.goto(`${BASE}/contacts`); await page.waitForSelector('.contacts-view');
  const cv = await page.locator('.contacts-view').boundingBox();
  await drag('dragEnter', cv.x + 200, cv.y + 100, [path.join(dir, 'receipt.txt')]);
  await drag('dragOver', cv.x + 200, cv.y + 100, [path.join(dir, 'receipt.txt')]);
  await drag('dragOver', cv.x + 201, cv.y + 100, [path.join(dir, 'receipt.txt')]);
  await sleep(200);
  check('dragging onto Contacts shows its own drop area, not the files strip', !(await page.locator('#drop-strip').isVisible()) && (await page.locator('.contacts-view.dragging').count()) === 1);
  await drag('dragCancel', cv.x + 201, cv.y + 100, [path.join(dir, 'receipt.txt')]);

  // Tablets in portrait: calendar, contacts and settings fit beside the sidebar.
  await page.setViewportSize({ width: 800, height: 1000 });
  for (const where of ['/calendar', '/contacts', '/settings']) {
    await page.goto(BASE + where); await sleep(900);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`${where} fits an 800 px tablet`, w <= 800, w);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

console.log('== contacts: unsaved changes');
{
  await page.goto(`${BASE}/`); await page.waitForSelector('.file-row');
  await page.locator('.sidebar a[data-view="contacts"]').click(); await page.waitForSelector('.contacts-view');
  await page.getByRole('button', { name: 'New contact' }).click();
  const field = page.locator('.contacts-view form input[type=text], .contacts-view form input:not([type])').first();
  await field.fill('Half typed');
  // The same page again (its sidebar link): asks; Cancel keeps the text.
  await page.locator('.sidebar a[data-view="contacts"]').click();
  const asked1 = await page.waitForSelector('dialog.modal[open]', { timeout: 3000 }).then(() => true, () => false);
  if (asked1) await page.locator('dialog.modal[open]').getByRole('button', { name: 'Cancel' }).click();
  await sleep(300);
  check('clicking Contacts again with a half-typed contact asks first; Cancel keeps it', asked1 && (await field.inputValue()) === 'Half typed');
  // Back: asks too; staying keeps the text and the address.
  await page.evaluate(() => history.back());
  const asked2 = await page.waitForSelector('dialog.modal[open]', { timeout: 3000 }).then(() => true, () => false);
  if (asked2) await page.locator('dialog.modal[open]').getByRole('button', { name: 'Cancel' }).click();
  await sleep(400);
  check('Back with a half-typed contact asks first; Cancel keeps it and the address',
    asked2 && (await field.inputValue().catch(() => '')) === 'Half typed' && new URL(page.url()).pathname === '/contacts', page.url());
  // Leaving for real.
  await page.locator('.sidebar a[data-view="files"]').click();
  await page.locator('dialog.modal[open]').getByRole('button', { name: 'Discard' }).click();
  await page.waitForSelector('.files-view');
}

console.log('== phone');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/files/${invoices.id}`); await page.waitForSelector('.file-row');
  const meta = await page.locator('.file-row .row-meta').first();
  check('phones show the date under the name (the column is hidden)', await meta.isVisible() && (await meta.innerText()).length > 0, await meta.innerText().catch(() => ''));
  await page.setViewportSize({ width: 1440, height: 900 });
}

console.log('== right to left');
{
  await api('PATCH', '/api/me', { language: 'ar' });
  await page.goto(`${BASE}/settings`); await page.waitForSelector('code');
  const dir = await page.locator('.url-row code').first().getAttribute('dir');
  check('addresses read left to right in Arabic', dir === 'ltr', dir);
  await api('PATCH', '/api/me', { language: null });
}

check('no errors in the page', errors.length === 0, errors);
await browser.close();
await admin('DELETE', `/api/admin/users/${USER}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
