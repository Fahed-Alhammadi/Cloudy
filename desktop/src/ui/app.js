// Settings window: accounts along the top (each with its status dot, plus "Add account"); for the chosen account:
// sign in → choose folder and what to sync → status, folders, activity, account. Shared settings at the bottom.
// English only: t() fills in {name} placeholders.
const cloudy = window.cloudy;
const app = document.getElementById('app');
const live = document.getElementById('live'); // screen readers: status changes are announced here
let announced = '';

let state = null;
let view = ''; // "<kind>:<account id>", e.g. "main:3f2a…", "login:new"
let current = null; // the chosen account's id
let adding = false; // signing in to another account
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
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const logo = () => h('img', { class: 'logo', src: 'logo.svg', alt: '' });

/** "Error invoking remote method 'cloudy': ApiError: Offline" → "Offline" */
const cleanError = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');

// ---------------------------------------------------------------- views

function nextView() {
  const a = acc();
  if (!a || adding) return { kind: 'login', id: 'new' };
  return { kind: !a.signedIn ? 'login' : !a.configured ? 'setup' : 'main', id: a.id };
}

function render() {
  const { kind, id } = nextView();
  const key = `${kind}:${id}`;
  if (id !== 'new') current = id;
  if (key === view && kind !== 'main') { accountBar(); return; } // keep what the user is typing
  // The main view follows every status change (a few times a second while syncing). Only the parts whose data
  // changed are rebuilt (see part()); keep keyboard focus and the scroll positions in those, or keyboard and
  // screen reader users lose their place each time.
  const focused = key === view ? document.activeElement?.dataset?.key : null;
  const scrolls = key === view ? [...app.querySelectorAll('[data-key]')].filter((el) => el.scrollTop).map((el) => [el.dataset.key, el.scrollTop]) : [];
  const y = window.scrollY;
  if (key === view) mainParts();
  else {
    if (view.split(':')[1] !== id) { twoFactor = false; setupFolder = null; setupExcluded = []; }
    view = key;
    for (const k in parts) delete parts[k];
    if (kind !== 'login' && foldersFor !== id) { folders = null; foldersError = null; foldersFor = id; loadFolders().then(render); }
    const body = kind === 'login' ? loginView() : kind === 'setup' ? setupView() : mainView();
    app.replaceChildren(...[state.accounts.length > 0 && accountBar(), body].filter(Boolean));
  }
  const byKey = (k) => app.querySelector(`[data-key="${CSS.escape(k)}"]`);
  for (const [k, top] of scrolls) { const el = byKey(k); if (el) el.scrollTop = top; }
  if (kind === 'main') window.scrollTo(0, y);
  if (focused && document.activeElement?.dataset?.key !== focused) byKey(focused)?.focus({ preventScroll: true });
  // Announce the status when it changes in kind (not every "Syncing 3 of 120").
  const a = acc();
  const say = kind === 'main' ? `${a.id}|${a.status?.phase ?? ''}|${a.status?.phase === 'syncing' ? '' : a.statusText}` : '';
  if (say !== announced) { announced = say; live.textContent = kind === 'main' ? a.statusText : ''; }
}

/** How an account is doing, as the colour of its dot (same tones as the status card). */
function tone(a) {
  const p = a.status?.phase;
  if (!a.signedIn || !a.configured || ['error', 'auth', 'offline'].includes(p)) return 'bad';
  if (a.paused) return 'paused';
  if (p === 'syncing') return 'busy';
  return a.problems?.length ? 'warn' : 'ok';
}

/** The accounts along the top: choose one, or add another. Rebuilt only when what it shows changed. */
function accountBar() {
  const deps = [adding, current, ...state.accounts.flatMap((a) => [a.id, a.label, tone(a)])];
  return part('accounts', deps, () => h('nav', { class: 'accounts', 'aria-label': t('Accounts') },
    state.accounts.map((a) => h('button', {
      class: `account ${tone(a)}`,
      'data-key': `account:${a.id}`,
      'aria-current': !adding && a.id === current ? 'page' : null,
      title: `${a.label} · ${a.server}`,
      onclick: () => { adding = false; current = a.id; render(); },
    }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'ellipsis' }, a.label))),
    h('button', {
      class: 'account add',
      'data-key': 'account:add',
      'aria-current': adding ? 'page' : null,
      onclick: () => { adding = true; twoFactor = false; render(); },
    }, t('+ Add account'))));
}

