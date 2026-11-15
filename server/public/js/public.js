// Public link page (/s/<token>, its folders /s/<token>/<id>): browse, preview, download and (optionally) upload.
import { get, post } from './api.js';
import { h, icon, fileIcon, formatSize, formatDate, fullDate, showError, promptDialog } from './ui.js';
import { viewPrefs, chooseSort, setView, sortItems, tileArt } from './listprefs.js';
import { openViewer, kindOf, consumeViewerBack } from './viewer.js';
import { uploadAll, filesFromInput, filesFromDrop } from './upload.js';
import { t, locale, setLanguage, storedLanguage } from './i18n.js';

// Only a real token goes into API paths (a crafted "/s/%2e%2e" would otherwise point them elsewhere).
const rawToken = location.pathname.split('/')[2] ?? '';
const token = /^[\w-]+$/.test(rawToken) ? rawToken : '';
const base = `/api/public/${encodeURIComponent(token)}`;
const app = document.getElementById('app');
const url = (node, inline) => `${base}/nodes/${node.id}/download${inline ? '?inline' : ''}`;

function frame(title, subtitle, ...content) {
  app.replaceChildren(
    h('header', { class: 'topbar' }, h('span', { class: 'brand' }, h('img', { class: 'mark', src: '/favicon.svg', alt: '', width: 26, height: 26 }), 'Cloudy'),
      h('div', { class: 'public-title' }, h('strong', {}, title), subtitle && h('small', { class: 'muted' }, subtitle))),
    h('main', { class: 'content public' }, ...content),
  );
}

function passwordForm() {
  dropHere = null; // files dropped on the password form went to the folder shown before (and failed)
  document.title = `${t('Protected link')} – Cloudy`;
  const pw = h('input', { type: 'password', required: true, autofocus: true, autocomplete: 'current-password', 'aria-label': t('Password') });
  const err = h('p', { class: 'error', role: 'alert' });
  app.replaceChildren(h('main', { class: 'login' }, h('form', { class: 'login-card', onsubmit: async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await post(`${base}/auth`, { password: pw.value });
      start();
    } catch (ex) {
      err.textContent = t(ex.message);
      btn.disabled = false;
      pw.select();
    }
  } },
    h('div', { class: 'brand big' }, icon('lock'), t('Protected link')),
    h('label', { class: 'field' }, h('span', {}, t('This share is password protected')), pw), err,
    h('button', { class: 'btn primary block', type: 'submit' }, t('Open')))));
  pw.focus();
}

// Folders get their own address (/s/<token>/<id>), so the browser's Back button goes up again instead of leaving.
let linkInfo = null;
const folderPath = (id) => `/s/${token}` + (id === linkInfo.node.id ? '' : `/${id}`);
const shownFolder = () => Number(location.pathname.split('/')[3]) || linkInfo.node.id;
const openFolder = (id) => {
  if (location.pathname !== folderPath(id)) history.pushState(null, '', folderPath(id));
  showNode(linkInfo, id).catch(showError);
};
const showTop = () => {
  history.replaceState(null, '', folderPath(linkInfo.node.id));
  return showNode(linkInfo, linkInfo.node.id);
};
window.addEventListener('popstate', () => {
  if (consumeViewerBack()) return; // Back closed the viewer
  if (linkInfo) showNode(linkInfo, shownFolder()).catch(() => showTop().catch(showError));
});
// Before 1.18 a folder's address was /s/<token>#<id>: such links open the folder at its own address.
const fromOldAddress = () => {
  const old = /^#(\d+)$/.exec(location.hash);
  if (old) history.replaceState(null, '', folderPath(Number(old[1])));
  return !!old;
};
window.addEventListener('hashchange', () => {
  if (linkInfo && fromOldAddress()) showNode(linkInfo, shownFolder()).catch(() => showTop().catch(showError));
});

/** A request that needs the link's password (it was set while this page was open): ask for it. */
const needsPassword = (e) => e?.status === 401;

