// Files app: folder browser, special lists (recent, favorites, shares, search, trash) and dialogs.
import { get, post, patch, del, api } from './api.js';
import {
  h, icon, fileIcon, avatar, formatSize, formatDate, fullDate, toast, showError, modal, confirmDialog,
  promptDialog, showMenu, copyText, navigate, currentView,
} from './ui.js';
import { openViewer, kindOf } from './viewer.js';
import { isOfficeFile, officePreviewUrl } from './office.js';
import { uploadAll, filesFromDrop, filesFromInput } from './upload.js';
import { draggingFiles, setDropTarget } from './drop.js';
import { viewPrefs, SORTS, chooseSort, setView, setDescending, sortItems, tileArt } from './listprefs.js';
import { t, locale } from './i18n.js';

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

/** A selection bar's buttons are disabled while their requests run (one call per file, as in the apps). */
const whileBusy = (bar, fn) => async (e) => {
  const buttons = [...bar.querySelectorAll('button')];
  buttons.forEach((b) => { b.disabled = true; });
  try { await fn(e); } finally { buttons.forEach((b) => { b.disabled = false; }); }
};

/** A thumbnail address for signed-in users; the version in it changes with the file, so browsers keep it for good. */
const thumbUrl = (item) => `/api/nodes/${item.id}/thumb?v=${encodeURIComponent(item.etag || item.mtime)}`;

// Rows are made in batches: a folder of 5,000 files used to build all 110,000 elements at once, and again on every
// live update. The first batch is drawn at once, the rest as the list scrolls towards it.
const FIRST_BATCH = 200;

// Ctrl/⌘+F: the browser's find looks through the rows on the page, so a big folder draws the rest of its rows first.
let findAll = null;
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') findAll?.(); });

// The sticky toolbar's height (--toolbar-h): the page's scroll padding keeps a focused row out from under it, and the
// selection bar sits below it, also when it takes two lines.
const toolbarSize = 'ResizeObserver' in window
  ? new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--toolbar-h', `${Math.ceil(entry.target.offsetHeight)}px`))
  : null;
function watchToolbar(el) {
  toolbarSize?.disconnect();
  toolbarSize?.observe(el);
}

/** Where the user is in a view: the scroll position and the focused row or control (data-key), or that row's place. */
export function placeOf(host) {
  const el = host.contains(document.activeElement) ? document.activeElement.closest('[data-key]') : null;
  const rows = el?.classList.contains('file-row') ? [...host.querySelectorAll('.file-row')] : [];
  return { y: window.scrollY, key: el?.dataset.key ?? null, index: rows.indexOf(el) };
}

/** Back to that place after the view was drawn again; when the focused row is gone, the one now in its place. */
export function restorePlace(host, { y, key, index }) {
  host.querySelector('.file-list')?.renderUntil?.(y + window.innerHeight);
  window.scrollTo(0, y);
  if (!key) return;
  const rows = () => [...host.querySelectorAll('.file-row')];
  const el = host.querySelector(`[data-key="${CSS.escape(key)}"]`) ?? (index >= 0 ? rows().at(Math.min(index, rows().length - 1)) : null);
  el?.focus({ preventScroll: true });
}

async function keepPlace(host, draw) {
  const place = placeOf(host);
  await draw();
  // Only while this view is still the one on screen: drawn again after the user went on (an action that ended late),
  // it used to scroll the page that came after it to its own offset.
  if (host.isConnected) restorePlace(host, place);
}
const NEXT_BATCH = 400;

/**
 * Renders a file list, as a table or as a grid of tiles.
 * opts: { items, me, canModify(item), onOpen(item), extraColumn?: {title, render(item)}, reload(), emptyText,
 *         view?: 'list'|'grid', sort?: {key, desc}, onSort?(key), folder?, uploadInto?, moveTargets? }
 */
