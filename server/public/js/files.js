// Files app: folder browser, special lists (recent, favorites, shares, search, trash) and dialogs.
import { get, post, patch, del, api } from './api.js';
import {
  h, icon, fileIcon, formatSize, formatDate, fullDate, toast, showError, modal, confirmDialog,
  promptDialog, showMenu, copyText,
} from './ui.js';
import { openViewer, kindOf } from './viewer.js';
import { isOfficeFile, officePreviewUrl } from './office.js';
import { uploadAll, filesFromDrop, filesFromInput } from './upload.js';
import { t } from './i18n.js';

const nodeUrl = (node, inline) => `/api/nodes/${node.id}/download${inline ? '?inline' : ''}`;

export function userUploadTarget(parentId) {
  return {
    parentId,
    startUrl: '/api/uploads',
    listChildren: async (id) => (await get(`/api/nodes/${id}`)).children,
    mkdir: (id, name) => post(`/api/nodes/${id}/folders`, { name }),
  };
}

// ---------------------------------------------------------------- generic list

/**
 * Renders a file table.
 * opts: { items, me, canModify(item), onOpen(item), extraColumn?: {title, render(item)},
 *         reload(), dropTargetId?, emptyText, selectable }
 */
function fileTable(opts) {
  const selected = new Set();
  const rows = new Map(); // id → { tr, box }
  const bar = h('div', { class: 'selection-bar', hidden: true });
  const tbody = h('tbody');
  const allBox = h('input', { type: 'checkbox', 'aria-label': t('Select all') });
  let table;

  // Multi-select, the same as in the apps: "Select" in a file's menu (long-press on touch screens), then clicking
  // rows ticks them, and the bar acts on all of them.
  const setSelected = (item, on) => {
    on ? selected.add(item.id) : selected.delete(item.id);
    const r = rows.get(item.id);
    if (r) { r.box.checked = on; r.tr.classList.toggle('selected', on); }
  };
  const menuFor = (item) => [
    { label: t('Select'), icon: 'check', onclick: () => { setSelected(item, true); updateBar(); } },
    '-',
    ...nodeActions(item, opts),
  ];

  // Bar buttons are disabled while their requests run (one call per file, as in the apps).
  const busy = (fn) => async (e) => {
    const buttons = [...bar.querySelectorAll('button')];
    buttons.forEach((b) => { b.disabled = true; });
    try { await fn(e); } finally { buttons.forEach((b) => { b.disabled = false; }); }
  };
  const updateBar = () => {
    bar.hidden = selected.size === 0;
    table?.classList.toggle('selecting', selected.size > 0);
    allBox.checked = selected.size > 0 && selected.size === opts.items.length;
    const chosen = opts.items.filter((i) => selected.has(i.id));
    bar.replaceChildren(
      h('button', { class: 'icon-btn', 'aria-label': t('Clear selection'), title: t('Clear selection'), onclick: () => {
        for (const it of chosen) setSelected(it, false);
        updateBar();
      } }, icon('x')),
      h('span', { 'aria-live': 'polite' }, t('{n} selected', { n: selected.size })),
      h('button', { class: 'btn ghost', onclick: () => {
        for (const it of opts.items.filter((i) => selected.has(i.id))) triggerDownload(nodeUrl(it, false), it.name + (it.isDir ? '.zip' : ''));
      } }, icon('download'), t('Download')),
      chosen.some((i) => !i.favorite) && h('button', { class: 'btn ghost', onclick: busy(async () => {
        for (const it of chosen.filter((i) => !i.favorite)) await post(`/api/nodes/${it.id}/favorite`).catch(showError);
        opts.reload();
      }) }, icon('star'), t('Add to favorites')),
      opts.items.some((i) => selected.has(i.id) && opts.canModify(i)) && h('button', { class: 'btn ghost', onclick: busy(() => moveCopy(opts.items.filter((i) => selected.has(i.id)), opts)) }, icon('move'), t('Move or copy')),
      opts.items.some((i) => selected.has(i.id) && opts.canModify(i)) && h('button', { class: 'btn ghost danger', onclick: busy(async () => {
        const list = opts.items.filter((i) => selected.has(i.id) && opts.canModify(i));
        if (!(await confirmDialog(t('Delete items'), t('Move {n} item(s) to the trash?', { n: list.length }), t('Delete'), true))) return;
        let failed = 0;
        for (const it of list) await del(`/api/nodes/${it.id}`).catch((e) => { failed++; showError(e); });
        if (list.length > failed) toast(t('{n} item(s) moved to trash', { n: list.length - failed }));
        opts.reload();
      }) }, icon('trash'), t('Delete')),
    );
  };
  allBox.addEventListener('change', () => {
    for (const it of opts.items) setSelected(it, allBox.checked);
    updateBar();
  });

  for (const item of opts.items) {
    const box = h('input', { type: 'checkbox', 'aria-label': t('Select {name}', { name: item.name }), onclick: (e) => e.stopPropagation(), onchange: (e) => {
      setSelected(item, e.target.checked);
      updateBar();
    } });
    const more = h('button', { class: 'icon-btn', 'aria-haspopup': 'menu', 'aria-label': t('Actions for {name}', { name: item.name }), onclick: (e) => {
      e.stopPropagation();
      showMenu(e.currentTarget, menuFor(item));
    } }, icon('more'));
    // Long-press on touch screens opens the menu (iOS Safari has no contextmenu event; Android Chrome fires one
    // too, so a press shows the menu only once). Some browsers send a click when the finger lifts: it is swallowed
    // before the page's "click outside closes the menu" handler sees it.
    let pressTimer = null;
    let pressStart = null;
    let pressMenuShown = false;
    const pressMenu = (x, y) => {
      if (pressMenuShown) return;
      pressMenuShown = true;
      navigator.vibrate?.(10);
      showMenu({ x, y }, menuFor(item));
    };
    const tr = h('tr', {
      class: 'file-row', tabindex: 0, 'data-key': `node-${item.id}`, draggable: opts.canModify(item) ? 'true' : null,
      onclick: () => {
        if (selected.size > 0) { setSelected(item, !selected.has(item.id)); updateBar(); return; }
        opts.onOpen(item);
      },
      // Keys on the row's checkbox or ⋯ button belong to them (Enter on ⋯ used to open the file as well).
      // Enter opens (toggles while selecting), Space ticks, arrows move between rows.
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selected.size > 0 || e.key === ' ') { setSelected(item, !selected.has(item.id)); updateBar(); }
          else opts.onOpen(item);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const to = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
          if (to) { e.preventDefault(); to.focus(); }
        }
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        clearTimeout(pressTimer);
        if (pressStart) pressMenu(e.clientX, e.clientY);
        else showMenu({ x: e.clientX, y: e.clientY }, menuFor(item));
      },
      onpointerdown: (e) => {
        if (e.pointerType !== 'touch') return;
        pressMenuShown = false;
        pressStart = { x: e.clientX, y: e.clientY };
        pressTimer = setTimeout(() => pressMenu(pressStart.x, pressStart.y), 500);
      },
      onpointermove: (e) => {
        if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) { clearTimeout(pressTimer); pressStart = null; }
      },
      onpointerup: () => {
        clearTimeout(pressTimer);
        pressStart = null;
        if (!pressMenuShown) return;
        pressMenuShown = false;
        const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, true), 500);
      },
      onpointercancel: () => { clearTimeout(pressTimer); pressStart = null; },
    },
      h('td', { class: 'col-check' }, box),
      h('td', { class: 'col-name' },
        h('div', { class: 'name-cell' }, fileIcon(item),
          h('span', { class: 'name', title: item.name, dir: 'auto' }, item.name),
          item.favorite && icon('star', 'badge fav'),
          item.shared && icon('share', 'badge'),
        )),
      opts.extraColumn ? h('td', { class: 'col-extra' }, opts.extraColumn.render(item)) : null,
      h('td', { class: 'col-size' }, formatSize(item.size)),
      h('td', { class: 'col-date', title: fullDate(item.mtime) }, formatDate(item.mtime)),
      h('td', { class: 'col-actions' }, more),
    );
    // Drag rows onto folders to move them.
    tr.addEventListener('dragstart', (e) => {
      const ids = selected.has(item.id) ? [...selected] : [item.id];
      e.dataTransfer.setData('application/x-cloudy', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    });
    if (item.isDir) {
      const filesOver = (e) => opts.uploadInto && e.dataTransfer.types.includes('Files');
      tr.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-cloudy') || filesOver(e)) { e.preventDefault(); tr.classList.add('drop-target'); }
      });
      tr.addEventListener('dragleave', () => tr.classList.remove('drop-target'));
      tr.addEventListener('drop', async (e) => {
        tr.classList.remove('drop-target');
        // Files from the computer dropped on a folder go into that folder (the view's drop zone sees defaultPrevented).
        if (filesOver(e)) {
          e.preventDefault();
          opts.uploadInto(item, await filesFromDrop(e.dataTransfer));
          return;
        }
        const raw = e.dataTransfer.getData('application/x-cloudy');
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        await moveByDrop(JSON.parse(raw), item.id);
        opts.reload();
      });
    }
    tbody.append(tr);
    rows.set(item.id, { tr, box });
  }

  table = h('table', { class: 'file-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'col-check' }, allBox),
      h('th', { class: 'col-name' }, t('Name')),
      opts.extraColumn ? h('th', { class: 'col-extra' }, opts.extraColumn.title) : null,
      h('th', { class: 'col-size' }, t('Size')),
      h('th', { class: 'col-date' }, t('Modified')),
      h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, t('Actions'))),
    )),
    tbody,
  );
  if (!opts.items.length) {
    return h('div', {}, h('div', { class: 'empty' }, icon(opts.emptyIcon || 'folder'), h('p', {}, opts.emptyText || t('Nothing here yet')), opts.emptyAction || null));
  }
  return h('div', {}, bar, table);
}

