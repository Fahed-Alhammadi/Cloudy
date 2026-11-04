// DOM helpers, icons, dialogs and formatting shared by all views.
import { t, locale } from './i18n.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) { if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v); }
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val);
    }
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const P = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  text: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  contacts: '<path d="M16 2v2"/><path d="M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/><path d="M8 2v2"/><circle cx="12" cy="11" r="3"/><rect x="3" y="4" width="18" height="18" rx="2"/>',
  settings: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  move: '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  folderPlus: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" x2="12" y1="10" y2="16"/><line x1="9" x2="15" y1="13" y2="13"/>',
  filePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}${name === 'left' || name === 'right' ? ' mirror-rtl' : ''}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || P.file}</svg>`;
  return span;
}

export function fileIcon(node) {
  if (node.isDir) return icon('folder', 'ic-folder');
  const m = node.mime || '';
  if (m.startsWith('image/')) return icon('image', 'ic-image');
  if (m.startsWith('video/')) return icon('video', 'ic-video');
  if (m.startsWith('audio/')) return icon('audio', 'ic-audio');
  if (m === 'application/pdf') return icon('text', 'ic-pdf');
  if (/zip|tar|gzip|7z|rar/.test(m)) return icon('archive', 'ic-archive');
  if (m.startsWith('text/') || /json|xml/.test(m)) return icon('text', 'ic-text');
  return icon('file', 'ic-file');
}

export function formatSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  // Isolated so "9.0 MB" keeps its order inside right-to-left (Arabic) text.
  return `\u2068${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}\u2069`;
}

export function formatDate(value) {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const d = new Date(value);
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return d.toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' });
}
export const fullDate = (v) => new Date(v).toLocaleString(locale());

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// ---------------------------------------------------------------- toasts

export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) document.body.append((host = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' })));
  const t = h('div', { class: `toast ${kind}` }, message);
  host.append(t);
  // Errors stay a little longer: they usually need reading.
  const ms = kind === 'error' ? 6000 : 3500;
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 500);
}

// Server messages are English; the ones in the dictionary are shown translated.
export function showError(e) {
  toast(t(e?.message || String(e)), 'error');
}

// ---------------------------------------------------------------- dialogs

/**
 * Opens a modal <dialog>. `buttons` are [{label, value, primary, danger}].
 * Resolves with the clicked button's value (or null when dismissed).
 * `onSubmit(value)` may return false to keep the dialog open; while it runs the buttons are disabled,
 * so a double click can't send the same request twice.
 */
let dialogSeq = 0;
export function modal({ title, body, buttons = [{ label: t('Close'), value: null }], wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const titleId = `dlg-title-${++dialogSeq}`;
    const form = h('form', { method: 'dialog', class: 'dialog-form' });
    const dlg = h('dialog', { class: `modal ${wide ? 'wide' : ''}`, 'aria-labelledby': titleId },
      h('header', {}, h('h2', { id: titleId }, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close'), onclick: () => dlg.close('') }, icon('x'))),
    );
    form.append(h('div', { class: 'modal-body' }, body));
    const footer = h('footer', {});
    let busy = false;
    const run = async (value) => {
      if (!onSubmit) return true;
      busy = true;
      const controls = [...footer.querySelectorAll('button')].filter((b) => !b.disabled);
      controls.forEach((b) => { b.disabled = true; });
      dlg.setAttribute('aria-busy', 'true');
      try {
        return (await onSubmit(value)) !== false;
      } catch (e) {
        showError(e);
        return false;
      } finally {
        busy = false;
        controls.forEach((b) => { b.disabled = false; });
        dlg.removeAttribute('aria-busy');
      }
    };
    for (const b of buttons) {
      footer.append(h('button', {
        type: b.primary ? 'submit' : 'button',
        class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
        value: String(b.value ?? ''),
        onclick: b.primary ? null : async () => {
          if (busy) return;
          if (b.value != null && !(await run(b.value))) return;
          dlg.close(String(b.value ?? ''));
        },
      }, b.label));
    }
    if (buttons.length) form.append(footer);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const primary = buttons.find((b) => b.primary);
      if (!(await run(primary?.value))) return;
      dlg.close(String(primary?.value ?? ''));
    });
    dlg.append(form);
    // Escape while a request runs would leave it finishing in the background: wait for it.
    dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue;
      const btn = buttons.find((b) => String(b.value ?? '') === v && v !== '');
      dlg.remove();
      resolve(btn ? btn.value : null);
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input:not([type=checkbox]):not([disabled]), textarea, select');
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}

export async function confirmDialog(title, message, okLabel = t('OK'), danger = false) {
  const v = await modal({ title, body: h('p', {}, message), buttons: [{ label: t('Cancel'), value: null }, { label: okLabel, value: 'ok', primary: true, danger }] });
  return v === 'ok';
}

/** `selectBase`: select only the part before the extension (renaming "Report.pdf" keeps ".pdf"). */
export async function promptDialog(title, label, initial = '', okLabel = t('OK'), { selectBase = false } = {}) {
  const input = h('input', { type: 'text', value: initial, required: true, 'aria-label': label });
  const result = modal({
    title,
    body: h('label', { class: 'field' }, h('span', {}, label), input),
    buttons: [{ label: t('Cancel'), value: null }, { label: okLabel, value: 'ok', primary: true }],
  });
  const dot = initial.lastIndexOf('.');
  if (selectBase && dot > 0) input.setSelectionRange(0, dot);
  return (await result) === 'ok' ? input.value.trim() : null;
}

// ---------------------------------------------------------------- popover menus

let openMenu = null;
let menuAnchor = null;
export function closeMenu({ refocus = false } = {}) {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  const anchor = menuAnchor;
  menuAnchor = null;
  if (anchor) {
    anchor.removeAttribute('aria-expanded');
    if (refocus && anchor.isConnected) anchor.focus();
  }
}
// A click on the button that opened the menu closes it (instead of closing and opening it again).
let swallowAnchorClick = null;
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) {
    swallowAnchorClick = menuAnchor && menuAnchor.contains(e.target) ? menuAnchor : null;
    closeMenu();
  }
}, true);
document.addEventListener('click', (e) => {
  if (swallowAnchorClick && swallowAnchorClick.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
  swallowAnchorClick = null;
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { e.preventDefault(); closeMenu({ refocus: true }); } });

/**
 * Shows a menu of [{label, icon, onclick, danger}] next to `anchor` (an element, or an {x,y} point).
 * Keyboard: arrows/Home/End move, Escape closes and returns focus to the anchor, Tab closes.
 */
export function showMenu(anchor, items) {
  closeMenu();
  const isEl = anchor instanceof Element;
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((it) => it === '-' ? h('hr') : h('button', {
      type: 'button', role: 'menuitem', tabindex: -1, class: it.danger ? 'danger' : '',
      onclick: (e) => {
        e.stopPropagation();
        closeMenu({ refocus: true });
        // Errors of the chosen action (a dialog that failed to load, say) are shown, not lost.
        Promise.resolve().then(() => it.onclick()).catch(showError);
      },
    }, it.icon ? icon(it.icon) : null, h('span', {}, it.label))),
  );
  const entries = () => [...menu.querySelectorAll('[role=menuitem]')];
  menu.addEventListener('keydown', (e) => {
    const list = entries();
    const i = list.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'Tab') { e.preventDefault(); closeMenu({ refocus: true }); return; }
    if (next) { e.preventDefault(); next.focus(); }
  });
  document.body.append(menu);
  const r = isEl ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  // Opens towards the reading direction's start: under the anchor's right edge (left edge in RTL).
  const rtl = document.documentElement.dir === 'rtl';
  let left = Math.min(rtl ? r.left : r.right - mw, window.innerWidth - mw - 8);
  if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  openMenu = menu;
  // Focus goes back to the button (or the row that was right-clicked) when the menu closes.
  menuAnchor = isEl ? anchor : (document.activeElement !== document.body ? document.activeElement : null);
  if (isEl) anchor.setAttribute('aria-expanded', 'true');
  entries()[0]?.focus();
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast(t('Copied to clipboard')), () => promptDialog(t('Copy this'), t('Text'), text));
}