function fileTable(opts) {
  const grid = opts.view === 'grid';
  const selected = new Set();
  const rows = new Map(); // id → { el, box, more }
  // One Tab stop for the whole list (it was three per row): the row in focus last, then its checkbox and ⋯ button.
  // The arrow keys move between rows; Tab goes on to that row's checkbox and ⋯ button, then out of the list.
  let current = null;
  const makeCurrent = (entry) => {
    if (!entry || current === entry) return;
    if (current) for (const el of [current.el, current.box, current.more]) el.tabIndex = -1;
    current = entry;
    for (const el of [entry.el, entry.box, entry.more]) el.tabIndex = 0;
  };
  const bar = h('div', { class: 'selection-bar', hidden: true });
  // "3 selected" for screen readers. It lives outside the bar, which is hidden while nothing is ticked: a message
  // that appears together with its region is not read out, and the first tick is exactly that moment.
  const said = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const allBox = h('input', { type: 'checkbox', 'aria-label': t('Select all') });
  let host;
  let anchor = null; // last item ticked by itself: Shift-click ticks everything from there

  const setSelected = (item, on) => {
    on ? selected.add(item.id) : selected.delete(item.id);
    const r = rows.get(item.id);
    if (r) { r.box.checked = on; r.el.classList.toggle('selected', on); }
  };
  const selectRange = (to) => {
    const from = opts.items.findIndex((i) => i.id === anchor?.id);
    const end = opts.items.findIndex((i) => i.id === to.id);
    if (from < 0 || end < 0) return setSelected(to, true);
    for (let i = Math.min(from, end); i <= Math.max(from, end); i++) setSelected(opts.items[i], true);
  };
  const clearSelection = () => {
    // The bar goes away: a keyboard user who pressed its ✕ continues on the list's row (focus used to fall to the page).
    const fromBar = bar.contains(document.activeElement);
    for (const id of [...selected]) setSelected({ id }, false);
    anchor = null;
    updateBar();
    if (fromBar) current?.el.focus({ preventScroll: true });
  };
  const menuFor = (item) => [
    { label: t('Select'), icon: 'check', onclick: () => { setSelected(item, true); anchor = item; updateBar(); } },
    '-',
    ...nodeActions(item, opts),
  ];

  const busy = (fn) => whileBusy(bar, fn);
  const chosen = () => opts.items.filter((i) => selected.has(i.id));
  // From the Delete key, the question's Delete button has the focus (Enter then deletes, as the key promised; the
  // items go to the trash, so it can be undone). Elsewhere the dialog starts on its ✕, as every dialog does.
  const deleteChosen = async ({ fromKey = false } = {}) => {
    const list = chosen().filter((i) => opts.canModify(i));
    if (!list.length) return;
    // Items in someone else's folder go to the owner's trash: the person deleting them never sees them again.
    const others = list.some((i) => i.owner !== opts.me.id);
    const question = t('Move {n} item(s) to the trash?', { n: list.length });
    if (!(await confirmDialog(t('Delete items'), others ? `${question} ${t("They are in someone else's folder: they go to that person's trash, and only they can restore them.")}` : question, t('Delete'), true, { focusOk: fromKey }))) return;
    let failed = 0;
    for (const it of list) await del(`/api/nodes/${it.id}`).catch((e) => { failed++; showError(e); });
    const done = list.length - failed;
    if (done && others) toast(t("{n} item(s) moved to the owner's trash", { n: done }));
    else if (done) toast(t('{n} item(s) moved to trash', { n: done }), 'info', { label: t('Show'), onclick: () => navigate('/trash') });
    opts.reload();
  };
  // The bar's buttons are made once and shown or hidden as the selection changes. (The bar used to be built anew on
  // every tick: "Select all" or ✕ pressed by keyboard was replaced under the focus, which fell back to the page.)
  const count = h('span', {});
  const allBtn = h('button', { class: 'btn ghost', onclick: () => { for (const it of opts.items) setSelected(it, true); updateBar(); } }, icon('check'), t('Select all'));
  const downloadBtn = h('button', { class: 'btn ghost', onclick: busy(() => downloadItems(chosen(), opts)) }, icon('download'), t('Download'));
  const favoriteBtn = h('button', { class: 'btn ghost', onclick: busy(async () => {
    for (const it of chosen().filter((i) => !i.favorite)) await post(`/api/nodes/${it.id}/favorite`).catch(showError);
    opts.reload();
  }) }, icon('star'), t('Add to favorites'));
  const moveBtn = h('button', { class: 'btn ghost', onclick: busy(() => moveCopy(chosen().filter((i) => opts.canModify(i)), opts)) }, icon('move'), t('Move or copy'));
  const deleteBtn = h('button', { class: 'btn ghost danger', onclick: busy(() => deleteChosen()) }, icon('trash'), t('Delete'));
  bar.append(
    h('button', { class: 'icon-btn', 'aria-label': t('Clear selection'), title: t('Clear selection'), onclick: clearSelection }, icon('x')),
    count, allBtn, downloadBtn, favoriteBtn, moveBtn, deleteBtn);
  const updateBar = () => {
    const items = chosen();
    const editable = items.some((i) => opts.canModify(i));
    // A button about to go while it has the focus (Select all, once everything is ticked) hands it to Download.
    const focusLeaves = document.activeElement === allBtn && selected.size >= opts.items.length;
    bar.hidden = selected.size === 0;
    host?.classList.toggle('selecting', selected.size > 0);
    allBox.checked = selected.size > 0 && selected.size === opts.items.length;
    allBox.indeterminate = selected.size > 0 && selected.size < opts.items.length;
    count.textContent = t('{n} selected', { n: selected.size });
    said.textContent = selected.size ? count.textContent : '';
    allBtn.hidden = selected.size >= opts.items.length;
    favoriteBtn.hidden = !items.some((i) => !i.favorite);
    moveBtn.hidden = deleteBtn.hidden = !editable;
    if (focusLeaves && !bar.hidden) downloadBtn.focus();
  };
  allBox.addEventListener('change', () => {
    for (const it of opts.items) setSelected(it, allBox.checked);
    updateBar();
  });

  const makeRow = (item) => {
    // Shift-click ticks everything from the last ticked row to this one. The click itself is left to the browser and
    // the range is ticked in "change", which comes after it: cancelling the click (as this did) made the browser put
    // this box back to unticked, while its row was selected and counted.
    let ranged = false;
    const box = h('input', { type: 'checkbox', tabindex: -1, 'aria-label': t('Select {name}', { name: item.name }), onclick: (e) => {
      e.stopPropagation();
      ranged = e.shiftKey && !!anchor;
    }, onchange: (e) => {
      if (ranged) { ranged = false; selectRange(item); }
      else {
        setSelected(item, e.target.checked);
        if (e.target.checked) anchor = item;
      }
      updateBar();
    } });
    const more = h('button', { class: 'icon-btn', tabindex: -1, 'aria-haspopup': 'menu', 'aria-label': t('Actions for {name}', { name: item.name }), onclick: (e) => {
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
    const takesUploads = item.isDir && !!opts.uploadInto;
    const attrs = {
      class: grid ? `file-row tile${item.isDir ? ' folder' : ''}` : 'file-row', tabindex: -1, 'data-key': `node-${item.id}`,
      role: grid ? 'listitem' : null,
      draggable: opts.canModify(item) ? 'true' : null,
      // Files dragged in from the computer land in the folder under the pointer (drop.js lights it up and names it).
      'data-folder-id': takesUploads ? item.id : null, 'data-folder-name': takesUploads ? item.name : null,
      onclick: (e) => {
        if (e.target.closest('a')) return; // a link in the row (search results: the location) goes where it points
        if (e.shiftKey && anchor) { selectRange(item); updateBar(); return; }
        if (e.metaKey || e.ctrlKey) { setSelected(item, !selected.has(item.id)); anchor = item; updateBar(); return; }
        if (selected.size > 0) { setSelected(item, !selected.has(item.id)); anchor = item; updateBar(); return; }
        opts.onOpen(item);
      },
      // Keys on the row's checkbox or ⋯ button belong to them. Enter opens (toggles while selecting), Space ticks,
      // arrows move between rows (and tiles), Delete moves the selection (or this item) to the trash, F2 renames.
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selected.size > 0 || e.key === ' ') { setSelected(item, !selected.has(item.id)); anchor = item; updateBar(); }
          else opts.onOpen(item);
        } else if (e.key === 'Delete' && opts.canModify(item)) {
          e.preventDefault();
          if (!selected.size) setSelected(item, true);
          updateBar();
          deleteChosen({ fromKey: true });
        } else if (e.key === 'F2' && opts.canModify(item)) {
          e.preventDefault();
          rename(item, opts.reload);
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          showMenu(more, menuFor(item));
        } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
          const list = [...host.querySelectorAll('.file-row')];
          const i = list.indexOf(el);
          const rtl = document.documentElement.dir === 'rtl';
          let to = null;
          if (e.key === 'Home') to = list[0];
          else if (e.key === 'End') { renderAll(); to = [...host.querySelectorAll('.file-row')].at(-1); }
          else if (!grid && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) to = list[i + (e.key === 'ArrowDown' ? 1 : -1)];
          else if (grid) {
            const cols = Math.max(1, getComputedStyle(el.parentElement).gridTemplateColumns.split(' ').filter(Boolean).length);
            const step = e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : (e.key === 'ArrowRight') !== rtl ? 1 : -1;
            to = list[i + step];
          }
          if (!to && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) { renderMore(); to = [...host.querySelectorAll('.file-row')][i + 1]; }
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
    };
    const badges = [item.favorite && icon('star', 'badge fav'), item.shared && icon('share', 'badge')];
    const el = grid && item.isDir
      ? h('div', attrs, fileIcon(item), h('span', { class: 'tile-name', title: item.name, dir: 'auto' }, item.name), badges,
          h('div', { class: 'tile-pick' }, box), h('div', { class: 'tile-more' }, more))
      : grid
      ? h('div', attrs, tileArt(item, opts.thumbUrl ?? (opts.me?.thumbnails ? thumbUrl : null)),
          h('div', { class: 'tile-name', title: item.name, dir: 'auto' }, item.name),
          h('div', { class: 'tile-meta' }, h('span', {}, formatSize(item.size)), h('span', { title: fullDate(item.mtime) }, formatDate(item.mtime)), badges),
          h('div', { class: 'tile-pick' }, box), h('div', { class: 'tile-more' }, more))
      : h('tr', attrs,
          h('td', { class: 'col-check' }, box),
          h('td', { class: 'col-name' }, h('div', { class: 'name-cell' }, fileIcon(item),
            h('div', { class: 'name-lines' }, h('span', { class: 'name', title: item.name, dir: 'auto' }, item.name),
              // Phones hide the Modified (and Location / Shared by) columns: the same facts go under the name there.
              h('span', { class: 'row-meta', dir: 'auto' }, [opts.extraColumn && (opts.extraColumn.text?.(item) ?? opts.extraColumn.render(item).textContent), formatDate(item.mtime)].filter(Boolean).join(' · '))),
            badges)),
          opts.extraColumn ? h('td', { class: 'col-extra' }, opts.extraColumn.render(item)) : null,
          h('td', { class: 'col-size' }, formatSize(item.size)),
          h('td', { class: 'col-date', title: fullDate(item.mtime) }, formatDate(item.mtime)),
          h('td', { class: 'col-actions' }, more));
    // Rows dragged onto a folder move there.
    el.addEventListener('dragstart', (e) => {
      const ids = selected.has(item.id) ? [...selected] : [item.id];
      e.dataTransfer.setData('application/x-cloudy', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    });
    if (item.isDir && opts.moveTargets !== false) {
      el.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-cloudy')) { e.preventDefault(); el.classList.add('drop-target'); }
      });
      el.addEventListener('dragleave', (e) => {
        if (!el.contains(e.relatedTarget) && !draggingFiles(e)) el.classList.remove('drop-target');
      });
      el.addEventListener('drop', async (e) => {
        const raw = e.dataTransfer.getData('application/x-cloudy');
        if (!raw) return; // files from the computer: drop.js takes them
        el.classList.remove('drop-target');
        e.preventDefault();
        e.stopPropagation();
        await moveByDrop(JSON.parse(raw), item, opts);
        opts.reload();
      });
    }
    if (selected.has(item.id)) { box.checked = true; el.classList.add('selected'); }
    const entry = { el, box, more };
    rows.set(item.id, entry);
    el.addEventListener('focusin', () => makeCurrent(entry));
    return el;
  };

  if (!opts.items.length) {
    return h('div', {}, h('div', { class: 'empty' }, icon(opts.emptyIcon || 'folder'), h('p', {}, opts.emptyText || t('Nothing here yet')), opts.emptyAction || null));
  }

  // A column's heading sorts by it; a second click turns the order round.
  const th = (key, label, cls) => {
    const on = opts.sort?.key === key;
    return h('th', { class: cls, 'aria-sort': on ? (opts.sort.desc ? 'descending' : 'ascending') : null },
      opts.onSort ? h('button', { type: 'button', class: 'th-sort', 'data-key': `sort-${key}`, onclick: () => opts.onSort(key) }, label, icon(on ? (opts.sort.desc ? 'down' : 'up') : 'blank')) : label);
  };
  const dirs = h('div', { class: 'file-grid folders' });
  const docs = h('div', { class: 'file-grid' });
  const tbody = h('tbody');
  host = grid
    ? h('div', { class: 'file-tiles', role: 'list', 'aria-label': t('Files') }, dirs, docs)
    : h('table', { class: 'file-table' },
        h('thead', {}, h('tr', {},
          h('th', { class: 'col-check' }, allBox),
          th('name', t('Name'), 'col-name'),
          opts.extraColumn ? h('th', { class: 'col-extra' }, opts.extraColumn.title) : null,
          th('size', t('Size'), 'col-size'),
          th('mtime', t('Modified'), 'col-date'),
          h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, t('Actions'))),
        )),
        tbody);

  let shown = 0;
  const sentinel = h('div', { class: 'more-rows', 'aria-hidden': 'true' });
  const renderMore = (count = NEXT_BATCH) => {
    const next = opts.items.slice(shown, shown + count);
    for (const item of next) {
      const el = makeRow(item);
      if (!grid) tbody.append(el);
      else (item.isDir ? dirs : docs).append(el);
    }
    shown += next.length;
    dirs.hidden = !dirs.childElementCount;
    docs.hidden = !docs.childElementCount;
    if (shown >= opts.items.length) { observer?.disconnect(); sentinel.remove(); }
    // Watched afresh after each batch: a sentinel still within reach got no new notice, and the rest of a big
    // folder could not be scrolled to.
    else if (observer && sentinel.isConnected) { observer.unobserve(sentinel); observer.observe(sentinel); }
  };
  const renderAll = () => { if (shown < opts.items.length) renderMore(opts.items.length - shown); };
  const observer = opts.items.length > FIRST_BATCH && 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) renderMore(); }, { rootMargin: '1200px 0px' })
    : null;
  renderMore(observer ? FIRST_BATCH : opts.items.length);
  if (observer && shown < opts.items.length) observer.observe(sentinel);
  makeCurrent(rows.get(opts.items[0].id));

  // Escape clears the selection; Ctrl/⌘+A selects everything in the list (while focus is in it).
  const wrap = h('div', { class: 'file-list', onkeydown: (e) => {
    if (e.key === 'Escape' && selected.size && !document.querySelector('dialog[open], .menu')) { e.preventDefault(); clearSelection(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && e.target.closest('.file-row')) {
      e.preventDefault();
      for (const it of opts.items) setSelected(it, true);
      updateBar();
    }
  } }, bar, said, host, shown < opts.items.length ? sentinel : null);
  wrap.clearSelection = clearSelection;
  wrap.hasSelection = () => selected.size > 0;
  /** Draws more rows until the page is `px` tall (or all are drawn): putting back a scroll position far down. */
  wrap.renderUntil = (px) => {
    while (shown < opts.items.length && document.documentElement.scrollHeight < px) renderMore();
  };
  findAll = () => { if (wrap.isConnected) renderAll(); };
  return wrap;
}

