// Settings window. The accounts on a rail at the side (picture, name, status badge; then "Add account" and, at the
// bottom, the app's own settings); the page next to it for the chosen one: sign in → choose where the files go and
// what to sync → status, folder, folders to sync, activity. The very first sign-in fills the whole window.
// English only: t() fills in {name} placeholders.
const cloudy = window.cloudy;
const app = document.getElementById('app');
const live = document.getElementById('live'); // screen readers: status changes are announced here
let announced = '';

let state = null;
let view = ''; // "<kind>:<account id>", e.g. "main:3f2a…", "login:new", "general:app"
let current = null; // the chosen account's id
let adding = false; // signing in to another account
let general = false; // the app's own settings page
let folders = null; // the current account's top-level server folders (setup and main view)
let foldersError = null; // why they could not be loaded (offline, signed out)
let foldersFor = null; // which account `folders` belongs to
let twoFactor = false;
let setupFolder = null;
let setupExcluded = [];

/** The chosen account (the first one when the chosen one is gone). */
const acc = () => state.accounts.find((a) => a.id === current) ?? state.accounts[0] ?? null;

function t(text, vars) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== '') el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

/** Line icons (stroke only), drawn in the current colour. */
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  out: 'M7 17 17 7M8 7h9v9',
};
function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const logo = (cls) => h('img', { class: cls, src: 'logo.svg', alt: '' });

// People look the same everywhere: the web app's and the phone apps' colour for a name (Java's String.hashCode).
const AVATAR_COLORS = ['#0B6BCB', '#0E9AA7', '#1F9D55', '#E8772E', '#E0457B', '#8B5CF6', '#D93A3A', '#3B66D9'];
function nameColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (Math.imul(31, hash) + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[((hash % 8) + 8) % 8];
}
const initialsOf = (name) => String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => Array.from(p)[0] ?? '').join('').toUpperCase() || '?';

/** An account's picture, else its initials. Decorative: the name is always written next to it or in its label. */
function avatar(a, size = '') {
  const name = a.displayName || a.user;
  const el = h('span', { class: `avatar ${size}`, 'aria-hidden': 'true' });
  el.style.setProperty('--av', nameColor(name));
  if (a.avatar) el.append(h('img', { src: a.avatar, alt: '', draggable: 'false' }));
  else el.textContent = initialsOf(name);
  return el;
}

/** A path in the home folder as "~/…" (shorter; the full path is in its tooltip). */
const tilde = (p) => (state.home && p && (p === state.home || p.startsWith(state.home + '/')) ? '~' + p.slice(state.home.length) : p);

/** "Error invoking remote method 'cloudy': ApiError: Offline" → "Offline" */
const cleanError = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');

// ---------------------------------------------------------------- views

function nextView() {
  const a = acc();
  if (!a || adding) return { kind: 'login', id: 'new' };
  if (general) return { kind: 'general', id: 'app' };
  return { kind: !a.signedIn ? 'login' : !a.configured ? 'setup' : 'main', id: a.id };
}

let pane = null; // the page area next to the rail

