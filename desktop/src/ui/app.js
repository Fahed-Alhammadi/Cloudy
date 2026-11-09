// Settings window: sign in → choose folder and what to sync → status, folders, activity, account.
// All texts go through t() with English keys (desktop/i18n/<lang>.json, sent by the main process).
const cloudy = window.cloudy;
const app = document.getElementById('app');
const live = document.getElementById('live'); // screen readers: status changes are announced here
let announced = '';

let state = null;
let view = '';
let folders = null; // top-level server folders (setup and main view)
let foldersError = null; // why they could not be loaded (offline, signed out)
let twoFactor = false;
let setupFolder = null;
let setupExcluded = [];

function t(text, vars) {
  let out = state?.strings?.[text] ?? text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

const locale = () => (state?.lang === 'ar' ? 'ar-u-nu-latn' : state?.lang ?? 'en');

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
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const logo = () => h('img', { class: 'logo', src: 'logo.svg', alt: '' });

/** "Error invoking remote method 'cloudy': ApiError: Offline" → "Offline" */
const cleanError = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');

// ---------------------------------------------------------------- views

function render() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.rtl ? 'rtl' : 'ltr';
  const next = !state.signedIn ? 'login' : !state.configured ? 'setup' : 'main';
  if (next === view && next !== 'main') return; // keep what the user is typing
  // The main view follows every status change (a few times a second while syncing). Only the parts whose data
  // changed are rebuilt (see part()); keep keyboard focus and the scroll positions in those, or keyboard and
  // screen reader users lose their place each time.
  const focused = next === view ? document.activeElement?.dataset?.key : null;
  const scrolls = next === view ? [...app.querySelectorAll('[data-key]')].filter((el) => el.scrollTop).map((el) => [el.dataset.key, el.scrollTop]) : [];
  const y = window.scrollY;
  if (next === 'main' && view === 'main') mainParts();
  else {
    view = next;
    for (const k in parts) delete parts[k];
    app.replaceChildren(next === 'login' ? loginView() : next === 'setup' ? setupView() : mainView());
  }
  const byKey = (k) => app.querySelector(`[data-key="${CSS.escape(k)}"]`);
  for (const [k, top] of scrolls) { const el = byKey(k); if (el) el.scrollTop = top; }
  if (next === 'main') window.scrollTo(0, y);
  if (focused && document.activeElement?.dataset?.key !== focused) byKey(focused)?.focus({ preventScroll: true });
  // Announce the status when it changes in kind (not every "Syncing 3 of 120").
  const say = next === 'main' ? `${state.status?.phase ?? ''}|${state.status?.phase === 'syncing' ? '' : state.statusText}` : '';
  if (say !== announced) { announced = say; live.textContent = next === 'main' ? state.statusText : ''; }
}