/** Moves the dragged ids into `dest` ({id, name}), says where they went and offers to take it back. */
async function moveByDrop(data, dest, opts) {
  // Drag data can come from another page dropped onto ours: only plain numeric ids (what our rows set) go into API paths.
  const ids = Array.isArray(data) ? data.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  const moved = [];
  for (const id of ids) {
    if (id === dest.id) continue;
    const item = opts.items?.find((i) => i.id === id);
    try {
      await patch(`/api/nodes/${id}`, { parentId: dest.id });
      moved.push({ id, from: item?.parentId ?? opts.folder?.id });
    } catch (e) { showError(e); }
  }
  if (!moved.length) return;
  toast(t('Moved {n} item(s) to {folder}', { n: moved.length, folder: dest.name || t('Files') }), 'info', moved.every((m) => m.from) ? {
    label: t('Undo'),
    onclick: async () => {
      for (const m of moved) await patch(`/api/nodes/${m.id}`, { parentId: m.from }).catch(showError);
      opts.reload();
    },
  } : undefined);
}

function triggerDownload(url, name) {
  const a = h('a', { href: url, download: name || '' });
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Downloads the selection: one file as itself, one folder as its ZIP, several items as one ZIP (named after their
 * folder). Everything in a folder is simply that folder's ZIP.
 */
async function downloadItems(items, opts) {
  if (!items.length) return;
  if (items.length === 1) return triggerDownload(nodeUrl(items[0], false), items[0].name + (items[0].isDir ? '.zip' : ''));
  if (opts.folder && items.length === opts.items.length) return triggerDownload(nodeUrl(opts.folder, false), '');
  try {
    const { url } = await post('/api/zip', { ids: items.map((i) => i.id) });
    triggerDownload(url, '');
  } catch (e) {
    showError(e);
  }
}

function nodeActions(item, opts) {
  const { me } = opts;
  const isOwner = item.owner === me.id;
  return [
    { label: item.isDir ? t('Open') : t('View'), icon: item.isDir ? 'folder' : 'eye', onclick: () => opts.onOpen(item) },
    opts.showInFolder && item.parentId && { label: t('Show in folder'), icon: 'folder', onclick: async () => {
      // Someone else's item can be shared on its own: its folder is then not open to you (that ended in your Files).
      if (!isOwner) {
        const res = await fetch(`/api/nodes/${item.parentId}`, { method: 'HEAD', credentials: 'same-origin' }).catch((e) => e);
        if (res instanceof Error) return void showError(res);
        if (res.status === 404 || res.status === 403) return void toast(t('Its folder is not shared with you.'), 'error');
      }
      navigate(`/files/${item.parentId}`);
    } },
    { label: item.isDir ? t('Download as ZIP') : t('Download'), icon: 'download', onclick: () => triggerDownload(nodeUrl(item, false), item.name + (item.isDir ? '.zip' : '')) },
    opts.canModify(item) && { label: t('Rename'), icon: 'edit', onclick: () => rename(item, opts.reload) },
    opts.canModify(item) && { label: t('Move or copy'), icon: 'move', onclick: () => moveCopy([item], opts) },
    !opts.canModify(item) && { label: t('Copy to my files'), icon: 'copy', onclick: () => moveCopy([item], { ...opts, copyOnly: true }) },
    isOwner && { label: t('Share'), icon: 'share', onclick: () => shareDialog(item, opts.reload) },
    !item.isDir && (opts.canModify(item) || isOwner || item.canEdit) && { label: t('Versions'), icon: 'history', onclick: () => versionsDialog(item, opts) },
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
      const question = t('Move "{name}" to the trash?', { name: item.name });
      if (!(await confirmDialog(t('Delete'), isOwner ? question : `${question} ${t("It is in someone else's folder: it goes to that person's trash, and only they can restore it.")}`, t('Delete'), true))) return;
      try {
        await del(`/api/nodes/${item.id}`);
        toast(isOwner ? t('"{name}" moved to trash', { name: item.name }) : t('"{name}" moved to the owner\'s trash', { name: item.name }));
        opts.reload();
      } catch (e) { showError(e); }
    } },
  ];
}

