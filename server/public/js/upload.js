// Resumable chunked uploads with a progress panel. Works for logged-in users and public links.
import { api, xhrPut, ApiError } from './api.js';
import { h, icon, formatSize, toast, modal } from './ui.js';
import { t } from './i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let panel = null;
let active = 0;
let totals = { done: 0, all: 0 };

// Bumped when uploads are stopped at sign-out: the batches that were running then end without a closing message.
let generation = 0;

// Closing or reloading the tab ends running uploads: the browser asks first.
window.addEventListener('beforeunload', (e) => { if (active > 0) { e.preventDefault(); e.returnValue = ''; } });

/** Whether files are still going up (signing out asks first). */
export const uploadsRunning = () => active > 0;

/** Signing out: every running upload stops, and the panel goes (it stayed on the sign-in page). */
export function stopAllUploads() {
  if (!panel) return;
  generation++;
  panel.querySelectorAll('.up-cancel').forEach((b) => b.click());
  panel.remove();
  panel = null;
}

/**
 * The panel: one row per file in the order they go up (the running one is kept in view), a line saying where they
 * go, and a header with the overall count. "Hide" folds it into a small bar that opens it again (it used to remove
 * the panel, and with it every way to see or cancel the running uploads). It goes away once nothing is left in it.
 */
function getPanel() {
  if (panel?.isConnected) return panel;
  const count = h('span', { class: 'up-count' });
  const list = h('ul', {});
  const fold = h('button', { class: 'icon-btn', 'aria-label': t('Hide'), 'aria-expanded': 'true', onclick: () => setFolded(!panel.classList.contains('folded')) }, icon('down'));
  const cancelAll = h('button', { class: 'btn ghost small-btn', hidden: true, onclick: () => panel.querySelectorAll('li:not(.done):not(.failed):not(.cancelled) .up-cancel').forEach((b) => b.click()) }, t('Cancel all'));
  panel = h('section', { class: 'upload-panel', 'aria-label': t('Uploads') },
    h('header', { onclick: (e) => { if (panel.classList.contains('folded') && !e.target.closest('button')) setFolded(false); } },
      h('strong', {}, t('Uploads')), count, h('div', { class: 'grow' }), cancelAll, fold,
      h('button', { class: 'icon-btn', 'aria-label': t('Close'), onclick: () => { if (active) setFolded(true); else panel.remove(); } }, icon('x'))),
    list);
  panel.updateCount = () => {
    count.textContent = active ? t('{done} of {all}', { done: totals.done, all: totals.all }) : t('Done');
    cancelAll.hidden = !active;
  };
  const setFolded = (folded) => {
    panel.classList.toggle('folded', folded);
    fold.setAttribute('aria-expanded', String(!folded));
    fold.setAttribute('aria-label', folded ? t('Show') : t('Hide'));
    fold.replaceChildren(icon(folded ? 'up' : 'down'));
  };
  document.body.append(panel);
  return panel;
}

/** Collects File objects (with relative paths) from a drop event, walking dropped folders. Returns [{ file, path }]. */
export async function filesFromDrop(dataTransfer) {
  const out = [];
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, path: [] }));
  const walk = async (entry, path) => {
    if (entry.isFile) {
      out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), path });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      let any = false;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) { any = true; await walk(e, [...path, entry.name]); }
      } while (batch.length);
      // An empty folder is created too (it used to be left out).
      if (!any) out.push({ folder: true, path: [...path, entry.name] });
    }
  };
  for (const e of entries) await walk(e, []);
  return out;
}

export function filesFromInput(input) {
  return [...input.files].map((file) => ({
    file,
    path: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1) : [],
  }));
}

/**
 * Before anything is sent: items whose name is already taken in the destination folder (a file or a dropped folder
 * at the top). One question for all of them: replace (the old file is kept under Versions; a folder is merged), keep
 * both (the new one gets "name (2)"), or skip them. Returns 'replace' | 'keep' | 'skip', or null to cancel.
 */
async function askConflicts(items, existing) {
  const taken = new Map(existing.map((c) => [c.name, c]));
  const names = [...new Set(items.map((it) => it.path[0] ?? it.file?.name).filter((n) => n && taken.has(n)))];
  if (!names.length) return 'replace';
  const list = h('ul', { class: 'plain-list conflict-list' }, names.slice(0, 6).map((n) => h('li', {}, icon(taken.get(n).isDir ? 'folder' : 'file'), h('span', { class: 'grow', dir: 'auto' }, n))),
    names.length > 6 && h('li', { class: 'muted' }, t('and {n} more', { n: names.length - 6 })));
  return modal({
    title: names.length === 1 ? t('"{name}" already exists', { name: names[0] }) : t('{n} items already exist', { n: names.length }),
    body: h('div', {}, h('p', {}, t('What should happen to the items that are already in this folder?')), list,
      h('p', { class: 'muted small' }, t('Replaced files keep their old content under Versions. Folders with the same name are merged.'))),
    buttons: [
      { label: t('Cancel'), value: null },
      { label: t('Skip them'), value: 'skip' },
      { label: t('Keep both'), value: 'keep' },
      { label: t('Replace'), value: 'replace', primary: true },
    ],
  });
}