function render() {
  const { kind, id } = nextView();
  const key = `${kind}:${id}`;
  const sameView = key === view;
  if (id !== 'new' && id !== 'app') current = id;
  const first = !state.accounts.length;
  if (key === view && kind !== 'main' && kind !== 'general') { if (!first) rail(); return; } // keep what the user is typing
  // The main view follows every status change (a few times a second while syncing). Only the parts whose data
  // changed are rebuilt (see part()); keep keyboard focus and the scroll positions in those, or keyboard and
  // screen reader users lose their place each time.
  const focused = key === view ? document.activeElement?.dataset?.key : null;
  const scrolls = key === view ? [...app.querySelectorAll('[data-key]')].filter((el) => el.scrollTop).map((el) => [el.dataset.key, el.scrollTop]) : [];
  const y = pane?.scrollTop ?? 0;
  if (key === view) {
    rail();
    if (kind === 'main') mainParts();
    else generalParts();
  } else {
    if (view.split(':')[1] !== id) { twoFactor = false; setupFolder = null; setupExcluded = []; }
    view = key;
    for (const k in parts) if (k !== 'rail') delete parts[k];
    if ((kind === 'setup' || kind === 'main') && foldersFor !== id) { folders = null; foldersError = null; foldersFor = id; loadFolders().then(render); }
    const body = kind === 'login' ? loginView() : kind === 'setup' ? setupView() : kind === 'general' ? generalView() : mainView();
    if (first) {
      delete parts.rail;
      pane = null;
      app.replaceChildren(h('div', { class: 'welcome' }, body));
    } else {
      pane = h('main', { class: 'pane' }, body);
      delete parts.rail;
      app.replaceChildren(h('div', { class: 'shell' }, rail(), pane));
    }
  }
  const byKey = (k) => app.querySelector(`[data-key="${CSS.escape(k)}"]`);
  for (const [k, top] of scrolls) { const el = byKey(k); if (el) el.scrollTop = top; }
  if (sameView && pane) pane.scrollTop = y;
  if (focused && document.activeElement?.dataset?.key !== focused) byKey(focused)?.focus({ preventScroll: true });
  // Announce the status when it changes in kind (not every "Syncing 3 of 120").
  const a = acc();
  const say = kind === 'main' ? `${a.id}|${a.status?.phase ?? ''}|${a.status?.phase === 'syncing' ? '' : a.statusText}` : '';
  if (say !== announced) { announced = say; live.textContent = kind === 'main' ? a.statusText : ''; }
}

/** How an account is doing, as the colour of its badge and dot. */
function tone(a) {
  const p = a.status?.phase;
  if (!a.signedIn || ['error', 'auth', 'offline'].includes(p)) return 'bad';
  if (a.paused || !a.configured) return 'paused';
  if (p === 'syncing') return 'busy';
  return a.problems?.length ? 'warn' : 'ok';
}

/** A short line under the name on the rail. */
function railStatus(a) {
  if (!a.signedIn) return t('Signed out');
  if (!a.configured) return t('Not set up yet');
  return a.statusText;
}

/** The rail: brand, the accounts, "Add account", and the app's settings at the bottom. */
function rail() {
  const deps = [adding, general, current, ...state.accounts.flatMap((a) => [a.id, a.label, a.avatar, tone(a), railStatus(a)])];
  return part('rail', deps, () => h('nav', { class: 'rail', 'aria-label': t('Accounts') },
    h('div', { class: 'brand' }, logo(), h('span', {}, 'Cloudy')),
    state.accounts.length > 1 && h('div', { class: 'rail-title' }, t('Accounts')),
    state.accounts.map((a) => h('button', {
      'data-key': `account:${a.id}`,
      'aria-current': !adding && !general && a.id === current ? 'page' : null,
      'aria-label': `${a.label}, ${railStatus(a)}`,
      title: `${a.label} · ${a.host}`,
      onclick: () => { adding = false; general = false; current = a.id; render(); },
    },
    h('span', { class: 'face' }, avatar(a, 'sm'), h('span', { class: `badge ${tone(a)}`, 'aria-hidden': 'true' })),
    h('span', { class: 'who' }, h('b', { class: 'ellipsis' }, a.label), h('span', { class: 'ellipsis' }, railStatus(a))))),
    h('button', {
      class: 'add',
      'data-key': 'account:add',
      'aria-current': adding ? 'page' : null,
      title: t('Add account'),
      onclick: () => { adding = true; general = false; twoFactor = false; render(); },
    }, h('span', { class: 'glyph' }, icon('plus')), h('span', { class: 'who' }, t('Add account'))),
    h('button', {
      class: 'app-settings',
      'data-key': 'general',
      'aria-current': general && !adding ? 'page' : null,
      title: t('Settings'),
      onclick: () => { adding = false; general = true; render(); },
    }, h('span', { class: 'glyph' }, icon('gear')), h('span', { class: 'who' }, t('Settings')))));
}