async function rename(item, reload) {
  // A refused name keeps the dialog open with the reason (it used to close, and what was typed was gone).
  const input = h('input', { type: 'text', required: true, value: item.name, 'aria-label': t('New name'), dir: 'auto' });
  const error = h('p', { class: 'error', role: 'alert' });
  const result = modal({
    title: t('Rename'),
    body: h('div', {}, h('label', { class: 'field' }, h('span', {}, t('New name')), input), error),
    buttons: [{ label: t('Cancel'), value: null }, { label: t('Rename'), value: 'ok', primary: true }],
    onSubmit: async () => {
      const name = input.value.trim();
      if (!name || name === item.name) return true;
      try {
        await patch(`/api/nodes/${item.id}`, { name });
        return true;
      } catch (e) {
        error.textContent = t(e.message);
        input.focus();
        return false;
      }
    },
  });
  const dot = item.name.lastIndexOf('.');
  if (!item.isDir && dot > 0) input.setSelectionRange(0, dot);
  if ((await result) === 'ok') reload();
}

// ---------------------------------------------------------------- dialogs

async function moveCopy(items, opts) {
  let current = opts.me.rootId;
  const list = h('ul', { class: 'picker-list' });
  const crumbs = h('nav', { class: 'breadcrumb small', 'aria-label': t('Folder path') });
  const go = (id) => load(id).catch(showError);
  const load = async (id) => {
    const data = await get(`/api/nodes/${id}`);
    current = id;
    const path = data.breadcrumb;
    const crumb = (c, i) => h('button', { type: 'button', class: 'crumb', dir: 'auto', 'aria-current': i === path.length - 1 ? 'location' : null, onclick: () => go(c.id) },
      c.id === opts.me.rootId ? t('Files') : c.name);
    crumbs.replaceChildren(...[
      // Inside a folder shared with you the path starts there: your own files stay one click away.
      path[0]?.id !== opts.me.rootId && h('button', { type: 'button', class: 'crumb', onclick: () => go(opts.me.rootId) }, t('Files')),
      path[0]?.id !== opts.me.rootId && h('span', { class: 'sep' }, icon('right')),
      ...path.flatMap((c, i) => [i ? h('span', { class: 'sep' }, icon('right')) : null, crumb(c, i)]),
    ].filter(Boolean));
    const dirs = data.children.filter((c) => c.isDir && !items.some((i) => i.id === c.id));
    list.replaceChildren(...(dirs.length ? dirs.map((d) => h('li', {},
      h('button', { type: 'button', onclick: () => go(d.id) }, icon('folder', 'ic-folder'), h('span', { class: 'grow' }, d.name), icon('right', 'muted')))) : [h('li', { class: 'muted' }, t('No subfolders'))]));
  };
  // Start in the folder the items are in (falls back to your files when that folder is not visible to you).
  const startAt = items.every((i) => i.parentId === items[0].parentId) ? items[0].parentId : null;
  await (startAt ? load(startAt).catch(() => load(current)) : load(current));
  const buttons = [{ label: t('Cancel'), value: null }, { label: t('Copy here'), value: 'copy', primary: !!opts.copyOnly }];
  if (!opts.copyOnly) buttons.push({ label: t('Move here'), value: 'move', primary: true });
  const what = items.length === 1 ? `"${items[0].name}"` : t('{n} items', { n: items.length });
  const title = opts.copyOnly ? t('Copy {what}', { what }) : t('Move or copy {what}', { what });
  const choice = await modal({ title, body: h('div', {}, crumbs, list), buttons });
  if (!choice) return;
  let done = 0;
  // Moving an item to the folder it is already in does nothing (it used to say "Moved").
  const todo = choice === 'move' ? items.filter((it) => it.parentId !== current) : items;
  if (!todo.length) return void toast(t('Already in this folder'));
  for (const it of todo) {
    try {
      if (choice === 'move') await patch(`/api/nodes/${it.id}`, { parentId: current });
      else await post(`/api/nodes/${it.id}/copy`, { parentId: current });
      done++;
    } catch (e) { showError(e); }
  }
  // Only claim success for what worked (each failure has its own error message).
  if (done) toast(choice === 'move' ? t('Moved') : t('Copied'), 'info', { label: t('Show'), onclick: () => navigate(`/files/${current}`) });
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

/** The person a share is with, by name; with the user name too when they differ (two people can share a name). */
const personName = (s) => (s.shareWithName && s.shareWithName !== s.shareWith ? `${s.shareWithName} (${s.shareWith})` : s.shareWith);

export async function shareDialog(item, reload) {
  const body = h('div', { class: 'share-dialog' });
  const datalist = h('datalist', { id: 'sharee-options' });
  const input = h('input', { type: 'text', list: 'sharee-options', placeholder: t('Username or group:name'), autocomplete: 'off', 'aria-label': t('Share with') });
  const canEditNew = h('input', { type: 'checkbox' });
  let timer;
  let suggestions = { users: [], groups: [] };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const found = await get(`/api/sharees?q=${encodeURIComponent(input.value.replace(/^group:/, ''))}`).catch(() => null);
      if (!found) return;
      suggestions = found;
      const { users, groups } = found;
      datalist.replaceChildren(
        ...users.map((u) => h('option', { value: u.id }, u.displayName)),
        ...groups.map((g) => h('option', { value: `group:${g.id}` }, t('Group {name}', { name: g.id }))),
      );
    }, 200);
  });

  let adding = false;
  const add = async () => {
    let v = input.value.trim();
    if (!v || adding) return;
    // "Anna Meier" or "ANNA" work too: the person whose name or username it is (it had to be the exact username).
    const lower = v.toLowerCase();
    const match = suggestions.users.find((u) => u.id.toLowerCase() === lower) ?? suggestions.users.find((u) => u.displayName?.toLowerCase() === lower);
    if (match && !v.startsWith('group:')) v = match.id;
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
    s.type === 'group' ? h('span', { class: 'avatar sm group-avatar', 'aria-hidden': 'true' }, icon('users'))
      : avatar({ id: s.shareWith, displayName: s.shareWithName || s.shareWith, avatar: s.shareWithAvatar }, 'sm'),
    h('span', { class: 'grow', dir: 'auto' }, s.type === 'group' ? t('Group {name}', { name: s.shareWith }) : personName(s)),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.canEdit, onchange: toggleShare(s) }), t('Can edit')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Remove share with {name}', { name: s.type === 'group' ? s.shareWith : personName(s) }), onclick: async () => { await del(`/api/shares/${s.id}`).catch(showError); refresh().catch(showError); } }, icon('x')),
  );

  const linkCard = (s) => {
    const url = location.origin + s.url;
    const pw = h('input', { type: 'password', placeholder: s.hasPassword ? t('•••••• (set)') : t('No password'), autocomplete: 'new-password', 'aria-label': t('Link password') });
    // The link stops working at the end of the chosen day in the user's own time zone (it used to be the server's).
    const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    // Typing a year sends a "change" for every digit (0002, 0020, 0202, 2027): only a date from today on is saved;
    // leaving the field with an earlier one puts the saved date back.
    const saved = s.expiresAt ? localDay(s.expiresAt) : '';
    const expiry = h('input', { type: 'date', value: saved, min: localDay(Date.now()), 'aria-label': t('Expiry date'), onchange: async (e) => {
      const v = e.target.value;
      if (v && v < localDay(Date.now())) return;
      await patch(`/api/shares/${s.id}`, { expiresAt: v ? new Date(`${v}T23:59:59`).toISOString() : null })
        .then(() => { s.expiresAt = v ? new Date(`${v}T23:59:59`).toISOString() : null; toast(v ? t('Expiry updated') : t('The link no longer expires')); }).catch(showError);
    }, onblur: (e) => {
      if (e.target.value && e.target.value < localDay(Date.now())) {
        toast(t('Choose a date from today on'), 'error');
        e.target.value = s.expiresAt ? localDay(s.expiresAt) : '';
      }
    } });
    const label = h('input', { type: 'text', value: s.label || '', maxlength: 100, placeholder: t('Label (who it is for)'), 'aria-label': t('Link label'), dir: 'auto', onchange: async (e) => {
      await patch(`/api/shares/${s.id}`, { label: e.target.value.trim() }).then(() => { s.label = e.target.value.trim(); toast(t('Label saved')); }, showError);
    } });
    const setPassword = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: async () => {
      await patch(`/api/shares/${s.id}`, { password: pw.value }).then(() => { toast(t('Password set')); return refresh(); }).catch(showError);
    } }, icon('lock'), t('Set'));
    // An empty field + "Set" used to remove the password without saying so; removing is its own button now.
    pw.addEventListener('input', () => { setPassword.disabled = pw.value.length < 4; });
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (pw.value) setPassword.click(); } });
    return h('li', { class: 'link-card' },
      h('div', { class: 'link-row' }, icon('link'), h('input', { type: 'text', readonly: true, value: url, dir: 'ltr', 'aria-label': t('Link URL'), onclick: (e) => e.target.select() }),
        h('button', { type: 'button', class: 'btn', onclick: () => copyText(url) }, icon('copy'), t('Copy')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Delete link'), onclick: async () => {
          if (!(await confirmDialog(t('Delete link'), t('People who have this link can no longer open it.'), t('Delete'), true))) return;
          await del(`/api/shares/${s.id}`).catch(showError);
          refresh().catch(showError);
        } }, icon('trash'))),
      h('div', { class: 'link-opts' },
        label,
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
  if (item.isDir) return void navigate(`/files/${item.id}`);
  const files = siblings.filter((s) => !s.isDir);
  openViewer(files, Math.max(0, files.findIndex((f) => f.id === item.id)), {
    url: nodeUrl,
    preview: (node) => (isOfficeFile(node) ? officePreviewUrl(node) : null),
    canEdit: opts.canModify(item) || item.owner === opts.me.id || opts.editable || !!item.canEdit,
    onSaved: opts.reload,
  });
}