async function showNode(info, id) {
  let data;
  try {
    data = await get(`${base}/nodes/${id}`);
  } catch (e) {
    if (needsPassword(e)) return passwordForm();
    throw e;
  }
  const subtitle = t('Shared by {name}', { name: info.ownerName }) + (info.expiresAt ? ' · ' + t('expires {date}', { date: new Date(info.expiresAt).toLocaleDateString(locale()) }) : '');
  const thumb = info.thumbnails ? (c) => `${base}/nodes/${c.id}/thumb?v=${encodeURIComponent(c.etag || c.mtime)}` : null;
  if (!data.node.isDir) {
    const kind = kindOf(data.node);
    // A shared picture is shown at once (it used to be an icon until "Preview" was clicked).
    const picture = kind === 'image' && h('img', { class: 'public-picture', src: url(data.node, true), alt: data.node.name });
    frame(data.node.name, subtitle, h('div', { class: 'public-file' },
      picture || fileIcon(data.node), h('h2', { dir: 'auto' }, data.node.name), h('p', { class: 'muted' }, formatSize(data.node.size)),
      h('div', { class: 'row center' },
        kind && h('button', { class: 'btn', onclick: () => openViewer([data.node], 0, { url, canEdit: false }) }, icon('eye'), picture ? t('Full screen') : t('Preview')),
        h('a', { class: 'btn primary', href: url(data.node, false), download: data.node.name }, icon('download'), t('Download')))));
    return;
  }

  // An upload that finishes after the visitor opened another folder must not pull them back here.
  const reload = () => { if (shownFolder() === id) showNode(info, id).catch(showError); };
  const target = {
    parentId: id,
    startUrl: `${base}/uploads`,
    listChildren: async (pid) => (await get(`${base}/nodes/${pid}`)).children,
    mkdir: (pid, name) => post(`${base}/nodes/${pid}/folders`, { name }),
    askConflicts: false, // visitors never replace files: the server stores theirs as "name (2)"
  };
  const here = { id, name: data.node.name };
  const upload = (items) => uploadAll(items, target, reload, { dest: here });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { upload(filesFromInput(e.target)); e.target.value = ''; } });
  const look = viewPrefs();
  const items = sortItems(data.children, look);
  const files = items.filter((c) => !c.isDir);
  const crumbs = h('nav', { class: 'breadcrumb' }, data.breadcrumb.map((c, i) => [
    i ? h('span', { class: 'sep' }, icon('right')) : null,
    h('button', { class: 'crumb', dir: 'auto', 'aria-current': c.id === id ? 'location' : null, onclick: () => openFolder(c.id) }, c.name),
  ]));

  const open = (c) => {
    if (c.isDir) openFolder(c.id);
    else openViewer(files, files.indexOf(c), { url, canEdit: false });
  };
  const keys = (c) => (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') { e.preventDefault(); open(c); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const to = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
      if (to) { e.preventDefault(); to.focus(); }
    }
  };
  const download = (c) => h('a', { class: 'icon-btn', href: url(c, false), download: c.name, 'aria-label': t('Download {name}', { name: c.name }), onclick: (e) => e.stopPropagation() }, icon('download'));
  const resort = (key) => { chooseSort(look, key); reload(); };
  const th = (key, label, cls) => {
    const on = look.key === key;
    return h('th', { class: cls, 'aria-sort': on ? (look.desc ? 'descending' : 'ascending') : null },
      h('button', { type: 'button', class: 'th-sort', onclick: () => resort(key) }, label, icon(on ? (look.desc ? 'down' : 'up') : 'blank')));
  };
  let list;
  if (!items.length) {
    list = h('div', { class: 'empty' }, icon('folder'), h('p', {}, info.canEdit ? t('Empty folder — drop files here to upload') : t('Empty folder')));
  } else if (look.view === 'grid') {
    const tile = (c) => (c.isDir
      ? h('div', { class: 'file-row tile folder', tabindex: 0, role: 'listitem', onclick: () => open(c), onkeydown: keys(c) }, fileIcon(c), h('span', { class: 'tile-name', dir: 'auto' }, c.name))
      : h('div', { class: 'file-row tile', tabindex: 0, role: 'listitem', onclick: () => open(c), onkeydown: keys(c) }, tileArt(c, thumb),
          h('div', { class: 'tile-name', dir: 'auto', title: c.name }, c.name),
          h('div', { class: 'tile-meta' }, h('span', {}, formatSize(c.size)), h('span', { title: fullDate(c.mtime) }, formatDate(c.mtime))),
          h('div', { class: 'tile-more' }, download(c))));
    const dirs = items.filter((c) => c.isDir);
    list = h('div', { class: 'file-tiles', role: 'list' },
      dirs.length && h('div', { class: 'file-grid folders' }, dirs.map(tile)),
      files.length && h('div', { class: 'file-grid' }, files.map(tile)));
  } else {
    list = h('table', { class: 'file-table' },
      h('thead', {}, h('tr', {}, th('name', t('Name'), 'col-name'), th('size', t('Size'), 'col-size'), th('mtime', t('Modified'), 'col-date'), h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, t('Actions'))))),
      h('tbody', {}, items.map((c) => h('tr', { class: 'file-row', tabindex: 0, onclick: () => open(c), onkeydown: keys(c) },
        h('td', { class: 'col-name' }, h('div', { class: 'name-cell' }, fileIcon(c), h('span', { class: 'name', dir: 'auto' }, c.name))),
        h('td', { class: 'col-size' }, formatSize(c.size)),
        h('td', { class: 'col-date', title: fullDate(c.mtime) }, formatDate(c.mtime)),
        h('td', { class: 'col-actions' }, download(c))))));
  }
  const viewBtn = (v, label, ic) => h('button', { type: 'button', 'aria-pressed': String(look.view === v), 'aria-label': label, title: label,
    onclick: () => { if (look.view !== v) { setView(v); reload(); } } }, icon(ic));

  const view = h('section', { class: 'files-view', 'data-drop-label': t('Drop to upload') },
    h('div', { class: 'toolbar' }, crumbs, h('div', { class: 'grow' }),
      items.length > 0 && h('div', { class: 'seg', role: 'group', 'aria-label': t('View') }, viewBtn('list', t('List'), 'list'), viewBtn('grid', t('Grid'), 'grid')),
      info.canEdit && h('button', { class: 'btn', onclick: async () => {
        const name = await promptDialog(t('New folder'), t('Folder name'), t('New folder'), t('Create'));
        if (name) await post(`${base}/nodes/${id}/folders`, { name }).then(reload, showError);
      } }, icon('folderPlus'), h('span', { class: 'btn-label' }, t('New folder'))),
      info.canEdit && h('button', { class: 'btn', onclick: () => fileInput.click() }, icon('upload'), h('span', { class: 'btn-label' }, t('Upload'))),
      fileInput,
      h('a', { class: 'btn primary', href: url(data.node, false), download: '' }, icon('download'), h('span', { class: 'btn-label' }, t('Download all')))),
    list,
  );
  dropHere = info.canEdit ? { view, upload } : null;
  frame(info.node.name, subtitle, view);
}