/** Moves the dragged ids into `parentId` (skipping the folder itself). */
async function moveByDrop(ids, parentId) {
  let moved = 0;
  for (const id of ids) {
    if (id === parentId) continue;
    try { await patch(`/api/nodes/${id}`, { parentId }); moved++; } catch (e) { showError(e); }
  }
  if (moved) toast(t('Moved'));
}

function triggerDownload(url, name) {
  const a = h('a', { href: url, download: name || '' });
  document.body.append(a);
  a.click();
  a.remove();
}

function nodeActions(item, opts) {
  const { me } = opts;
  const isOwner = item.owner === me.id;
  return [
    { label: item.isDir ? t('Open') : t('View'), icon: item.isDir ? 'folder' : 'eye', onclick: () => opts.onOpen(item) },
    { label: item.isDir ? t('Download as ZIP') : t('Download'), icon: 'download', onclick: () => triggerDownload(nodeUrl(item, false), item.name + (item.isDir ? '.zip' : '')) },
    opts.canModify(item) && { label: t('Rename'), icon: 'edit', onclick: () => rename(item, opts.reload) },
    opts.canModify(item) && { label: t('Move or copy'), icon: 'move', onclick: () => moveCopy([item], opts) },
    !opts.canModify(item) && { label: t('Copy to my files'), icon: 'copy', onclick: () => moveCopy([item], { ...opts, copyOnly: true }) },
    isOwner && { label: t('Share'), icon: 'share', onclick: () => shareDialog(item, opts.reload) },
    !item.isDir && { label: t('Versions'), icon: 'history', onclick: () => versionsDialog(item, opts) },
    { label: item.favorite ? t('Remove from favorites') : t('Add to favorites'), icon: 'star', onclick: async () => {
      await (item.favorite ? del : post)(`/api/nodes/${item.id}/favorite`).catch(showError);
      opts.reload();
    } },
    item.shareId && item.shareType === 'user' && { label: t('Leave share'), icon: 'logout', danger: true, onclick: async () => {
      if (!(await confirmDialog(t('Leave share'), t('Remove "{name}" from your shared items?', { name: item.name }), t('Leave'), true))) return;
      await del(`/api/shares/${item.shareId}`).catch(showError);
      opts.reload();
    } },
    opts.canModify(item) && '-',
    opts.canModify(item) && { label: t('Delete'), icon: 'trash', danger: true, onclick: async () => {
      if (!(await confirmDialog(t('Delete'), t('Move "{name}" to the trash?', { name: item.name }), t('Delete'), true))) return;
      try {
        await del(`/api/nodes/${item.id}`);
        toast(t('"{name}" moved to trash', { name: item.name }));
        opts.reload();
      } catch (e) { showError(e); }
    } },
  ];
}