export async function renderFolder(main, id, ctx) {
  // Whether the address is (still) folder `folderId`'s. This function finishes late when the server is slow, and its
  // reload runs after uploads and other actions: by then the user may be somewhere else.
  const isOpen = (folderId) => {
    const { view, arg } = currentView();
    return view === 'files' && String(/^\d+$/.test(arg) ? arg : ctx.me.rootId) === String(folderId); // as app.js reads the address
  };
  const data = await get(`/api/nodes/${id}`);
  if (!data.node.isDir) {
    // Not when the user has gone on meanwhile: the late answer used to pull them back, into this file's folder.
    if (isOpen(id)) navigate(`/files/${data.node.parentId ?? ctx.me.rootId}`, { replace: true });
    return;
  }
  const canEdit = data.perm !== 'read';
  // Redraws this folder if it is still the one open. Uploads finish late: by then the user may have opened another
  // view (nothing to do) or come back to this folder (a fresh render of the current route).
  const reload = () => {
    if (!isOpen(id)) return;
    // Own actions (favorite, rename, delete, sort, Undo…) keep the scroll position and the focus, as live updates do.
    if (main.isConnected) return keepPlace(main, () => renderFolder(main, id, ctx)).catch(showError);
    ctx.rerender();
  };
  const look = viewPrefs();
  const items = sortItems(data.children, look);
  const isOwnRoot = data.node.id === ctx.me.rootId;
  const here = { id: data.node.id, name: isOwnRoot ? t('Files') : data.node.name };
  // Every upload says where it went; when that folder is not the one on screen, the message offers to show it.
  // An upload that ends while items are ticked waits until the selection is done with (redrawing wiped it).
  const afterUpload = () => (list?.isConnected && list.hasSelection?.() ? ctx.refreshWhenFree?.() : reload());
  const uploadTo = (dest, items) => uploadAll(items, userUploadTarget(dest.id), afterUpload, {
    dest,
    isOnScreen: () => isOpen(dest.id),
    onShow: () => navigate(`/files/${dest.id}`),
  });
  const opts = {
    items, me: ctx.me, reload, editable: canEdit, folder: data.node, view: look.view, sort: look,
    onSort: (key) => { chooseSort(look, key); reload(); },
    canModify: () => canEdit,
    onOpen: (item) => openItem(item, items, opts),
    uploadInto: canEdit ? (folder, list) => uploadTo({ id: folder.id, name: folder.name }, list) : null,
    emptyText: canEdit ? t('Drop files here or use the Upload button') : t('This folder is empty'),
  };
  if (canEdit) opts.emptyAction = h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, icon('upload'), t('Upload files'));

  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { uploadTo(here, filesFromInput(e.target)); e.target.value = ''; } });
  const dirInput = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, onchange: (e) => { uploadTo(here, filesFromInput(e.target)); e.target.value = ''; } });

  // Path. Inside a folder shared with you it starts at that folder: "Shared with you" leads back to the list.
  const path = data.breadcrumb;
  const last = path.length - 1;
  const sharedPath = path[0]?.id !== ctx.me.rootId;
  // Someone else's folder: the sidebar shows where it came from. (Only for the folder the address is at: a render
  // that ended after the user clicked on used to mark "Shared with you" on the page that followed.)
  if (sharedPath && isOpen(id)) ctx.markNav?.('shared-in');
  const crumbs = h('nav', { class: 'breadcrumb', 'aria-label': t('Folder path') },
    sharedPath && [h('a', { class: 'crumb', href: '/shared-in' }, t('Shared with you')), h('span', { class: 'sep' }, icon('right'))],
    path.map((c, i) => {
      const name = c.id === ctx.me.rootId ? t('Files') : c.name;
      const a = h('a', { class: 'crumb', href: `/files/${c.id}`, dir: 'auto', 'aria-current': i === last ? 'page' : null }, name);
      // Rows dragged onto a parent folder in the path move there (the only way "up" without the dialog).
      if (canEdit && i !== last) {
        a.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-cloudy')) { e.preventDefault(); a.classList.add('drop-target'); } });
        a.addEventListener('dragleave', () => a.classList.remove('drop-target'));
        a.addEventListener('drop', async (e) => {
          a.classList.remove('drop-target');
          const raw = e.dataTransfer.getData('application/x-cloudy');
          if (!raw) return;
          e.preventDefault();
          await moveByDrop(JSON.parse(raw), { id: c.id, name }, opts);
          reload();
        });
      }
      return [i ? h('span', { class: 'sep' }, icon('right')) : null, a];
    }));

  const current = SORTS.find(([k]) => k === look.key);
  const sortBtn = items.length > 1 && h('button', { class: 'btn ghost sort-btn', 'data-key': 'sort-menu', 'aria-haspopup': 'menu', title: t('Sort'), 'aria-label': t('Sort: {by}', { by: t(current[1]) }), onclick: (e) => showMenu(e.currentTarget, [
    ...SORTS.map(([k, label]) => ({ label: t(label), icon: k === look.key ? 'check' : 'blank', onclick: () => { if (k !== look.key) { chooseSort(look, k); reload(); } } })),
    '-',
    { label: t(current[2]), icon: look.desc ? 'blank' : 'check', onclick: () => { setDescending(false); reload(); } },
    { label: t(current[3]), icon: look.desc ? 'check' : 'blank', onclick: () => { setDescending(true); reload(); } },
  ]) }, icon('sort'), h('span', { class: 'btn-label' }, t(current[1])));
  const viewBtn = (v, label, ic) => h('button', { type: 'button', 'data-key': `view-${v}`, 'aria-pressed': String(look.view === v), 'aria-label': label, title: label,
    onclick: () => { if (look.view !== v) { setView(v); reload(); } } }, icon(ic));
  const viewSwitch = items.length > 0 && h('div', { class: 'seg', role: 'group', 'aria-label': t('View') }, viewBtn('list', t('List'), 'list'), viewBtn('grid', t('Grid'), 'grid'));

  const newMenu = () => [
    { label: t('New folder'), icon: 'folderPlus', onclick: () => newFolder(id, reload) },
    { label: t('New text file'), icon: 'filePlus', onclick: async () => {
      const name = await promptDialog(t('New text file'), t('File name'), 'Notes.md', t('Create'), { selectBase: true });
      if (!name) return;
      // Without an extension it would be a file the editor does not open: it becomes a .txt file.
      const fileName = /\.[^.\s]+$/.test(name) ? name : `${name}.txt`;
      try {
        const node = await post(`/api/nodes/${id}/files`, { name: fileName, content: '' });
        await reload();
        openViewer([node], 0, { url: nodeUrl, canEdit: true, onSaved: reload });
      } catch (e) { showError(e); }
    } },
  ];
  const uploadMenu = () => [
    { label: t('Upload files'), icon: 'upload', onclick: () => fileInput.click() },
    { label: t('Upload folder'), icon: 'folder', onclick: () => dirInput.click() },
  ];
  const toolbar = h('div', { class: 'toolbar' }, crumbs, h('div', { class: 'grow' }), sortBtn, viewSwitch,
    canEdit && h('button', { class: 'btn new-btn', 'aria-haspopup': 'menu', onclick: (e) => showMenu(e.currentTarget, newMenu()) }, icon('plus'), h('span', { class: 'btn-label' }, t('New'))),
    canEdit && h('button', { class: 'btn primary upload-btn', 'aria-haspopup': 'menu', onclick: (e) => showMenu(e.currentTarget, uploadMenu()) }, icon('upload'), h('span', { class: 'btn-label' }, t('Upload'))),
    // Phones: one "+" for both menus, so the toolbar fits one line.
    canEdit && h('button', { class: 'btn primary add-btn', 'aria-haspopup': 'menu', 'aria-label': t('Add'), onclick: (e) => showMenu(e.currentTarget, [...uploadMenu(), '-', ...newMenu()]) }, icon('plus')),
    fileInput, dirInput,
  );

  const list = fileTable(opts);
  // The path shows the folder's name as the page title; screen readers get it as the page's heading too.
  const view = h('section', { class: 'files-view' }, h('h1', { class: 'sr-only', dir: 'auto' }, here.name), toolbar,
    !canEdit && h('p', { class: 'notice' }, icon('lock'), t('Shared with you as read-only')), list);
  // Files dragged in from the computer (drop.js): this folder, or the folder under the pointer.
  main.replaceChildren(view);
  // Only the folder that is on screen takes the drops (a late redraw of the folder before must not take them over).
  if (view.isConnected) {
    setDropTarget({ root: view, here, readOnly: !canEdit, upload: uploadTo });
    watchToolbar(toolbar);
  }
}

