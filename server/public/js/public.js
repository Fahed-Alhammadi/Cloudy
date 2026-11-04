// Public link page (/s/<token>): browse, preview, download and (optionally) upload.
import { get, post } from './api.js';
import { h, icon, fileIcon, formatSize, formatDate, fullDate, showError, promptDialog } from './ui.js';
import { openViewer, kindOf } from './viewer.js';
import { uploadAll, filesFromInput, filesFromDrop } from './upload.js';
import { t, locale, setLanguage, storedLanguage } from './i18n.js';

// Only a real token goes into API paths (a crafted "/s/%2e%2e" would otherwise point them elsewhere).
const rawToken = location.pathname.split('/').pop();
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

// Folders are opened through the URL (#<id>), so the browser's Back button goes up again instead of leaving.
let linkInfo = null;
const openFolder = (id) => {
  const hash = id === linkInfo.node.id ? '' : `#${id}`;
  if (location.hash === hash || (!hash && !location.hash)) showNode(linkInfo, id).catch(showError);
  else location.hash = hash || '#';
};
window.addEventListener('hashchange', () => {
  if (!linkInfo) return;
  const id = Number(location.hash.slice(1)) || linkInfo.node.id;
  showNode(linkInfo, id).catch(() => showNode(linkInfo, linkInfo.node.id).catch(showError));
});

async function showNode(info, id) {
  const data = await get(`${base}/nodes/${id}`);
  const subtitle = t('Shared by {name}', { name: info.ownerName }) + (info.expiresAt ? ' · ' + t('expires {date}', { date: new Date(info.expiresAt).toLocaleDateString(locale()) }) : '');
  if (!data.node.isDir) {
    const kind = kindOf(data.node);
    frame(data.node.name, subtitle, h('div', { class: 'public-file' },
      fileIcon(data.node), h('h2', {}, data.node.name), h('p', { class: 'muted' }, formatSize(data.node.size)),
      h('div', { class: 'row center' },
        kind && h('button', { class: 'btn', onclick: () => openViewer([data.node], 0, { url, canEdit: false }) }, icon('eye'), t('Preview')),
        h('a', { class: 'btn primary', href: url(data.node, false), download: data.node.name }, icon('download'), t('Download')))));
    return;
  }

  // An upload that finishes after the visitor opened another folder must not pull them back here.
  const reload = () => { if ((Number(location.hash.slice(1)) || info.node.id) === id) showNode(info, id).catch(showError); };
  const target = {
    parentId: id,
    startUrl: `${base}/uploads`,
    listChildren: async (pid) => (await get(`${base}/nodes/${pid}`)).children,
    mkdir: (pid, name) => post(`${base}/nodes/${pid}/folders`, { name }),
  };
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { uploadAll(filesFromInput(e.target), target, reload); e.target.value = ''; } });
  const files = data.children.filter((c) => !c.isDir);
  const crumbs = h('nav', { class: 'breadcrumb' }, data.breadcrumb.map((c, i) => [
    i ? h('span', { class: 'sep' }, icon('right')) : null,
    h('button', { class: 'crumb', 'aria-current': c.id === id ? 'location' : null, onclick: () => openFolder(c.id) }, c.name),
  ]));

  const open = (c) => {
    if (c.isDir) openFolder(c.id);
    else openViewer(files, files.indexOf(c), { url, canEdit: false });
  };
  const rows = data.children.map((c) => h('tr', { class: 'file-row', tabindex: 0, onclick: () => open(c),
    // Keyboard users can open rows too (Enter), and move between them with the arrows.
    onkeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter') { e.preventDefault(); open(c); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const to = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
        if (to) { e.preventDefault(); to.focus(); }
      }
    } },
    h('td', { class: 'col-name' }, h('div', { class: 'name-cell' }, fileIcon(c), h('span', { class: 'name', dir: 'auto' }, c.name))),
    h('td', { class: 'col-size' }, formatSize(c.size)),
    h('td', { class: 'col-date', title: fullDate(c.mtime) }, formatDate(c.mtime)),
    h('td', { class: 'col-actions' }, h('a', { class: 'icon-btn', href: url(c, false), download: c.name, 'aria-label': t('Download {name}', { name: c.name }), onclick: (e) => e.stopPropagation() }, icon('download'))),
  ));

  const view = h('section', { class: 'files-view', 'data-drop-label': t('Drop to upload') },
    h('div', { class: 'toolbar' }, crumbs, h('div', { class: 'grow' }),
      info.canEdit && h('button', { class: 'btn', onclick: async () => {
        const name = await promptDialog(t('New folder'), t('Folder name'), t('New folder'), t('Create'));
        if (name) await post(`${base}/nodes/${id}/folders`, { name }).then(reload, showError);
      } }, icon('folderPlus'), t('New folder')),
      info.canEdit && h('button', { class: 'btn', onclick: () => fileInput.click() }, icon('upload'), t('Upload')),
      fileInput,
      h('a', { class: 'btn primary', href: url(data.node, false), download: '' }, icon('download'), t('Download all'))),
    rows.length
      ? h('table', { class: 'file-table' }, h('thead', {}, h('tr', {}, h('th', { class: 'col-name' }, t('Name')), h('th', { class: 'col-size' }, t('Size')), h('th', { class: 'col-date' }, t('Modified')), h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, t('Actions'))))), h('tbody', {}, rows))
      : h('div', { class: 'empty' }, icon('folder'), h('p', {}, info.canEdit ? t('Empty folder — drop files here to upload') : t('Empty folder'))),
  );
  if (info.canEdit) {
    view.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); view.classList.add('dragging'); } });
    view.addEventListener('dragleave', (e) => { if (!view.contains(e.relatedTarget)) view.classList.remove('dragging'); });
    view.addEventListener('drop', async (e) => {
      view.classList.remove('dragging');
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      uploadAll(await filesFromDrop(e.dataTransfer), target, reload);
    });
  }
  frame(info.node.name, subtitle, view);
}

async function start() {
  try {
    if (!token) throw new Error('Not found');
    const info = await get(base);
    if (info.needsPassword) return passwordForm();
    linkInfo = info;
    document.title = `${info.node.name} – Cloudy`;
    const first = Number(location.hash.slice(1)) || info.node.id;
    await showNode(info, first).catch(() => showNode(info, info.node.id));
  } catch (e) {
    frame(t('Link unavailable'), null, h('div', { class: 'empty' }, icon('link'), h('p', {}, t(e.message))));
  }
}

await setLanguage(storedLanguage());
start();