async function rename(item, reload) {
  const name = await promptDialog(t('Rename'), t('New name'), item.name, t('Rename'), { selectBase: !item.isDir });
  if (!name || name === item.name) return;
  try {
    await patch(`/api/nodes/${item.id}`, { name });
    reload();
  } catch (e) { showError(e); }
}

// ---------------------------------------------------------------- dialogs

async function moveCopy(items, opts) {
  let current = opts.me.rootId;
  const list = h('ul', { class: 'picker-list' });
  const crumbs = h('nav', { class: 'breadcrumb small' });
  const go = (id) => load(id).catch(showError);
  const load = async (id) => {
    const data = await get(`/api/nodes/${id}`);
    current = id;
    crumbs.replaceChildren(...data.breadcrumb.map((c, i) => [
      i ? h('span', { class: 'sep' }, '/') : null,
      h('button', { type: 'button', class: 'crumb', 'aria-current': i === data.breadcrumb.length - 1 ? 'location' : null, onclick: () => go(c.id) }, c.name || t('Files')),
    ]));
    const dirs = data.children.filter((c) => c.isDir && !items.some((i) => i.id === c.id));
    list.replaceChildren(...(dirs.length ? dirs.map((d) => h('li', {},
      h('button', { type: 'button', onclick: () => go(d.id) }, icon('folder', 'ic-folder'), h('span', { class: 'grow' }, d.name), icon('right', 'muted')))) : [h('li', { class: 'muted' }, t('No subfolders'))]));
  };
  await load(current);
  const buttons = [{ label: t('Cancel'), value: null }, { label: t('Copy here'), value: 'copy', primary: !!opts.copyOnly }];
  if (!opts.copyOnly) buttons.push({ label: t('Move here'), value: 'move', primary: true });
  const what = items.length === 1 ? `"${items[0].name}"` : t('{n} items', { n: items.length });
  const title = opts.copyOnly ? t('Copy {what}', { what }) : t('Move or copy {what}', { what });
  const choice = await modal({ title, body: h('div', {}, crumbs, list), buttons });
  if (!choice) return;
  let done = 0;
  for (const it of items) {
    try {
      if (choice === 'move') await patch(`/api/nodes/${it.id}`, { parentId: current });
      else await post(`/api/nodes/${it.id}/copy`, { parentId: current });
      done++;
    } catch (e) { showError(e); }
  }
  // Only claim success for what worked (each failure has its own error message).
  if (done) toast(choice === 'move' ? t('Moved') : t('Copied'));
  opts.reload();
}