async function newFolder(parentId, reload) {
  // A name that is refused keeps the dialog open with the reason, instead of closing it and losing what was typed.
  const input = h('input', { type: 'text', required: true, value: t('New folder'), 'aria-label': t('Folder name') });
  const error = h('p', { class: 'error', role: 'alert' });
  const done = await modal({
    title: t('New folder'),
    body: h('div', {}, h('label', { class: 'field' }, h('span', {}, t('Folder name')), input), error),
    buttons: [{ label: t('Cancel'), value: null }, { label: t('Create'), value: 'ok', primary: true }],
    onSubmit: async () => {
      const name = input.value.trim();
      if (!name) return false;
      try {
        await post(`/api/nodes/${parentId}/folders`, { name });
        return true;
      } catch (e) {
        error.textContent = t(e.message);
        input.select();
        return false;
      }
    },
  });
  if (done) reload();
}

export function attachDropZone(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); // these files are ours: the page-wide strip (drop.js) stays away
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

async function listView(main, ctx, { title, iconName, items, emptyText, extraColumn, canModify, note, showInFolder = true }) {
  const opts = {
    items, me: ctx.me, extraColumn, emptyText, emptyIcon: iconName, showInFolder, moveTargets: false,
    canModify: canModify || ((i) => i.owner === ctx.me.id),
    reload: () => ctx.rerender(),
    onOpen: (item) => openItem(item, items, opts),
  };
  const toolbar = h('div', { class: 'toolbar' }, h('h1', { class: 'view-title' }, icon(iconName), h('span', { dir: 'auto', class: 'title-text' }, title)));
  main.replaceChildren(h('section', { class: 'files-view' }, toolbar, note && h('p', { class: 'muted small' }, note), fileTable(opts)));
  if (toolbar.isConnected) watchToolbar(toolbar);
}