function loginView() {
  const a = adding ? null : acc(); // signing in again to this account (signed out by the server)
  const first = !state.accounts.length;
  const error = h('p', { class: 'error', role: 'alert' });
  const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
  const codeRow = h('label', { class: twoFactor ? 'field' : 'field hidden' }, t('Two-factor code'), code);
  const button = h('button', { class: 'primary', type: 'submit' }, t('Sign in'));
  const form = h('form', {
    class: 'login',
    async onsubmit(e) {
      e.preventDefault();
      const f = new FormData(form);
      button.disabled = true;
      button.textContent = t('Signing in…');
      error.textContent = '';
      const r = await cloudy.call('login', f.get('server'), f.get('user'), f.get('password'), f.get('code') || undefined, a?.id)
        .catch((err) => ({ error: cleanError(err) }));
      button.disabled = false;
      button.textContent = t('Sign in');
      if (r.error) {
        error.textContent = r.error;
        if (r.twoFactor) { twoFactor = true; codeRow.classList.remove('hidden'); code.focus(); }
      } else if (r.id) {
        // The new account may not have reached this window yet: take the whole state, or the page falls back to
        // the first account.
        merge(await cloudy.call('state'));
        adding = false;
        current = r.id;
        render();
      }
    },
  },
  first ? logo('logo') : a ? h('div', { class: 'hero' }, avatar(a, 'big'), h('div', {}, h('h1', {}, t('Sign in again')), h('p', { class: 'muted' }, `${a.user} · ${a.host}`))) : null,
  !a && h('h1', {}, first ? t('Sign in to Cloudy') : t('Add an account')),
  a?.folder
    ? h('p', { class: 'note' }, t('The server signed you out. Sign in again as {user} to keep syncing {path}.', { user: a.user, path: tilde(a.folder) }))
    : h('p', { class: 'muted' }, first
      ? t('Keep a folder on this computer in sync with your Cloudy files.')
      : t('Each account gets its own folder, next to the others.')),
  h('label', { class: 'field' }, t('Server address'), h('input', { name: 'server', required: true, value: a?.server ?? state.accounts[0]?.server ?? '', placeholder: 'https://cloud.example.com', autocomplete: 'url', dir: 'ltr' })),
  h('label', { class: 'field' }, t('Username'), h('input', { name: 'user', required: true, value: a?.user ?? '', autocomplete: 'username', dir: 'ltr' })),
  h('label', { class: 'field' }, t('Password'), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
  codeRow,
  error,
  h('div', { class: 'actions' },
    a && h('button', { class: 'link', type: 'button', onclick: () => cloudy.call('logout', a.id) }, t('Remove this account')),
    h('span', { class: 'push' }),
    adding && state.accounts.length > 0 && h('button', { type: 'button', onclick: () => { adding = false; render(); } }, t('Cancel')),
    button));
  queueMicrotask(() => form.querySelector(a ? '[name=password]' : state.accounts.length ? '[name=user]' : '[name=server]')?.focus());
  return first ? form : h('div', { class: 'page' }, form);
}

function folderList(excluded, onToggle) {
  if (!folders) return h('p', { class: 'muted' }, t('Loading folders…'));
  if (foldersError) {
    return h('p', { class: 'muted' }, t('Could not load the folders: {message}', { message: foldersError }), ' ',
      h('button', { class: 'link', 'data-key': 'folders-retry', onclick: () => { folders = null; delete parts.folders; loadFolders().then(render); render(); } }, t('Try again')));
  }
  if (!folders.length) return h('p', { class: 'muted' }, t('There are no folders on the server yet. Everything will be synced.'));
  return h('ul', { class: 'folders', 'data-key': 'folders' }, folders.map((name) => h('li', {},
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', 'data-key': `folder:${name}`, checked: !excluded.includes(name), onchange: (e) => onToggle(name, e.target.checked) }),
      h('span', { class: 'folder-icon', 'aria-hidden': 'true' }),
      h('span', { dir: 'auto' }, name)))));
}