function loginView() {
  const error = h('p', { class: 'error', role: 'alert' });
  const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
  const codeRow = h('label', { class: twoFactor ? '' : 'hidden' }, t('Two-factor code'), code);
  const button = h('button', { class: 'primary', type: 'submit' }, t('Sign in'));
  const form = h('form', {
    class: 'card login',
    async onsubmit(e) {
      e.preventDefault();
      const f = new FormData(form);
      button.disabled = true;
      button.textContent = t('Signing in…');
      error.textContent = '';
      const r = await cloudy.call('login', f.get('server'), f.get('user'), f.get('password'), f.get('code') || undefined)
        .catch((err) => ({ error: cleanError(err) }));
      button.disabled = false;
      button.textContent = t('Sign in');
      if (r.error) {
        error.textContent = r.error;
        if (r.twoFactor) { twoFactor = true; codeRow.classList.remove('hidden'); code.focus(); }
      }
    },
  },
  logo(),
  h('h1', {}, t('Sign in to Cloudy')),
  state.folder
    ? h('p', { class: 'note' }, t('Sign in again to keep syncing {path}. Another account starts over with a new folder.', { path: state.folder }))
    : h('p', { class: 'muted' }, t('Keep a folder on this computer in sync with your Cloudy files.')),
  h('label', {}, t('Server address'), h('input', { name: 'server', required: true, value: state.server ?? '', placeholder: 'https://cloud.example.com', autocomplete: 'url', dir: 'ltr' })),
  h('label', {}, t('Username'), h('input', { name: 'user', required: true, value: state.user ?? '', autocomplete: 'username', dir: 'ltr' })),
  h('label', {}, t('Password'), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
  codeRow,
  error,
  button);
  queueMicrotask(() => form.querySelector(state.server ? '[name=password]' : '[name=server]')?.focus());
  return form;
}

function folderList(excluded, onToggle) {
  if (!folders) return h('p', { class: 'muted' }, t('Loading folders…'));
  if (foldersError) {
    return h('p', { class: 'muted' }, t('Could not load the folders: {message}', { message: foldersError }), ' ',
      h('button', { class: 'link', 'data-key': 'folders-retry', onclick: () => { folders = null; loadFolders().then(render); render(); } }, t('Try again')));
  }
  if (!folders.length) return h('p', { class: 'muted' }, t('There are no folders on the server yet. Everything will be synced.'));
  return h('ul', { class: 'folders', 'data-key': 'folders' }, folders.map((name) => h('li', {},
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', 'data-key': `folder:${name}`, checked: !excluded.includes(name), onchange: (e) => onToggle(name, e.target.checked) }),
      h('span', { class: 'folder-icon', 'aria-hidden': 'true' }),
      h('span', {}, name)))));
}

let loading = null;
function loadFolders() {
  loading ??= cloudy.call('folders').then((f) => { folders = f; foldersError = null; }, (e) => { folders = []; foldersError = cleanError(e); }).finally(() => { loading = null; });
  return loading;
}

function setupView() {
  setupFolder ??= state.folder ?? state.defaultFolder;
  const wrap = h('div', { class: 'card setup' });
  const draw = async () => {
    const hasFiles = await cloudy.call('folderHasFiles', setupFolder);
    const error = h('p', { class: 'error', role: 'alert' });
    wrap.replaceChildren(
      logo(),
      h('h1', {}, t('Choose what to sync')),
      h('h2', {}, t('Folder on this computer')),
      h('div', { class: 'path-row' },
        h('code', { dir: 'ltr' }, setupFolder),
        h('button', { onclick: async () => { const p = await cloudy.call('chooseFolder'); if (p) { setupFolder = p; draw(); } } }, t('Change…'))),
      hasFiles && h('p', { class: 'note' }, t('This folder already has files. They are merged with your Cloudy files; nothing is overwritten.')),
      h('h2', {}, t('Folders to sync')),
      folderList(setupExcluded, (name, on) => {
        setupExcluded = on ? setupExcluded.filter((n) => n !== name) : [...setupExcluded, name];
      }),
      h('p', { class: 'muted small' }, t('Files at the top level of your Cloudy are always synced.')),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.openAtLogin, onchange: (e) => cloudy.call('setOpenAtLogin', e.target.checked) }),
        h('span', {}, t('Start Cloudy when I log in'))),
      error,
      h('div', { class: 'actions' },
        h('button', { class: 'link', onclick: () => cloudy.call('logout') }, t('Sign out')),
        h('button', {
          class: 'primary',
          async onclick(e) {
            e.target.disabled = true;
            const r = await cloudy.call('setup', setupFolder, setupExcluded).catch((err) => ({ error: cleanError(err) }));
            e.target.disabled = false;
            if (r?.error) error.textContent = r.error;
          },
        }, t('Start syncing'))));
  };
  if (!folders) loadFolders().then(draw);
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

/** Parts of the main view, each rebuilt only when the values it depends on change. */
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

const time = (ms) => new Date(ms).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });

function mainView() {
  // The status card stays the same element: its dot keeps pulsing instead of restarting with every update.
  const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const text = h('div', {});
  const progress = h('progress', { class: 'hidden' });
  const extra = h('div', {});
  parts.status = { el: h('section', { class: 'card status' }, h('div', { class: 'status-line' }, dot, text), progress, extra), text, progress, extra };
  return h('div', { class: 'stack' }, ...mainParts());
}

/** Brings every part of the main view up to date; returns them in order. */
function mainParts() {
  const s = state.status;
  const syncing = s?.phase === 'syncing';
  const paused = state.paused;
  const tone = ['error', 'auth', 'offline'].includes(s?.phase) ? 'bad' : paused ? 'paused' : syncing ? 'busy' : state.problems.length ? 'warn' : 'ok';

  const st = parts.status;
  const cls = `card status ${tone}`;
  if (st.el.className !== cls) st.el.className = cls;
  if (!same(st.textDeps ?? [], st.textDeps = [state.strings, state.lang, state.statusText, state.statusDetail, syncing && s.current, !syncing && s?.lastSync])) {
    st.text.replaceChildren(...[
      h('strong', {}, state.statusText),
      state.statusDetail && h('div', { class: 'muted small', dir: 'auto' }, state.statusDetail),
      s?.current && syncing && h('div', { class: 'muted small ellipsis', dir: 'auto', title: s.current }, s.current),
      !syncing && s?.lastSync && h('div', { class: 'muted small' }, t('Last synced {time}', { time: time(s.lastSync) })),
    ].filter(Boolean));
  }
  const showProgress = syncing && s.total > 0;
  st.progress.classList.toggle('hidden', !showProgress);
  if (showProgress) {
    st.progress.max = s.total;
    st.progress.value = s.done;
    st.progress.setAttribute('aria-label', state.statusText);
  }
  if (!same(st.extraDeps ?? [], st.extraDeps = [state.strings, paused, s?.phase === 'auth'])) {
    st.el.setAttribute('aria-label', t('Status'));
    st.extra.replaceChildren(...[
      s?.phase === 'auth' && h('button', { class: 'primary', 'data-key': 'reauth', onclick: () => cloudy.call('signInAgain') }, t('Sign in again')),
      h('div', { class: 'actions start' },
        h('button', { 'data-key': 'open', onclick: () => cloudy.call('openFolder') }, t('Open folder')),
        h('button', { 'data-key': 'sync', onclick: () => cloudy.call('syncNow'), disabled: paused }, t('Sync now')),
        h('button', { 'data-key': 'pause', onclick: () => cloudy.call(paused ? 'resume' : 'pause') }, paused ? t('Resume') : t('Pause')),
        h('button', { class: 'link', 'data-key': 'web', onclick: () => cloudy.call('openWeb') }, t('Open in browser'))),
    ].filter(Boolean));
  }

  const problems = part('problems', [state.strings, state.problems], () => state.problems.length > 0 && h('section', { class: 'card' },
    h('h2', {}, t('Not synced')),
    state.problems.length > 50 && h('p', { class: 'muted small' }, t('Showing 50 of {count}.', { count: state.problems.length })),
    h('ul', { class: 'list', 'data-key': 'problems' }, state.problems.slice(0, 50).map((p) =>
      h('li', {}, h('div', { class: 'ellipsis', dir: 'auto' }, p.path), h('div', { class: 'muted small' }, p.message))))));

  const folderCard = part('folders', [state.strings, folders, foldersError, state.excluded.join('\0')], () => h('section', { class: 'card' },
    h('h2', {}, t('Folders to sync')),
    folderList(state.excluded, async (name, on) => {
      if (!on && !confirm(t('Stop syncing "{name}"? Its files are removed from this computer (to the trash) but stay on the server.', { name }))) {
        delete parts.folders; // put the checkbox back
        return render();
      }
      await cloudy.call('setExcluded', on ? state.excluded.filter((n) => n !== name) : [...state.excluded, name]);
    })));

  const activity = part('activity', [state.strings, state.lang, state.activity], () => h('section', { class: 'card' },
    h('h2', {}, t('Recent activity')),
    state.activity.length
      ? h('ul', { class: 'list', 'data-key': 'activity' }, state.activity.slice(0, 30).map((a) =>
        h('li', {}, h('div', { class: 'ellipsis', dir: 'auto' }, a.path),
          h('div', { class: 'muted small' }, `${t(KIND[a.kind] ?? a.kind)} · ${time(a.time)}`))))
      : h('p', { class: 'muted' }, t('Nothing yet.'))));

  const u = state.update ?? { state: 'idle' };
  const general = part('general', [state.strings, state.lang, JSON.stringify(u), state.folder, state.excluded.join('\0'), state.openAtLogin,
    state.version, state.displayName, state.user, state.server], () => {
    const updateText = {
      checking: t('Checking for updates…'),
      none: t('Cloudy is up to date. Checked at {time}.', { time: new Date(u.checkedAt).toLocaleTimeString(locale(), { timeStyle: 'short' }) }),
      downloading: t('Downloading Cloudy {version}… {percent}%', { version: u.version, percent: u.percent ?? 0 }),
      ready: t('Cloudy {version} is ready to install.', { version: u.version }),
      available: t('Cloudy {version} is available.', { version: u.version }),
      error: t('Could not check for updates: {message}', { message: u.message }),
    }[u.state];
    return h('section', { class: 'card' },
      h('h2', {}, t('Settings')),
      h('div', { class: 'row' },
        h('div', {}, h('div', {}, t('Sync folder')), h('code', { dir: 'ltr' }, state.folder)),
        h('button', {
          'data-key': 'change-folder',
          async onclick() {
            const p = await cloudy.call('chooseFolder');
            if (p && p !== state.folder && confirm(t('Sync with "{path}" instead? Syncing starts over there; the old folder is left as it is.', { path: p }))) {
              const r = await cloudy.call('setup', p, state.excluded).catch((err) => ({ error: cleanError(err) }));
              if (r?.error) alert(r.error);
            }
          },
        }, t('Change…'))),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', 'data-key': 'login-item', checked: state.openAtLogin, onchange: (e) => cloudy.call('setOpenAtLogin', e.target.checked) }),
        h('span', {}, t('Start Cloudy when I log in'))),
      h('div', { class: 'row' },
        h('div', {}, h('div', {}, t('Version {version}', { version: state.version })), updateText && h('div', { class: 'muted small' }, updateText)),
        u.state === 'ready' ? h('button', { class: 'primary', 'data-key': 'update', onclick: () => cloudy.call('installUpdate') }, t('Restart and update'))
          : u.state === 'available' ? h('button', { 'data-key': 'update', onclick: () => cloudy.call('openRelease') }, t('Download'))
            : h('button', { 'data-key': 'update', onclick: () => cloudy.call('checkUpdates'), disabled: ['checking', 'downloading'].includes(u.state) }, t('Check for updates'))),
      h('div', { class: 'row' },
        h('div', {}, h('div', {}, state.displayName || state.user), h('div', { class: 'muted small', dir: 'ltr' }, state.server)),
        h('button', { class: 'danger', 'data-key': 'logout', onclick: () => cloudy.call('logout') }, t('Sign out'))));
  });

  return [st.el, problems, folderCard, activity, general];
}

// ---------------------------------------------------------------- start

cloudy.onUpdate((data) => {
  if (!state) return;
  const before = state.signedIn;
  state = { ...state, ...data };
  if (before !== state.signedIn) { folders = null; twoFactor = false; setupFolder = null; setupExcluded = []; }
  if (state.signedIn && !folders) loadFolders().then(render);
  render();
});

cloudy.call('state').then((s) => {
  state = s;
  if (state.signedIn) loadFolders().then(() => { if (view === 'main') render(); });
  render();
});