export async function renderRecent(main, ctx) {
  const items = await get('/api/recent');
  await listView(main, ctx, { title: t('Recent'), iconName: 'clock', items, emptyText: t('No recently changed files'),
    note: items.length >= 100 ? t('The {n} most recently changed files.', { n: items.length }) : null });
}

export async function renderFavorites(main, ctx) {
  await listView(main, ctx, { title: t('Favorites'), iconName: 'star', items: await get('/api/favorites'), emptyText: t('Mark files with the star to find them here') });
}

export async function renderSharedIn(main, ctx) {
  await listView(main, ctx, {
    title: t('Shared with you'), iconName: 'users', items: await get('/api/shares/incoming'), emptyText: t('Nothing has been shared with you yet'),
    canModify: () => false,
    showInFolder: false, // each is shared on its own: its folder is the owner's
    extraColumn: {
      title: t('Shared by'),
      render: (i) => h('span', {}, avatar({ id: i.owner, displayName: i.ownerName, avatar: i.ownerAvatar }, 'xs'), h('span', { dir: 'auto' }, i.ownerName),
        i.canEdit ? [' ', h('span', { class: 'pill' }, t('can edit'))] : null),
      text: (i) => i.ownerName + (i.canEdit ? ` (${t('can edit')})` : ''),
    },
  });
}