async function versionsDialog(item, opts) {
  const body = h('div', {});
  const load = async () => {
    const versions = await get(`/api/nodes/${item.id}/versions`);
    body.replaceChildren(
      h('p', { class: 'muted' }, t('Current version: {size}, {date}', { size: formatSize(item.size), date: fullDate(item.mtime) })),
      versions.length ? h('ul', { class: 'plain-list' }, versions.map((v) => h('li', {},
        icon('history'),
        h('span', { class: 'grow' }, fullDate(v.mtime), h('span', { class: 'muted' }, ` · ${formatSize(v.size)}`)),
        h('a', { class: 'btn ghost', href: `/api/nodes/${item.id}/versions/${v.id}/download`, download: item.name }, t('Download')),
        opts.canModify(item) || item.owner === opts.me.id ? h('button', { type: 'button', class: 'btn', onclick: async () => {
          try {
            Object.assign(item, await post(`/api/nodes/${item.id}/versions/${v.id}/restore`));
            toast(t('Version restored'));
            await load();
            opts.reload();
          } catch (e) { showError(e); }
        } }, t('Restore')) : null,
      ))) : h('p', {}, t('No older versions. A version is kept each time the file is overwritten.')),
    );
  };
  await load();
  await modal({ title: t('Versions of "{name}"', { name: item.name }), body, wide: true });
}