function loginView() {
  const a = adding ? null : acc(); // signing in again to this account (signed out by the server)
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
      const r = await cloudy.call('login', f.get('server'), f.get('user'), f.get('password'), f.get('code') || undefined, a?.id)
        .catch((err) => ({ error: cleanError(err) }));
      button.disabled = false;
      button.textContent = t('Sign in');
      if (r.error) {
        error.textContent = r.error;
        if (r.twoFactor) { twoFactor = true; codeRow.classList.remove('hidden'); code.focus(); }
      } else if (r.id) {
        adding = false;
        current = r.id;
        render();
      }
    },
  },
  logo(),
  h('h1', {}, a ? t('Sign in again') : state.accounts.length ? t('Add an account') : t('Sign in to Cloudy')),
  a?.folder
    ? h('p', { class: 'note' }, t('Sign in again as {user} to keep syncing {path}.', { user: a.user, path: a.folder }))
    : h('p', { class: 'muted' }, state.accounts.length
      ? t('Each account gets its own folder, next to the others.')
      : t('Keep a folder on this computer in sync with your Cloudy files.')),
  h('label', {}, t('Server address'), h('input', { name: 'server', required: true, value: a?.server ?? state.accounts[0]?.server ?? '', placeholder: 'https://cloud.example.com', autocomplete: 'url', dir: 'ltr' })),
  h('label', {}, t('Username'), h('input', { name: 'user', required: true, value: a?.user ?? '', autocomplete: 'username', dir: 'ltr' })),
  h('label', {}, t('Password'), h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
  codeRow,
  error,
  h('div', { class: 'actions' },
    a && h('button', { class: 'link', type: 'button', onclick: () => cloudy.call('logout', a.id) }, t('Remove this account')),
    adding && state.accounts.length > 0 && h('button', { type: 'button', onclick: () => { adding = false; render(); } }, t('Cancel')),
    button));
  queueMicrotask(() => form.querySelector(a ? '[name=password]' : state.accounts.length ? '[name=user]' : '[name=server]')?.focus());
  return form;
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
      h('span', {}, name)))));
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