// Files dragged anywhere onto the page go into the folder on screen when the link allows uploads; otherwise the drop is
// ignored (the browser used to open the dropped file and leave the page).
let dropHere = null;
let dragDepth = 0;
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = dropHere && !document.querySelector('dialog[open]') ? 'copy' : 'none';
});
window.addEventListener('dragenter', (e) => { if (hasFiles(e) && dropHere) { dragDepth++; dropHere.view.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (dropHere && --dragDepth <= 0) { dragDepth = 0; dropHere.view.classList.remove('dragging'); } });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropHere?.view.classList.remove('dragging');
  if (!dropHere || !dropHere.view.isConnected || document.querySelector('dialog[open]')) return;
  const { upload } = dropHere;
  upload(await filesFromDrop(e.dataTransfer));
});

async function start() {
  try {
    if (!token) throw new Error('Not found');
    const info = await get(base);
    if (info.needsPassword) return passwordForm();
    linkInfo = info;
    document.title = `${info.node.name} – Cloudy`;
    fromOldAddress();
    await showNode(info, shownFolder()).catch(showTop);
  } catch (e) {
    document.title = `${t('Link unavailable')} – Cloudy`;
    frame(t('Link unavailable'), null, h('div', { class: 'empty' }, icon('link'), h('p', {}, t(e.message))));
  }
}

await setLanguage(storedLanguage());
start();