export async function shareDialog(item, reload) {
  const body = h('div', { class: 'share-dialog' });
  const datalist = h('datalist', { id: 'sharee-options' });
  const input = h('input', { type: 'text', list: 'sharee-options', placeholder: t('Username or group:name'), autocomplete: 'off', 'aria-label': t('Share with') });
  const canEditNew = h('input', { type: 'checkbox' });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const found = await get(`/api/sharees?q=${encodeURIComponent(input.value.replace(/^group:/, ''))}`).catch(() => null);
      if (!found) return;
      const { users, groups } = found;
      datalist.replaceChildren(
        ...users.map((u) => h('option', { value: u.id }, u.displayName)),
        ...groups.map((g) => h('option', { value: `group:${g.id}` }, t('Group {name}', { name: g.id }))),
      );
    }, 200);
  });

  let adding = false;
  const add = async () => {
    const v = input.value.trim();
    if (!v || adding) return;
    const isGroup = v.startsWith('group:');
    adding = true;
    try {
      await post(`/api/nodes/${item.id}/shares`, { type: isGroup ? 'group' : 'user', shareWith: isGroup ? v.slice(6) : v, canEdit: canEditNew.checked });
      input.value = '';
      await refresh();
      input.focus();
    } catch (e) { showError(e); } finally { adding = false; }
  };
  // A checkbox whose change the server refused goes back to what is really stored.
  const toggleShare = (s) => async (e) => {
    const box = e.target;
    box.disabled = true;
    try { await patch(`/api/shares/${s.id}`, { canEdit: box.checked }); s.canEdit = box.checked; } catch (err) { box.checked = !box.checked; showError(err); } finally { box.disabled = false; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  const shareRow = (s) => h('li', {},
    icon(s.type === 'group' ? 'users' : 'contacts'),
    h('span', { class: 'grow' }, s.type === 'group' ? t('Group {name}', { name: s.shareWith }) : s.shareWith),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.canEdit, onchange: toggleShare(s) }), t('Can edit')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Remove share with {name}', { name: s.shareWith }), onclick: async () => { await del(`/api/shares/${s.id}`).catch(showError); refresh().catch(showError); } }, icon('x')),
  );

  const linkCard = (s) => {
    const url = location.origin + s.url;
    const pw = h('input', { type: 'password', placeholder: s.hasPassword ? t('•••••• (set)') : t('No password'), autocomplete: 'new-password', 'aria-label': t('Link password') });
    // The link stops working at the end of the chosen day in the user's own time zone (it used to be the server's).
    const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const expiry = h('input', { type: 'date', value: s.expiresAt ? localDay(s.expiresAt) : '', min: localDay(Date.now()), 'aria-label': t('Expiry date'), onchange: async (e) => {
      const v = e.target.value;
      await patch(`/api/shares/${s.id}`, { expiresAt: v ? new Date(`${v}T23:59:59`).toISOString() : null })
        .then(() => toast(v ? t('Expiry updated') : t('The link no longer expires'))).catch(showError);
    } });
    const setPassword = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: async () => {
      await patch(`/api/shares/${s.id}`, { password: pw.value }).then(() => { toast(t('Password set')); return refresh(); }).catch(showError);
    } }, icon('lock'), t('Set'));
    // An empty field + "Set" used to remove the password without saying so; removing is its own button now.
    pw.addEventListener('input', () => { setPassword.disabled = !pw.value; });
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (pw.value) setPassword.click(); } });
    return h('li', { class: 'link-card' },
      h('div', { class: 'link-row' }, icon('link'), h('input', { type: 'text', readonly: true, value: url, 'aria-label': t('Link URL'), onclick: (e) => e.target.select() }),
        h('button', { type: 'button', class: 'btn', onclick: () => copyText(url) }, icon('copy'), t('Copy')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Delete link'), onclick: async () => {
          if (!(await confirmDialog(t('Delete link'), t('People who have this link can no longer open it.'), t('Delete'), true))) return;
          await del(`/api/shares/${s.id}`).catch(showError);
          refresh().catch(showError);
        } }, icon('trash'))),
      h('div', { class: 'link-opts' },
        item.isDir && h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.canEdit, onchange: toggleShare(s) }), t('Allow upload')),
        h('label', { class: 'inline' }, t('Expires'), expiry),
        h('span', { class: 'inline' }, pw, setPassword,
          s.hasPassword && h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
            await patch(`/api/shares/${s.id}`, { password: null }).then(() => { toast(t('Password removed')); return refresh(); }).catch(showError);
          } }, t('Remove password'))),
      ),
    );
  };

  async function refresh() {
    const shares = await get(`/api/nodes/${item.id}/shares`);
    const direct = shares.filter((s) => s.type !== 'link');
    const links = shares.filter((s) => s.type === 'link');
    body.replaceChildren(
      h('h3', {}, t('People and groups')),
      h('div', { class: 'share-add' }, input, datalist, h('label', { class: 'check' }, canEditNew, t('Can edit')), h('button', { type: 'button', class: 'btn primary', onclick: add }, t('Share'))),
      direct.length ? h('ul', { class: 'plain-list' }, direct.map(shareRow)) : h('p', { class: 'muted' }, t('Not shared with anyone yet.')),
      h('h3', {}, t('Public links')),
      links.length ? h('ul', { class: 'plain-list' }, links.map(linkCard)) : h('p', { class: 'muted' }, t('Anyone with a link can view the item.')),
      h('button', { type: 'button', class: 'btn', onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await post(`/api/nodes/${item.id}/shares`, { type: 'link' }); await refresh(); } catch (err) { showError(err); btn.disabled = false; }
      } }, icon('plus'), t('Create link')),
    );
  }
  await refresh();
  await modal({ title: t('Share "{name}"', { name: item.name }), body, wide: true });
  reload?.();
}