// One request per account at a time; switching accounts starts the other account's own request.
const loading = new Map();
function loadFolders() {
  const id = foldersFor;
  if (!loading.has(id)) {
    loading.set(id, cloudy.call('folders', id).then((f) => { if (foldersFor === id) { folders = f; foldersError = null; } },
      (e) => { if (foldersFor === id) { folders = []; foldersError = cleanError(e); } }).finally(() => loading.delete(id)));
  }
  return loading.get(id);
}

/** The account's picture as a button: choose a new one, or remove it. */
function pictureButton(a) {
  const btn = h('button', {
    class: 'pic',
    'data-key': 'picture',
    'aria-label': a.avatar ? t('Change or remove your profile picture') : t('Add a profile picture'),
    'aria-haspopup': a.avatar ? 'menu' : null,
    title: a.avatar ? t('Change or remove your profile picture') : t('Add a profile picture'),
    onclick: () => (a.avatar ? pictureMenu(a, btn) : choosePicture(a)),
  }, avatar(a, 'xl'), h('span', { class: 'cam', 'aria-hidden': 'true' }, icon('camera')));
  return btn;
}

function pictureMenu(a, anchor) {
  const menu = h('div', { class: 'menu', popover: 'auto', role: 'menu' },
    h('button', { role: 'menuitem', onclick: () => { menu.hidePopover(); choosePicture(a); } }, t('Choose a new picture…')),
    h('button', { role: 'menuitem', class: 'danger', onclick: async () => {
      menu.hidePopover();
      if (!confirm(t('Remove your profile picture? Your initials are shown instead, everywhere you use Cloudy.'))) return;
      const r = await cloudy.call('removeAvatar', a.id).catch((e) => ({ error: cleanError(e) }));
      if (r?.error) alert(r.error);
    } }, t('Remove picture')));
  menu.addEventListener('toggle', (e) => { if (e.newState === 'closed') menu.remove(); });
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${r.left}px`;
  menu.showPopover();
  menu.querySelector('button').focus();
}

/** Picks a picture, crops it to the middle square (at most 512 pixels, on white, no metadata), shows it, stores it. */
function choosePicture(a) {
  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    let canvas;
    let bytes;
    try {
      const bmp = await createImageBitmap(file); // upright: the picture's own orientation is applied
      const side = Math.min(bmp.width, bmp.height);
      const out = Math.min(512, side);
      canvas = h('canvas', { width: out, height: out, 'aria-label': t('Preview of the new picture'), role: 'img' });
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, out, out);
      g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch {
      alert(t('This picture can’t be opened. Choose a JPEG, PNG or WebP picture.'));
      return;
    }
    const error = h('p', { class: 'error', role: 'alert' });
    const save = h('button', { class: 'primary', type: 'submit', value: 'save' }, t('Save'));
    const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': 'pic-title' },
      h('form', {
        method: 'dialog',
        async onsubmit(e) {
          if (e.submitter?.value !== 'save') return;
          e.preventDefault();
          save.disabled = true;
          const r = await cloudy.call('setAvatar', a.id, bytes).catch((err) => ({ error: cleanError(err) }));
          save.disabled = false;
          if (r?.error) error.textContent = r.error;
          else dlg.close();
        },
      },
      h('h2', { id: 'pic-title' }, t('New profile picture')),
      canvas,
      h('p', { class: 'muted small' }, t('Shown on the web, in the phone apps and to the people you share with.')),
      error,
      h('div', { class: 'actions' }, h('button', { type: 'submit', value: 'cancel' }, t('Cancel')), save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    save.focus();
  });
  input.click();
}

function setupView() {
  const a = acc();
  setupFolder ??= a.folder ?? a.defaultFolder;
  const wrap = h('div', { class: 'page' });
  const draw = async () => {
    const hasFiles = await cloudy.call('folderHasFiles', setupFolder);
    const error = h('p', { class: 'error', role: 'alert' });
    wrap.replaceChildren(
      h('header', { class: 'hero' }, avatar(a, 'big'), h('div', {},
        h('h1', {}, t('Set up {name}', { name: a.label })),
        h('p', { class: 'muted' }, t('Choose where the files go on this computer and which folders to sync.')))),
      h('section', {},
        h('h2', {}, t('Where your files go')),
        h('div', { class: 'place' },
          h('span', { class: 'folder-icon', 'aria-hidden': 'true' }),
          h('span', { class: 'path', dir: 'ltr', title: setupFolder }, tilde(setupFolder)),
          h('button', { onclick: async () => { const p = await cloudy.call('chooseFolder', a.id); if (p) { setupFolder = p; draw(); } } }, t('Change…'))),
        h('p', { class: 'muted small' }, t('You can pick any place on this computer: Cloudy makes a {folder} folder there for this account.', { folder: `Cloudy/${setupFolder.split(/[\\/]/).filter(Boolean).pop()}` })),
        hasFiles && h('p', { class: 'note' }, t('This folder already has files. They are merged with your Cloudy files; nothing is overwritten.'))),
      h('section', { class: 'block' },
        h('h2', {}, t('Folders to sync')),
        folders?.length > 0 && h('p', { class: 'muted small' }, t('Files at the top level of your Cloudy are always synced.')),
        folderList(setupExcluded, (name, on) => {
          setupExcluded = on ? setupExcluded.filter((n) => n !== name) : [...setupExcluded, name];
        })),
      h('section', { class: 'block' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: state.openAtLogin, onchange: (e) => cloudy.call('setOpenAtLogin', e.target.checked) }),
          h('span', {}, t('Start Cloudy when I log in')))),
      error,
      h('div', { class: 'actions' },
        h('button', { class: 'link', onclick: () => cloudy.call('logout', a.id) }, t('Remove this account')),
        h('button', {
          class: 'primary push',
          async onclick(e) {
            e.target.disabled = true;
            const r = await cloudy.call('setup', a.id, setupFolder, setupExcluded).catch((err) => ({ error: cleanError(err) }));
            e.target.disabled = false;
            if (r?.error) error.textContent = r.error;
          },
        }, t('Start syncing'))));
  };
  if (!folders) loadFolders().then(() => { if (view === `setup:${a.id}`) draw(); });
  draw();
  return wrap;
}

const KIND = {
  uploaded: 'Uploaded',
  downloaded: 'Downloaded',
  'deleted-local': 'Deleted on this computer',
  'deleted-remote': 'Deleted on the server',
  moved: 'Moved or renamed',
  conflict: 'Edited in two places: kept both',
  folder: 'Folder created',
};

/** Parts of a page, each rebuilt only when the values it depends on change. */
const parts = {};
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Builds `name` from `build()`, or keeps the existing element while `deps` are unchanged. */
function part(name, deps, build) {
  const p = parts[name];
  if (p && same(p.deps, deps)) return p.el;
  const el = build() || h('section', { class: 'hidden' }); // a placeholder keeps the part's place in the view
  if (p?.el.isConnected) p.el.replaceWith(el);
  parts[name] = { deps, el };
  return el;
}

const time = (ms) => new Date(ms).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });

function mainView() {
  // The status panel stays the same element: its dot keeps pulsing instead of restarting with every update.
  const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const text = h('div', {});
  const progress = h('progress', { class: 'hidden' });
  const extra = h('div', {});
  parts.status = { el: h('section', { class: 'status' }, h('div', { class: 'status-line' }, dot, text), progress, extra), text, progress, extra };
  return h('div', { class: 'page' }, ...mainParts());
}

/** Brings every part of an account's page up to date; returns them in order. */
function mainParts() {
  const a = acc();
  const s = a.status;
  const syncing = s?.phase === 'syncing';
  const paused = a.paused;

  const hero = part('hero', [a.id, a.label, a.avatar, a.user, a.host, state.weakStore], () => h('header', { class: 'hero' },
    pictureButton(a),
    h('div', {}, h('h1', { class: 'ellipsis' }, a.label), h('p', { class: 'muted ellipsis', dir: 'ltr' }, `${a.user} · ${a.host}`),
      // Linux without GNOME Keyring or KWallet: said plainly instead of pretending the sign-in is protected.
      state.weakStore && h('p', { class: 'muted small', 'data-key': 'weak-store' }, t('No system keyring: the sign-in is stored without real encryption.')))));

  const st = parts.status;
  const cls = `status ${tone(a)}`;
  if (st.el.className !== cls) st.el.className = cls;
  if (!same(st.textDeps ?? [], st.textDeps = [a.statusText, a.statusDetail, syncing && s.current, !syncing && s?.lastSync])) {
    st.text.replaceChildren(...[
      h('strong', {}, a.statusText),
      a.statusDetail && h('div', { class: 'muted small', dir: 'auto' }, a.statusDetail),
      s?.current && syncing && h('div', { class: 'muted small ellipsis', dir: 'auto', title: s.current }, s.current),
      !syncing && s?.lastSync && h('div', { class: 'muted small' }, t('Last synced {time}', { time: time(s.lastSync) })),
    ].filter(Boolean));
  }
  const showProgress = syncing && s.total > 0;
  st.progress.classList.toggle('hidden', !showProgress);
  if (showProgress) {
    st.progress.max = s.total;
    st.progress.value = s.done;
    st.progress.setAttribute('aria-label', a.statusText);
  }
  if (!same(st.extraDeps ?? [], st.extraDeps = [a.id, paused, s?.phase === 'auth'])) {
    st.el.setAttribute('aria-label', t('Status'));
    st.extra.replaceChildren(h('div', { class: 'actions' },
      s?.phase === 'auth' && h('button', { class: 'primary', 'data-key': 'reauth', onclick: () => cloudy.call('signInAgain', a.id) }, t('Sign in again')),
      h('button', { class: s?.phase === 'auth' ? '' : 'primary', 'data-key': 'open', onclick: () => cloudy.call('openFolder', a.id) }, t('Open folder')),
      h('button', { 'data-key': 'sync', onclick: () => cloudy.call('syncNow', a.id), disabled: paused }, t('Sync now')),
      h('button', { 'data-key': 'pause', onclick: () => cloudy.call(paused ? 'resume' : 'pause', a.id) }, paused ? t('Resume') : t('Pause')),
      h('button', { class: 'link push', 'data-key': 'web', onclick: () => cloudy.call('openWeb', a.id) }, t('Open in browser'))));
  }

  const problems = part('problems', [a.problems], () => a.problems.length > 0 && h('section', { class: 'problems' },
    h('h2', {}, a.problems.length === 1 ? t('1 item is not synced') : t('{count} items are not synced', { count: a.problems.length })),
    a.problems.length > 50 && h('p', { class: 'muted small' }, t('Showing 50 of {count}.', { count: a.problems.length })),
    h('ul', { class: 'list', 'data-key': 'problems' }, a.problems.slice(0, 50).map((p) =>
      h('li', {}, h('div', { class: 'ellipsis', dir: 'auto' }, p.path), h('div', { class: 'muted small' }, p.message))))));

  const place = part('place', [a.id, a.folder, a.excluded.join('\0')], () => h('section', { class: 'block' },
    h('h2', {}, t('Sync folder')),
    h('div', { class: 'place' },
      h('span', { class: 'folder-icon', 'aria-hidden': 'true' }),
      h('span', { class: 'path', dir: 'ltr', title: a.folder }, tilde(a.folder)),
      h('button', {
        'data-key': 'change-folder',
        async onclick() {
          const p = await cloudy.call('chooseFolder', a.id);
          if (p && p !== a.folder && confirm(t('Sync with "{path}" instead? Syncing starts over there; the old folder is left as it is.', { path: p }))) {
            const r = await cloudy.call('setup', a.id, p, a.excluded).catch((err) => ({ error: cleanError(err) }));
            if (r?.error) alert(r.error);
          }
        },
      }, t('Change…')))));

  const folderCard = part('folders', [folders, foldersError, a.excluded.join('\0')], () => h('section', { class: 'block' },
    h('h2', {}, t('Folders to sync')),
    folders?.length > 0 && h('p', { class: 'muted small' }, t('Turn a folder off to keep it only on the server.')),
    folderList(a.excluded, async (name, on) => {
      if (!on && !confirm(t('Stop syncing "{name}"? Its files are removed from this computer (to the trash) but stay on the server.', { name }))) {
        delete parts.folders; // put the checkbox back
        return render();
      }
      await cloudy.call('setExcluded', a.id, on ? a.excluded.filter((n) => n !== name) : [...a.excluded, name]);
    })));

  const activity = part('activity', [a.activity], () => h('section', { class: 'block' },
    h('h2', {}, t('Recent activity')),
    a.activity.length
      ? h('ul', { class: 'list', 'data-key': 'activity' }, a.activity.slice(0, 30).map((x) =>
        h('li', {}, h('div', { class: 'ellipsis', dir: 'auto', title: x.path }, x.path),
          h('div', { class: 'muted small' }, `${t(KIND[x.kind] ?? x.kind)}, ${time(x.time)}`))))
      : h('p', { class: 'muted' }, t('Nothing yet. Changes on either side show up here.'))));

  const leave = part('leave', [a.id, a.label], () => h('section', { class: 'block' },
    h('div', { class: 'row' },
      h('div', {}, h('div', {}, t('Sign out of this account')),
        h('div', { class: 'muted small' }, t('Syncing stops; the files on this computer stay where they are.'))),
      h('button', { class: 'danger', 'data-key': 'logout', onclick: () => cloudy.call('logout', a.id) }, t('Sign out')))));

  return [hero, st.el, problems, place, folderCard, activity, leave];
}

// ---------------------------------------------------------------- the app's own settings and About

function generalView() {
  return h('div', { class: 'page' }, ...generalParts());
}

function generalParts() {
  const head = part('g-head', [], () => h('header', {}, h('h1', {}, t('Settings')),
    h('p', { class: 'muted' }, t('For Cloudy on this computer, all accounts.'))));

  const startup = part('g-start', [state.openAtLogin], () => h('section', { class: 'block' },
    h('h2', {}, t('Startup')),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', 'data-key': 'login-item', checked: state.openAtLogin, onchange: (e) => cloudy.call('setOpenAtLogin', e.target.checked) }),
      h('span', {}, t('Start Cloudy when I log in')))));

  // Sync badges in the file manager (null: none in this copy, e.g. development runs).
  const b = state.badges;
  const finder = part('g-finder', [JSON.stringify(b)], () => {
    if (!b) return null;
    const where = {
      finder: [t('Finder'), t('Show sync status in Finder'), null],
      explorer: [t('File Explorer'), t('Show sync status in File Explorer'),
        t('Turning this on asks for administrator permission once. They appear after you sign out of Windows and back in.')],
      linux: [t('File manager'), t('Show sync status in the file manager'),
        t('GNOME Files, Nemo and Caja need their Python extension package (for example python3-nautilus); Dolphin needs Cloudy’s .deb package. The first time, they appear after you sign out and back in.')],
    }[b.where];
    if (!where) return null;
    return h('section', { class: 'block' },
      h('h2', {}, where[0]),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', 'data-key': 'finder', checked: b.state === 'on', onchange: (e) => cloudy.call('setBadges', e.target.checked).then((now) => { e.target.checked = now === 'on'; }, () => {}) }),
        h('span', {}, where[1])),
      h('p', { class: 'muted small' }, t('A green tick on synced items, blue arrows while they sync, and a red mark on items that could not be synced (listed on the account’s page).')),
      where[2] && h('p', { class: 'muted small' }, where[2]));
  });

  const u = state.update ?? { state: 'idle' };
  const updates = part('g-update', [JSON.stringify(u), state.version], () => {
    const updateText = {
      checking: t('Checking for updates…'),
      none: t('Cloudy is up to date. Checked at {time}.', { time: new Date(u.checkedAt).toLocaleTimeString('en', { timeStyle: 'short' }) }),
      downloading: t('Downloading Cloudy {version}… {percent}%', { version: u.version, percent: u.percent ?? 0 }),
      ready: t('Cloudy {version} is ready to install.', { version: u.version }),
      available: t('Cloudy {version} is available.', { version: u.version }),
      error: t('Could not check for updates: {message}', { message: u.message }),
    }[u.state];
    return h('section', { class: 'block' },
      h('h2', {}, t('Updates')),
      h('div', { class: 'row' },
        h('div', {}, h('div', {}, t('Version {version}', { version: state.version })), updateText && h('div', { class: 'muted small' }, updateText)),
        u.state === 'ready' ? h('button', { class: 'primary', 'data-key': 'update', onclick: () => cloudy.call('installUpdate') }, t('Restart and update'))
          : u.state === 'available' ? h('button', { 'data-key': 'update', onclick: () => cloudy.call('openRelease') }, t('Download'))
            : h('button', { 'data-key': 'update', onclick: () => cloudy.call('checkUpdates'), disabled: ['checking', 'downloading'].includes(u.state) }, t('Check for updates'))));
  });

  const about = part('g-about', [state.version], () => {
    const link = (key, ic, title, detail) => h('li', {}, h('button', { 'data-key': `link:${key}`, onclick: () => cloudy.call('openLink', key) },
      icon(ic), h('span', {}, h('span', {}, title), detail && h('span', { class: 'muted small' }, detail)), icon('out', 'out')));
    const panel = h('div', { class: 'about' },
      logo(),
      h('strong', {}, 'Cloudy'),
      h('p', {}, `© ${new Date().getFullYear()} Fahed Alhammadi. All rights reserved.`),
      h('span', { class: 'version' }, t('Version {version}', { version: state.version })));
    // A few stars, as on the phones' About panel.
    for (const [x, y] of [[12, 22], [22, 70], [80, 18], [90, 62], [70, 84], [35, 12]]) {
      const s = h('span', { class: 'star', 'aria-hidden': 'true' });
      s.style.left = `${x}%`;
      s.style.top = `${y}%`;
      panel.append(s);
    }
    return h('section', { class: 'block', 'aria-label': t('About Cloudy') },
      h('h2', {}, t('About Cloudy')),
      panel,
      h('ul', { class: 'links' },
        link('help', 'help', t('Help')),
        link('feedback', 'chat', t('Send feedback')),
        link('website', 'globe', t('Website'), 'fahed-alhammadi.github.io/Cloudy'),
        link('privacy', 'shield', t('Privacy policy'))),
      h('p', { class: 'muted small foot' }, t('Open source under the MIT License.')));
  });

  return [head, startup, finder, updates, about];
}

// ---------------------------------------------------------------- start

/** Updates carry each account's problems, activity and picture only when they changed: merge account by account. */
function merge(data) {
  const old = new Map((state.accounts ?? []).map((a) => [a.id, a]));
  state = { ...state, ...data, accounts: (data.accounts ?? state.accounts).map((a) => ({ ...(old.get(a.id) ?? {}), ...a })) };
}

cloudy.onUpdate((data) => {
  if (!state) return;
  merge(data);
  render();
});

cloudy.call('state').then((s) => {
  state = s;
  // Start with the first account that needs attention (not signed in, or no folder yet).
  current = (s.accounts.find((a) => !a.configured) ?? s.accounts[0])?.id ?? null;
  render();
});