/** "name (2).ext", the first one not in `names`. */
function freeName(name, names) {
  if (!names.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) if (!names.has(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
}

/**
 * target = {
 *   parentId,
 *   startUrl: '/api/uploads' | '/api/public/<token>/uploads',
 *   listChildren(id) -> [{id,name,isDir}],
 *   mkdir(parentId, name) -> {id},
 *   askConflicts: false for public links (their uploads never replace anything)
 * }
 * info = { dest: {id, name}, isOnScreen(), onShow() }: where the files go, for the panel and the closing message.
 */
export async function uploadAll(items, target, onFinished, info = {}) {
  if (!items.length) return;
  // Same names: ask once (signed-in uploads only; public-link visitors' files are always renamed by the server).
  let onConflict = 'replace';
  const renameTop = new Map();
  if (target.askConflicts !== false) {
    const existing = await target.listChildren(target.parentId).catch(() => []);
    const choice = await askConflicts(items, existing);
    if (!choice) return;
    onConflict = choice;
    const names = new Set(existing.map((c) => c.name));
    if (choice === 'skip') items = items.filter((it) => !names.has(it.path[0] ?? it.file?.name));
    if (choice === 'keep') {
      // Dropped folders whose name is taken go into a new "Folder (2)"; files get renamed by the server.
      for (const it of items) {
        const top = it.path[0];
        if (top !== undefined && names.has(top) && !renameTop.has(top)) {
          const fresh = freeName(top, names);
          names.add(fresh);
          renameTop.set(top, fresh);
        }
      }
      items = items.map((it) => (it.path.length && renameTop.has(it.path[0]) ? { ...it, path: [renameTop.get(it.path[0]), ...it.path.slice(1)] } : it));
    }
    if (!items.length) return;
  }
  const p = getPanel();
  const ul = p.querySelector('ul');
  const folderCache = new Map();
  const gen = generation;

  const folderFor = async (path) => {
    let parent = target.parentId;
    for (let i = 0; i < path.length; i++) {
      const cacheKey = `${parent}/${path[i]}`;
      if (!folderCache.has(cacheKey)) {
        const found = (await target.listChildren(parent)).find((c) => c.name === path[i]);
        let id = found?.isDir ? found.id : undefined;
        // A file has the folder's name: the server would refuse the folder; say so in that row (it used to fail with
        // "Cannot read properties of undefined").
        if (found && !found.isDir) throw new ApiError(409, t('A file named "{name}" is in the way', { name: path[i] }));
        if (!id) {
          try {
            id = (await target.mkdir(parent, path[i])).id;
          } catch (e) {
            if (e.status !== 409) throw e;
            const again = (await target.listChildren(parent)).find((c) => c.isDir && c.name === path[i]);
            if (!again) throw e;
            id = again.id;
          }
        }
        folderCache.set(cacheKey, id);
      }
      parent = folderCache.get(cacheKey);
    }
    return parent;
  };

  if (info.dest) ul.append(h('li', { class: 'up-dest' }, icon('folder'), h('span', { dir: 'auto' }, t('To {folder}', { folder: info.dest.name }))));
  const rows = items.map((item) => {
    if (item.folder) return { ...item, folderOnly: true };
    const { file, path } = item;
    const bar = h('progress', { max: 100, value: 0 });
    const status = h('span', { class: 'muted' }, formatSize(file.size));
    const cancel = h('button', { class: 'icon-btn up-cancel', 'aria-label': t('Cancel upload of {name}', { name: file.name }) }, icon('x'));
    bar.setAttribute('aria-label', file.name);
    const li = h('li', {}, h('div', { class: 'up-name', title: [...path, file.name].join('/'), dir: 'auto' }, file.name), status, cancel, bar);
    ul.append(li);
    return { file, path, li, bar, status, cancel, cancelled: false, current: null };
  });
  const uploads = rows.filter((r) => !r.folderOnly);

  active += uploads.length;
  totals.all += uploads.length;
  p.updateCount();
  let failures = 0;
  let cancelled = 0;
  for (const row of uploads) {
    row.cancel.onclick = () => {
      row.cancelled = true;
      row.current?._xhr?.abort();
    };
  }
  // Empty folders from a drop.
  for (const row of rows.filter((r) => r.folderOnly)) await folderFor(row.path).catch(() => {});
  for (const row of uploads) {
    row.li.scrollIntoView({ block: 'nearest' });
    try {
      if (row.cancelled) throw new ApiError(-1, 'Cancelled');
      const parentId = await folderFor(row.path);
      // Keep both: only the top level asked; files inside a dropped folder that is merged are replaced as usual.
      const conflict = onConflict === 'keep' && row.path.length === 0 ? 'rename' : undefined;
      await uploadOne(row, target.startUrl, parentId, target.listChildren, conflict);
      row.bar.value = 100;
      row.status.textContent = t('Done');
      row.li.classList.add('done');
      row.cancel.remove();
    } catch (e) {
      if (row.cancelled) {
        cancelled++;
        row.li.classList.add('cancelled');
        row.status.textContent = t('Cancelled');
      } else {
        failures++;
        row.li.classList.add('failed');
        row.status.textContent = t(e.message);
      }
      row.cancel.remove();
    }
    active--;
    totals.done++;
    p.updateCount();
  }
  if (!active) totals = { done: 0, all: 0 };
  if (gen !== generation) return; // stopped at sign-out
  // Cancelled uploads are what the user asked for, not failures.
  const uploaded = uploads.length - failures - cancelled;
  if (failures) toast(t('{n} upload(s) failed', { n: failures }), 'error');
  else if (uploaded) {
    toast(info.dest ? t('Uploaded {n} file(s) to {folder}', { n: uploaded, folder: info.dest.name }) : t('Uploaded {n} file(s)', { n: uploaded }), 'info',
      info.dest && info.onShow && !info.isOnScreen?.() ? { label: t('Show'), onclick: info.onShow } : undefined);
  }
  if (onFinished) onFinished();
  // Finished rows go after a while; the panel goes with its last row (failed ones stay until closed).
  if (!active) {
    setTimeout(() => {
      if (active || !panel) return;
      panel.querySelectorAll('li.done, li.cancelled, li.up-dest').forEach((li) => li.remove());
      if (!panel.querySelector('li')) panel.remove();
      else panel.updateCount();
    }, 4000);
  }
}

async function uploadOne(row, startUrl, parentId, listChildren, onConflict) {
  const { file } = row;
  const session = await api('POST', startUrl, { parentId, name: file.name, size: file.size, ...(onConflict ? { onConflict } : {}) });
  let offset = 0;
  let errors = 0;
  for (;;) {
    if (row.cancelled) {
      await api('DELETE', `/api/uploads/${session.id}`).catch(() => {});
      throw new ApiError(-1, 'Cancelled');
    }
    const chunk = file.slice(offset, offset + session.chunkSize);
    row.current = chunk;
    let r;
    try {
      r = await xhrPut(`/api/uploads/${session.id}`, chunk, { 'Upload-Offset': String(offset) }, (loaded) => {
        const pct = file.size ? ((offset + loaded) / file.size) * 100 : 100;
        row.bar.value = pct;
        row.status.textContent = `${formatSize(offset + loaded)} / ${formatSize(file.size)}`;
      });
    } catch (e) {
      if (row.cancelled) continue;
      // Final answers from Cloudy end the upload (a deleted folder, a full quota, a name taken by a folder…); only a
      // lost answer, a proxy's 502–504, "Offset mismatch" and "Chunk already in progress" are tried again.
      const resumable = e.status === 409 && /Offset mismatch|Chunk already in progress/.test(e.message);
      const final = e.status === 507 || (e.status >= 400 && e.status < 500 && e.status !== 408 && !resumable);
      if (final || ++errors > 6) throw e;
      const noAnswer = [0, 408, 502, 503, 504].includes(e.status);
      row.status.textContent = t('Retrying…');
      await sleep(1000 * 2 ** errors);
      // Still offline? That is one more failed attempt, not the end of the upload.
      try {
        offset = (await api('GET', `/api/uploads/${session.id}`)).received;
      } catch (e2) {
        // The answer to the last chunk was lost and the upload is gone: the server finishes an upload by removing
        // it, so the file may well be stored. It counts as done only when it is there with its size (a failure
        // that also removes the upload, such as a deleted folder, is not reported as done).
        if (e2.status === 404 && noAnswer && offset + chunk.size >= file.size) {
          const name = session.name ?? file.name;
          const there = await listChildren?.(parentId).then((list) => list.some((c) => c.name === name && !c.isDir && c.size === file.size), () => false);
          if (there) return null;
        }
        if (e2.status >= 400 && e2.status < 500 && e2.status !== 408) throw e2;
      }
      continue;
    }
    errors = 0;
    offset = r.received;
    if (r.done) return r.node;
  }
}