// ---------------------------------------------------------------- views

function openItem(item, siblings, opts) {
  if (item.isDir) return void (location.hash = `#/files/${item.id}`);
  const files = siblings.filter((s) => !s.isDir);
  openViewer(files, Math.max(0, files.findIndex((f) => f.id === item.id)), {
    url: nodeUrl,
    preview: (node) => (isOfficeFile(node) ? officePreviewUrl(node) : null),
    canEdit: opts.canModify(item) || item.owner === opts.me.id || opts.editable || !!item.canEdit,
    onSaved: opts.reload,
  });
}

export async function renderFolder(main, id, ctx) {
  const data = await get(`/api/nodes/${id}`);
  if (!data.node.isDir) {
    location.hash = `#/files/${data.node.parentId ?? ctx.me.rootId}`;
    return;
  }
  const canEdit = data.perm !== 'read';
  // Redraws this folder if it is still on screen. Uploads finish late: by then the user may have opened another
  // view (nothing to do) or come back to this folder (a fresh render of the current route).
  const reload = () => {
    if (main.isConnected) return renderFolder(main, id, ctx).catch(showError);
    const [, view = 'files', arg] = location.hash.replace(/^#/, '').split('/');
    if (view === 'files' && String(arg || ctx.me.rootId) === String(id)) ctx.rerender();
  };
  const opts = {
    items: data.children, me: ctx.me, reload, editable: canEdit,
    canModify: () => canEdit,
    onOpen: (item) => openItem(item, data.children, opts),
    uploadInto: canEdit ? (folder, items) => uploadAll(items, userUploadTarget(folder.id), reload) : null,
    emptyText: canEdit ? t('Drop files here or use the Upload button') : t('This folder is empty'),
  };
  if (canEdit) opts.emptyAction = h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, icon('upload'), t('Upload files'));

  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { uploadAll(filesFromInput(e.target), userUploadTarget(id), reload); e.target.value = ''; } });
  const dirInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, onchange: (e) => { uploadAll(filesFromInput(e.target), userUploadTarget(id), reload); e.target.value = ''; } });

  const last = data.breadcrumb.length - 1;
  const crumbs = h('nav', { class: 'breadcrumb', 'aria-label': t('Folder path') },
    data.breadcrumb.map((c, i) => {
      const a = h('a', { class: 'crumb', href: `#/files/${c.id}`, 'aria-current': i === last ? 'page' : null }, i === 0 && c.name === '' ? t('Files') : c.name);
      // Rows dragged onto a parent folder in the path move there (the only way "up" without the dialog).
      if (canEdit && i !== last) {
        a.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-cloudy')) { e.preventDefault(); a.classList.add('drop-target'); } });
        a.addEventListener('dragleave', () => a.classList.remove('drop-target'));
        a.addEventListener('drop', async (e) => {
          a.classList.remove('drop-target');
          const raw = e.dataTransfer.getData('application/x-cloudy');
          if (!raw) return;
          e.preventDefault();
          await moveByDrop(JSON.parse(raw), c.id);
          reload();
        });
      }
      return [i ? h('span', { class: 'sep' }, icon('right')) : null, a];
    }));

  const toolbar = h('div', { class: 'toolbar' }, crumbs, h('div', { class: 'grow' }),
    canEdit && h('button', { class: 'btn', 'aria-haspopup': 'menu', onclick: (e) => showMenu(e.currentTarget, [
      { label: t('New folder'), icon: 'folderPlus', onclick: async () => {
        const name = await promptDialog(t('New folder'), t('Folder name'), t('New folder'), t('Create'));
        if (name) await post(`/api/nodes/${id}/folders`, { name }).then(reload, showError);
      } },
      { label: t('New text file'), icon: 'filePlus', onclick: async () => {
        const name = await promptDialog(t('New text file'), t('File name'), 'Notes.md', t('Create'));
        if (!name) return;
        try {
          const node = await post(`/api/nodes/${id}/files`, { name, content: '' });
          await reload();
          openViewer([node], 0, { url: nodeUrl, canEdit: true, onSaved: reload });
        } catch (e) { showError(e); }
      } },
    ]) }, icon('plus'), t('New')),
    canEdit && h('button', { class: 'btn primary', 'aria-haspopup': 'menu', onclick: (e) => showMenu(e.currentTarget, [
      { label: t('Upload files'), icon: 'upload', onclick: () => fileInput.click() },
      { label: t('Upload folder'), icon: 'folder', onclick: () => dirInput.click() },
    ]) }, icon('upload'), t('Upload')),
    fileInput, dirInput,
  );

  const view = h('section', { class: 'files-view', 'data-drop-label': t('Drop to upload') }, toolbar, !canEdit && h('p', { class: 'notice' }, icon('lock'), t('Shared with you as read-only')), fileTable(opts));
  if (canEdit) attachDropZone(view, async (items) => uploadAll(items, userUploadTarget(id), reload));
  main.replaceChildren(view);
}