export async function renderSharedOut(main, ctx) {
  const shares = await get('/api/shares/outgoing');
  const byNode = new Map();
  for (const s of shares) {
    const entry = byNode.get(s.node.id) || { ...s.node, targets: [] };
    entry.targets.push(s.type === 'link' ? (s.label ? t('link "{label}"', { label: s.label }) : t('link')) : s.type === 'group' ? t('group {name}', { name: s.shareWith }) : personName(s));
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
    title: query ? t('Search: “{query}”', { query }) : t('Search'), iconName: 'search', items,
    emptyText: query ? t('No matching files') : t('Type a name in the search box above'),
    // The server answers at most 200 matches: when that many come back, say there may be more.
    note: items.length >= 200 ? t('Showing the first {n} matches. Type more of the name to narrow it down.', { n: items.length }) : null,
    // An item shared with you on its own: its folder is the owner's, so the location is no link.
    extraColumn: { title: t('Location'), render: (i) => (i.parentVisible === false ? h('span', { dir: 'auto' }, i.path || '/') : h('a', { href: `/files/${i.parentId}`, dir: 'auto' }, i.path || '/')) },
  });
}

export async function renderTrash(main, ctx) {
  const items = await get('/api/trash');
  const reload = () => renderTrash(main, ctx).catch(showError);

  // Some items at once: tick them (a click on a row ticks it too; phones show the boxes once one is ticked),
  // then restore or delete them from the bar.
  const selected = new Set();
  const rowOf = new Map(); // id → { tr, box }
  const bar = h('div', { class: 'selection-bar', hidden: true });
  const allBox = h('input', { type: 'checkbox', 'aria-label': t('Select all') });
  let table;
  const setSelected = (it, on) => {
    on ? selected.add(it.id) : selected.delete(it.id);
    const r = rowOf.get(it.id);
    if (r) { r.box.checked = on; r.tr.classList.toggle('selected', on); }
  };
  // As in the file lists: the bar's buttons are made once (rebuilt on every tick, a button pressed by keyboard lost
  // the focus), and "3 selected" is read out from a region that is there before the first tick.
  const chosen = () => items.filter((it) => selected.has(it.id));
  const count = h('span', {});
  const said = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  bar.append(
    h('button', { class: 'icon-btn', 'aria-label': t('Clear selection'), title: t('Clear selection'), onclick: () => {
      for (const it of chosen()) setSelected(it, false);
      updateBar();
      allBox.focus({ preventScroll: true }); // the bar is gone: the keyboard continues at the table
    } }, icon('x')),
    count,
    h('button', { class: 'btn ghost', onclick: whileBusy(bar, async () => {
      let restored = 0;
      for (const it of chosen()) await post(`/api/trash/${it.id}/restore`).then(() => { restored++; }, showError);
      if (restored) toast(t('{n} item(s) restored', { n: restored }));
      reload();
    }) }, icon('restore'), t('Restore')),
    h('button', { class: 'btn ghost danger', onclick: whileBusy(bar, async () => {
      const list = chosen();
      if (!(await confirmDialog(t('Delete permanently'), t('{n} item(s) will be deleted forever.', { n: list.length }), t('Delete'), true))) return;
      for (const it of list) await del(`/api/trash/${it.id}`).catch(showError);
      reload();
    }) }, icon('trash'), t('Delete permanently')));
  const updateBar = () => {
    bar.hidden = selected.size === 0;
    table?.classList.toggle('selecting', selected.size > 0);
    allBox.checked = selected.size > 0 && selected.size === items.length;
    count.textContent = t('{n} selected', { n: selected.size });
    said.textContent = selected.size ? count.textContent : '';
  };
  allBox.addEventListener('change', () => {
    for (const it of items) setSelected(it, allBox.checked);
    updateBar();
  });

  const rows = items.map((it) => {
    const box = h('input', { type: 'checkbox', 'aria-label': t('Select {name}', { name: it.name }), onclick: (e) => e.stopPropagation(), onchange: (e) => {
      setSelected(it, e.target.checked);
      updateBar();
    } });
    const tr = h('tr', { class: 'file-row', onclick: (e) => {
      if (e.target.closest('button')) return;
      setSelected(it, !selected.has(it.id));
      updateBar();
    } },
      h('td', { class: 'col-check' }, box),
      h('td', { class: 'col-name' }, h('div', { class: 'name-cell' }, fileIcon(it), h('span', { class: 'name', dir: 'auto' }, it.name))),
      h('td', { class: 'col-extra muted' }, it.originalPath),
      h('td', { class: 'col-size' }, formatSize(it.size)),
      h('td', { class: 'col-date', title: fullDate(it.deletedAt) }, formatDate(it.deletedAt)),
      h('td', { class: 'col-actions nowrap' },
        h('button', { class: 'btn ghost', onclick: async (e) => {
          e.currentTarget.disabled = true;
          await post(`/api/trash/${it.id}/restore`).then((r) => toast(r.name !== it.name ? t('Restored as "{name}"', { name: r.name }) : t('"{name}" restored', { name: it.name }),
            'info', { label: t('Show'), onclick: () => navigate(`/files/${r.parentId}`) }), showError);
          reload();
        } }, icon('restore'), h('span', { class: 'btn-label' }, t('Restore'))),
        h('button', { class: 'icon-btn', 'aria-label': t('Delete {name} permanently', { name: it.name }), onclick: async () => {
          if (await confirmDialog(t('Delete permanently'), t('"{name}" will be deleted forever.', { name: it.name }), t('Delete'), true)) { await del(`/api/trash/${it.id}`).catch(showError); reload(); }
        } }, icon('trash'))),
    );
    rowOf.set(it.id, { tr, box });
    return tr;
  });
  table = h('table', { class: 'file-table trash-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'col-check' }, allBox),
      h('th', { class: 'col-name' }, t('Name')),
      h('th', { class: 'col-extra' }, t('Original location')),
      h('th', { class: 'col-size' }, t('Size')),
      h('th', { class: 'col-date' }, t('Deleted')),
      h('th', { class: 'col-trash-actions' }, h('span', { class: 'sr-only' }, t('Actions'))))),
    h('tbody', {}, rows));
  const toolbar = h('div', { class: 'toolbar' }, h('h1', { class: 'view-title' }, icon('trash'), t('Deleted files')), h('div', { class: 'grow' }),
    items.length > 0 && h('button', { class: 'btn danger', onclick: async () => {
      if (await confirmDialog(t('Empty trash'), t('All deleted files will be removed permanently.'), t('Empty trash'), true)) { await del('/api/trash').catch(showError); reload(); }
    } }, t('Empty trash')));
  main.replaceChildren(h('section', { class: 'files-view' },
    toolbar,
    h('p', { class: 'muted small view-lead' }, t('Deleted items are removed permanently after {n} days.', { n: ctx.me?.trashDays ?? 30 })),
    items.length ? h('div', {}, bar, said, table) : h('div', { class: 'empty' }, icon('trash'), h('p', {}, t('Trash is empty'))),
  ));
  if (toolbar.isConnected) watchToolbar(toolbar);
}