function setupView() {
  const a = acc();
  setupFolder ??= a.folder ?? a.defaultFolder;
  const wrap = h('div', { class: 'card setup' });
  const draw = async () => {
    const hasFiles = await cloudy.call('folderHasFiles', setupFolder);
    const error = h('p', { class: 'error', role: 'alert' });
    wrap.replaceChildren(
      logo(),
      h('h1', {}, t('Choose what to sync')),
      h('p', { class: 'muted' }, t('{name} on {server}', { name: a.label, server: a.server })),
      h('h2', {}, t('Folder on this computer')),
      h('div', { class: 'path-row' },
        h('code', { dir: 'ltr' }, setupFolder),
        h('button', { onclick: async () => { const p = await cloudy.call('chooseFolder', a.id); if (p) { setupFolder = p; draw(); } } }, t('Change…'))),
      hasFiles ? h('p', { class: 'note' }, t('This folder already has files. They are merged with your Cloudy files; nothing is overwritten.')) : '',
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
        h('button', { class: 'link', onclick: () => cloudy.call('logout', a.id) }, t('Sign out')),
        h('button', {
          class: 'primary',
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

const time = (ms) => new Date(ms).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' });

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
  const a = acc();
  accountBar();
  const s = a.status;
  const syncing = s?.phase === 'syncing';
  const paused = a.paused;

  const st = parts.status;
  const cls = `card status ${tone(a)}`;
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
    st.extra.replaceChildren(...[
      s?.phase === 'auth' && h('button', { class: 'primary', 'data-key': 'reauth', onclick: () => cloudy.call('signInAgain', a.id) }, t('Sign in again')),
      h('div', { class: 'actions start' },
        h('button', { 'data-key': 'open', onclick: () => cloudy.call('openFolder', a.id) }, t('Open folder')),
        h('button', { 'data-key': 'sync', onclick: () => cloudy.call('syncNow', a.id), disabled: paused }, t('Sync now')),
        h('button', { 'data-key': 'pause', onclick: () => cloudy.call(paused ? 'resume' : 'pause', a.id) }, paused ? t('Resume') : t('Pause')),
        h('button', { class: 'link', 'data-key': 'web', onclick: () => cloudy.call('openWeb', a.id) }, t('Open in browser'))),
    ].filter(Boolean));
  }

  const problems = part('problems', [a.problems], () => a.problems.length > 0 && h('section', { class: 'card' },
    h('h2', {}, t('Not synced')),
    a.problems.length > 50 && h('p', { class: 'muted small' }, t('Showing 50 of {count}.', { count: a.problems.length })),
    h('ul', { class: 'list', 'data-key': 'problems' }, a.problems.slice(0, 50).map((p) =>
      h('li', {}, h('div', { class: 'ellipsis', dir: 'auto' }, p.path), h('div', { class: 'muted small' }, p.message))))));

  const folderCard = part('folders', [folders, foldersError, a.excluded.join('\0')], () => h('section', { class: 'card' },
    h('h2', {}, t('Folders to sync')),
    folderList(a.excluded, async (name, on) => {
      if (!on && !confirm(t('Stop syncing "{name}"? Its files are removed from this computer (to the trash) but stay on the server.', { name }))) {
        delete parts.folders; // put the checkbox back
        return render();
      }
      await cloudy.call('setExcluded', a.id, on ? a.excluded.filter((n) => n !== name) : [...a.excluded, name]);
    })));

  const activity = part('activity', [a.activity], () => h('section', { class: 'card' },
    h('h2', {}, t('Recent activity')),
    a.activity.length
      ? h('ul', { class: 'list', 'data-key': 'activity' }, a.activity.slice(0, 30).map((x) =>
        h('li', {}, h('div', { class: 'ellipsis', dir: 'auto' }, x.path),
          h('div', { class: 'muted small' }, `${t(KIND[x.kind] ?? x.kind)} · ${time(x.time)}`))))
      : h('p', { class: 'muted' }, t('Nothing yet.'))));

  const accountCard = part('account', [a.id, a.folder, a.excluded.join('\0'), a.displayName, a.user, a.server], () => h('section', { class: 'card' },
    h('h2', {}, t('Account')),
    h('div', { class: 'row' },
      h('div', {}, h('div', {}, t('Sync folder')), h('code', { dir: 'ltr' }, a.folder)),
      h('button', {
        'data-key': 'change-folder',
        async onclick() {
          const p = await cloudy.call('chooseFolder', a.id);
          if (p && p !== a.folder && confirm(t('Sync with "{path}" instead? Syncing starts over there; the old folder is left as it is.', { path: p }))) {
            const r = await cloudy.call('setup', a.id, p, a.excluded).catch((err) => ({ error: cleanError(err) }));
            if (r?.error) alert(r.error);
          }
        },
      }, t('Change…'))),
    h('div', { class: 'row' },
      h('div', {}, h('div', {}, a.displayName && a.displayName !== a.user ? `${a.displayName} (${a.user})` : a.user),
        h('div', { class: 'muted small', dir: 'ltr' }, a.server)),
      h('button', { class: 'danger', 'data-key': 'logout', onclick: () => cloudy.call('logout', a.id) }, t('Sign out')))));

  const u = state.update ?? { state: 'idle' };
  const general = part('general', [JSON.stringify(u), state.openAtLogin, state.version], () => {
    const updateText = {
      checking: t('Checking for updates…'),
      none: t('Cloudy is up to date. Checked at {time}.', { time: new Date(u.checkedAt).toLocaleTimeString('en', { timeStyle: 'short' }) }),
      downloading: t('Downloading Cloudy {version}… {percent}%', { version: u.version, percent: u.percent ?? 0 }),
      ready: t('Cloudy {version} is ready to install.', { version: u.version }),
      available: t('Cloudy {version} is available.', { version: u.version }),
      error: t('Could not check for updates: {message}', { message: u.message }),
    }[u.state];
    return h('section', { class: 'card' },
      h('h2', {}, t('Settings')),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', 'data-key': 'login-item', checked: state.openAtLogin, onchange: (e) => cloudy.call('setOpenAtLogin', e.target.checked) }),
        h('span', {}, t('Start Cloudy when I log in'))),
      h('div', { class: 'row' },
        h('div', {}, h('div', {}, t('Version {version}', { version: state.version })), updateText && h('div', { class: 'muted small' }, updateText)),
        u.state === 'ready' ? h('button', { class: 'primary', 'data-key': 'update', onclick: () => cloudy.call('installUpdate') }, t('Restart and update'))
          : u.state === 'available' ? h('button', { 'data-key': 'update', onclick: () => cloudy.call('openRelease') }, t('Download'))
            : h('button', { 'data-key': 'update', onclick: () => cloudy.call('checkUpdates'), disabled: ['checking', 'downloading'].includes(u.state) }, t('Check for updates'))));
  });

  return [st.el, problems, folderCard, activity, accountCard, general];
}

// ---------------------------------------------------------------- start

/** Updates carry each account's problems and activity only when they changed: merge account by account. */
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