export function attachDropZone(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    depth++;
    el.classList.add('dragging');
  });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('dragging'); } });
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('drop', async (e) => {
    depth = 0;
    el.classList.remove('dragging');
    // A folder row inside already took the files (it calls preventDefault).
    if (!e.dataTransfer.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    onFiles(await filesFromDrop(e.dataTransfer));
  });
}

async function listView(main, ctx, { title, iconName, items, emptyText, extraColumn, canModify }) {
  const opts = {
    items, me: ctx.me, extraColumn, emptyText, emptyIcon: iconName,
    canModify: canModify || ((i) => i.owner === ctx.me.id),
    reload: () => ctx.rerender(),
    onOpen: (item) => openItem(item, items, opts),
  };
  main.replaceChildren(h('section', { class: 'files-view' },
    h('div', { class: 'toolbar' }, h('h1', { class: 'view-title' }, icon(iconName), title)),
    fileTable(opts)));
}

export async function renderRecent(main, ctx) {
  await listView(main, ctx, { title: t('Recent'), iconName: 'clock', items: await get('/api/recent'), emptyText: t('No recently changed files') });
}

export async function renderFavorites(main, ctx) {
  await listView(main, ctx, { title: t('Favorites'), iconName: 'star', items: await get('/api/favorites'), emptyText: t('Mark files with the star to find them here') });
}

