// Resumable chunked uploads with a progress panel. Works for logged-in users and public links.
import { api, xhrPut, ApiError } from './api.js';
import { h, icon, formatSize, toast } from './ui.js';
import { t } from './i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let panel = null;
let active = 0;

// Closing or reloading the tab ends running uploads: the browser asks first.
window.addEventListener('beforeunload', (e) => { if (active > 0) { e.preventDefault(); e.returnValue = ''; } });

function getPanel() {
  if (panel && document.body.contains(panel)) return panel;
  panel = h('section', { class: 'upload-panel', 'aria-label': t('Uploads') },
    h('header', {}, h('strong', {}, t('Uploads')), h('button', { class: 'icon-btn', 'aria-label': t('Hide'), onclick: () => panel.remove() }, icon('x'))),
    h('ul', {}),
  );
  document.body.append(panel);
  return panel;
}

/**
 * Collects File objects (with relative paths) from a drop event, walking dropped folders.
 * Returns [{ file, path: ['sub', 'dir'] }].
 */
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
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, [...path, entry.name]);
      } while (batch.length);
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
 * target = {
 *   parentId,
 *   startUrl: '/api/uploads' | '/api/public/<token>/uploads',
 *   listChildren(id) -> [{id,name,isDir}],
 *   mkdir(parentId, name) -> {id},
 * }
 */
export async function uploadAll(items, target, onFinished) {
  if (!items.length) return;
  const ul = getPanel().querySelector('ul');
  const folderCache = new Map();

  const folderFor = async (path) => {
    let parent = target.parentId;
    for (let i = 0; i < path.length; i++) {
      const cacheKey = `${parent}/${path[i]}`;
      if (!folderCache.has(cacheKey)) {
        const existing = (await target.listChildren(parent)).find((c) => c.isDir && c.name === path[i]);
        let id = existing?.id;
        if (!id) {
          try {
            id = (await target.mkdir(parent, path[i])).id;
          } catch (e) {
            if (e.status !== 409) throw e;
            id = (await target.listChildren(parent)).find((c) => c.isDir && c.name === path[i]).id;
          }
        }
        folderCache.set(cacheKey, id);
      }
      parent = folderCache.get(cacheKey);
    }
    return parent;
  };

  const rows = items.map(({ file, path }) => {
    const bar = h('progress', { max: 100, value: 0 });
    const status = h('span', { class: 'muted' }, formatSize(file.size));
    const cancel = h('button', { class: 'icon-btn', 'aria-label': t('Cancel upload of {name}', { name: file.name }) }, icon('x'));
    bar.setAttribute('aria-label', file.name);
    const li = h('li', {}, h('div', { class: 'up-name', title: [...path, file.name].join('/') }, file.name), status, cancel, bar);
    ul.prepend(li);
    return { file, path, li, bar, status, cancel, cancelled: false, current: null };
  });

  active += rows.length;
  let failures = 0;
  let cancelled = 0;
  // Every row can be cancelled at once, also those still waiting their turn.
  for (const row of rows) {
    row.cancel.onclick = () => {
      row.cancelled = true;
      row.current?._xhr?.abort();
    };
  }
  for (const row of rows) {
    try {
      if (row.cancelled) throw new ApiError(-1, 'Cancelled');
      const parentId = await folderFor(row.path);
      await uploadOne(row, target.startUrl, parentId);
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
  }
  // Cancelled uploads are what the user asked for, not failures.
  const uploaded = rows.length - failures - cancelled;
  if (failures) toast(t('{n} upload(s) failed', { n: failures }), 'error');
  else if (uploaded) toast(t('Uploaded {n} file(s)', { n: uploaded }));
  if (onFinished) onFinished();
  if (!active) setTimeout(() => { if (!active && panel) panel.querySelectorAll('li.done').forEach((li) => li.remove()); }, 4000);
}

async function uploadOne(row, startUrl, parentId) {
  const { file } = row;
  const session = await api('POST', startUrl, { parentId, name: file.name, size: file.size });
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
      const fatal = e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 408;
      if (fatal || ++errors > 6) throw e;
      row.status.textContent = t('Retrying…');
      await sleep(1000 * 2 ** errors);
      // Still offline? That is one more failed attempt, not the end of the upload.
      try {
        offset = (await api('GET', `/api/uploads/${session.id}`)).received;
      } catch (e2) {
        if (e2.status >= 400 && e2.status < 500 && e2.status !== 408) throw e2;
      }
      continue;
    }
    errors = 0;
    offset = r.received;
    if (r.done) return r.node;
  }
}