export async function renderSharedIn(main, ctx) {
  await listView(main, ctx, {
    title: t('Shared with you'), iconName: 'users', items: await get('/api/shares/incoming'), emptyText: t('Nothing has been shared with you yet'),
    canModify: () => false,
    extraColumn: { title: t('Shared by'), render: (i) => h('span', {}, i.ownerName, i.canEdit ? h('span', { class: 'pill' }, t('can edit')) : null) },
  });
}

export async function renderSharedOut(main, ctx) {
  const shares = await get('/api/shares/outgoing');
  const byNode = new Map();
  for (const s of shares) {
    const entry = byNode.get(s.node.id) || { ...s.node, targets: [] };
    entry.targets.push(s.type === 'link' ? t('link') : s.type === 'group' ? t('group {name}', { name: s.shareWith }) : s.shareWith);
    byNode.set(s.node.id, entry);
  }
  await listView(main, ctx, {
    title: t('Shared by you'), iconName: 'share', items: [...byNode.values()], emptyText: t('You have not shared anything yet'),
    extraColumn: { title: t('Shared with'), render: (i) => h('span', { class: 'targets' }, i.targets.join(', ')) },
  });
}

export async function renderSearch(main, ctx, query) {
  const items = query ? await get(`/api/search?q=${encodeURIComponent(query)}`) : [];
  await listView(main, ctx, {
    title: t('Search: “{query}”', { query }), iconName: 'search', items, emptyText: t('No matching files'),
    extraColumn: { title: t('Location'), render: (i) => h('a', { href: `#/files/${i.parentId}`, onclick: (e) => e.stopPropagation() }, i.path) },
  });
}

export async function renderTrash(main, ctx) {
  const items = await get('/api/trash');
  const reload = () => renderTrash(main, ctx).catch(showError);
  const rows = items.map((it) => h('tr', {},
    h('td', { class: 'col-name' }, h('div', { class: 'name-cell' }, fileIcon(it), h('span', { class: 'name', dir: 'auto' }, it.name))),
    h('td', { class: 'col-extra muted' }, it.originalPath),
    h('td', { class: 'col-size' }, formatSize(it.size)),
    h('td', { class: 'col-date', title: fullDate(it.deletedAt) }, formatDate(it.deletedAt)),
    h('td', { class: 'col-actions nowrap' },
      h('button', { class: 'btn ghost', onclick: async (e) => { e.currentTarget.disabled = true; await post(`/api/trash/${it.id}/restore`).then(() => toast(t('"{name}" restored', { name: it.name })), showError); reload(); } }, icon('restore'), t('Restore')),
      h('button', { class: 'icon-btn', 'aria-label': t('Delete {name} permanently', { name: it.name }), onclick: async () => {
        if (await confirmDialog(t('Delete permanently'), t('"{name}" will be deleted forever.', { name: it.name }), t('Delete'), true)) { await del(`/api/trash/${it.id}`).catch(showError); reload(); }
      } }, icon('trash'))),
  ));
  main.replaceChildren(h('section', { class: 'files-view' },
    h('div', { class: 'toolbar' }, h('h1', { class: 'view-title' }, icon('trash'), t('Deleted files')), h('div', { class: 'grow' }),
      items.length > 0 && h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDialog(t('Empty trash'), t('All deleted files will be removed permanently.'), t('Empty trash'), true)) { await del('/api/trash').catch(showError); reload(); }
      } }, t('Empty trash'))),
    items.length
      ? h('table', { class: 'file-table' }, h('thead', {}, h('tr', {}, h('th', { class: 'col-name' }, t('Name')), h('th', { class: 'col-extra' }, t('Original location')), h('th', { class: 'col-size' }, t('Size')), h('th', { class: 'col-date' }, t('Deleted')), h('th', { class: 'col-trash-actions' }, h('span', { class: 'sr-only' }, t('Actions'))))), h('tbody', {}, rows))
      : h('div', { class: 'empty' }, icon('trash'), h('p', {}, t('Trash is empty'))),
    h('p', { class: 'muted small' }, t('Deleted items are removed permanently after {n} days.', { n: ctx.me?.trashDays ?? 30 })),
  ));
}
