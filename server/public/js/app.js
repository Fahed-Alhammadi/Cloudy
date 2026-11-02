// App shell: login, navigation and hash routing.
import { get, post } from './api.js';
import { h, icon, showError, showMenu, formatSize } from './ui.js';
import { renderFolder, renderRecent, renderFavorites, renderSharedIn, renderSharedOut, renderSearch, renderTrash } from './files.js';
import { renderCalendar } from './calendar.js';
import { renderContacts } from './contacts.js';
import { renderSettings, renderAdmin } from './settings.js';
import { passkeysSupported, passkeyAutofillAvailable, getPasskey, isPasskeyCancel } from './passkey.js';
import { loadOfficeInfo } from './office.js';
import { t, LANGUAGES, currentLanguage, setLanguage, storedLanguage } from './i18n.js';

const app = document.getElementById('app');
const ctx = { me: null, rerender: () => route(), refreshMe };

async function refreshMe() {
  ctx.me = await get('/api/me');
  await startSession();
}

async function startSession() {
  // The account's language wins over the one picked on the login page (null = keep that / the browser's).
  if (ctx.me.language && ctx.me.language !== currentLanguage()) await setLanguage(ctx.me.language);
  await loadOfficeInfo();
  renderShell();
  route();
  startLiveUpdates();
}

// ---------------------------------------------------------------- live updates (Server-Sent Events)
// The server says which folders changed; the current view reloads when it shows one of them. While the
// user is busy (a dialog, the editor or a selection is open) the reload waits until they are done.
let events = null;
let refreshTimer = null;

function startLiveUpdates() {
  events?.close();
  if (!window.EventSource) return;
  events = new EventSource('/api/events');
  events.addEventListener('change', (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (affectsView(ev)) scheduleRefresh(300);
  });
}

function stopLiveUpdates() {
  events?.close();
  events = null;
  clearTimeout(refreshTimer);
}

function affectsView(ev) {
  if (!ctx.me) return false;
  const [, view = 'files', arg] = location.hash.replace(/^#/, '').split('/');
  if (view === 'files') return ev.folders.includes(Number(arg || ctx.me.rootId));
  if (view === 'shared-in') return ev.shares || ev.folders.length > 0;
  return ['recent', 'favorites', 'shared-out', 'search', 'trash'].includes(view) && ev.folders.length > 0;
}

const userIsBusy = () => !!document.querySelector('dialog[open], .menu') || !!main?.querySelector('.selection-bar:not([hidden])');

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!ctx.me || !main) return;
    if (userIsBusy()) return scheduleRefresh(1500);
    const scroll = main.scrollTop;
    await route();
    main.scrollTop = scroll;
  }, delay);
}

// Only one WebAuthn request may be pending; the autofill one is aborted before any other login.
let passkeyAbort = null;

/** Language menu for the login pages; `rerender` draws the page again in the new language. */
function languagePicker(rerender) {
  return h('select', { class: 'lang-picker', 'aria-label': t('Language'), onchange: async (e) => { await setLanguage(e.target.value); rerender(); } },
    LANGUAGES.map(([code, name]) => h('option', { value: code, selected: code === currentLanguage() }, name)));
}

function renderLogin(message, notice = false) {
  passkeyAbort?.abort();
  passkeyAbort = null;
  if (/^#\/(forgot|reset\/)/.test(location.hash)) history.replaceState(null, '', location.pathname);
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username webauthn', required: true, autofocus: true, 'aria-label': t('Username') });
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': t('Password') });
  // Second step for accounts with two-factor authentication; shown when the server asks for it.
  const code = h('input', { type: 'text', name: 'code', autocomplete: 'one-time-code', inputmode: 'numeric', 'aria-label': t('Authentication code'), placeholder: '123 456' });
  const codeField = h('label', { class: 'field', hidden: true }, h('span', {}, t('Authentication code')), code,
    h('small', { class: 'muted' }, t('From your authenticator app, or one of your recovery codes.')));
  const error = h('p', { class: notice ? 'notice' : 'error', role: 'alert' }, message || '');
  const forgot = h('a', { class: 'forgot-link', href: '#/forgot', hidden: true, onclick: (e) => { e.preventDefault(); renderForgot(user.value.trim()); } }, t('Forgot password?'));
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Log in'));
  const passkeyLogin = async (conditional) => {
    passkeyAbort?.abort();
    const abort = (passkeyAbort = new AbortController());
    if (!conditional) error.textContent = '';
    let picked = false;
    try {
      const options = await post('/api/passkeys/login/options');
      const cred = await getPasskey(options, { signal: abort.signal, conditional });
      picked = true;
      await post('/api/passkeys/login', cred);
      passkeyAbort = null;
      await refreshMe();
    } catch (err) {
      if (abort.signal.aborted) return;
      if (!isPasskeyCancel(err)) error.textContent = t(err.message);
      // Offer passkeys in autofill again after a dialog or a failed sign-in (not after the
      // autofill request itself failed, which would just fail again).
      if ((picked || !conditional) && passkeyAbort === abort && app.contains(user)) {
        passkeyAutofillAvailable().then((ok) => ok && passkeyAbort === abort && passkeyLogin(true));
      }
    }
  };
  const passkeyBtn = passkeysSupported() && h('button', { class: 'btn block', type: 'button', onclick: () => passkeyLogin(false) }, icon('key'), t('Sign in with a passkey'));
  app.replaceChildren(h('main', { class: 'login' },
    h('form', { class: 'login-card', onsubmit: async (e) => {
      e.preventDefault();
      passkeyAbort?.abort();
      btn.disabled = true;
      error.textContent = '';
      try {
        const body = { user: user.value.trim(), password: pass.value };
        if (!codeField.hidden) body.code = code.value.trim();
        await post('/api/login', body);
        await refreshMe();
      } catch (err) {
        if (err.body?.twoFactor && codeField.hidden) {
          codeField.hidden = false;
          code.focus();
        } else {
          error.textContent = t(err.message);
          if (!codeField.hidden) code.select();
        }
        btn.disabled = false;
        passkeyAutofillAvailable().then((ok) => ok && passkeyAbort?.signal.aborted && app.contains(user) && passkeyLogin(true));
      }
    } },
      loginHero(),
      h('label', { class: 'field' }, h('span', {}, t('Username')), user),
      h('label', { class: 'field' }, h('span', {}, t('Password')), pass),
      forgot,
      codeField,
      error, btn,
      passkeyBtn && h('div', { class: 'login-or', 'aria-hidden': 'true' }, t('or')),
      passkeyBtn,
      languagePicker(() => renderLogin(message, notice)))));
  get('/api/auth/options').then((o) => { forgot.hidden = !o.passwordReset; }, () => {});
  user.focus();
  passkeyAutofillAvailable().then((ok) => ok && !passkeyAbort && app.contains(user) && passkeyLogin(true));
}

// ---------------------------------------------------------------- password reset by email

function authCard(...kids) {
  passkeyAbort?.abort();
  app.replaceChildren(h('main', { class: 'login' }, h('form', { class: 'login-card' }, loginHero(), ...kids.filter(Boolean))));
  return app.querySelector('form');
}

/** The mark, the name and what Cloudy is, above the sign-in form. */
function loginHero() {
  return h('div', { class: 'login-hero' },
    h('img', { class: 'mark', src: '/favicon.svg', alt: '', width: 64, height: 64 }),
    h('h1', {}, 'Cloudy'),
    h('p', { class: 'tagline' }, t('Your files, calendars and contacts, on your own server.')));
}

function renderForgot(initial = '') {
  const login = h('input', { type: 'text', autocomplete: 'username', required: true, value: initial, 'aria-label': t('Username or email') });
  const msg = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Send reset link'));
  const form = authCard(
    h('p', {}, t('Enter your username or email. If your account has an email address, we will send you a link to choose a new password.')),
    h('label', { class: 'field' }, h('span', {}, t('Username or email')), login),
    msg, btn,
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderLogin(); } }, t('Back to login')),
    languagePicker(() => renderForgot(login.value)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await post('/api/auth/forgot', { login: login.value.trim() });
      msg.className = 'notice';
      msg.textContent = t('If an account matches, a reset link is on its way. Check your inbox (and spam folder).');
    } catch (err) {
      msg.className = 'error';
      msg.textContent = t(err.message);
      btn.disabled = false;
    }
  });
  login.focus();
}

function renderReset(token) {
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true, 'aria-label': t('New password') });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true, 'aria-label': t('Repeat new password') });
  const msg = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Set new password'));
  const form = authCard(
    h('label', { class: 'field' }, h('span', {}, t('New password (8+ characters)')), pw1),
    h('label', { class: 'field' }, h('span', {}, t('Repeat new password')), pw2),
    msg, btn,
    languagePicker(() => renderReset(token)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pw1.value !== pw2.value) { msg.textContent = t('The passwords do not match.'); return; }
    btn.disabled = true;
    try {
      await post('/api/auth/reset', { token, password: pw1.value });
      renderLogin(t('Your password was changed. Log in with the new one.'), true);
    } catch (err) {
      msg.textContent = t(err.message);
      btn.disabled = false;
    }
  });
  pw1.focus();
}

const NAV = [
  ['files', 'Files', 'folder'],
  ['recent', 'Recent', 'clock'],
  ['favorites', 'Favorites', 'star'],
  ['shared-in', 'Shared with you', 'users'],
  ['shared-out', 'Shared by you', 'share'],
  ['trash', 'Deleted files', 'trash'],
  '-',
  ['calendar', 'Calendar', 'calendar'],
  ['contacts', 'Contacts', 'contacts'],
];

let main;
let nav;

function renderShell() {
  const search = h('input', { type: 'search', placeholder: t('Search files'), 'aria-label': t('Search files'), onkeydown: (e) => {
    if (e.key === 'Enter' && search.value.trim()) location.hash = `#/search/${encodeURIComponent(search.value.trim())}`;
  } });
  nav = h('nav', { class: 'sidebar', 'aria-label': t('Main') },
    h('ul', {}, NAV.map((item) => item === '-' ? h('li', { class: 'sep' }) : h('li', {},
      h('a', { href: `#/${item[0]}`, 'data-view': item[0] }, icon(item[2]), h('span', {}, t(item[1])))))),
    h('div', { class: 'grow' }),
    h('ul', {},
      h('li', {}, h('a', { href: '#/settings', 'data-view': 'settings' }, icon('settings'), h('span', {}, t('Settings')))),
      ctx.me.isAdmin && h('li', {}, h('a', { href: '#/admin', 'data-view': 'admin' }, icon('shield'), h('span', {}, t('Administration'))))),
    h('div', { class: 'usage' }, ctx.me.quotaBytes
      ? t('{used} of {quota} used', { used: formatSize(ctx.me.used), quota: formatSize(ctx.me.quotaBytes) })
      : t('{used} used', { used: formatSize(ctx.me.used) })),
  );
  main = h('main', { class: 'content', id: 'content', tabindex: -1 });
  const header = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn menu-toggle', 'aria-label': t('Toggle menu'), onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
    h('a', { class: 'brand', href: '#/files' }, h('img', { class: 'mark', src: '/favicon.svg', alt: '', width: 26, height: 26 }), 'Cloudy'),
    h('div', { class: 'search' }, icon('search'), search),
    h('button', { class: 'avatar-btn', 'aria-label': t('Account menu'), onclick: (e) => showMenu(e.currentTarget, [
      { label: ctx.me.displayName, icon: 'contacts', onclick: () => (location.hash = '#/settings') },
      { label: t('Log out'), icon: 'logout', onclick: async () => { stopLiveUpdates(); await post('/api/logout').catch(() => {}); ctx.me = null; renderLogin(); } },
    ]) }, (ctx.me.displayName || ctx.me.id).slice(0, 1).toUpperCase()),
  );
  app.replaceChildren(header, h('div', { class: 'layout' }, nav, main));
}

async function route() {
  if (!ctx.me || !main) return;
  const [, view = 'files', arg] = location.hash.replace(/^#/, '').split('/');
  document.body.classList.remove('nav-open');
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  main.setAttribute('aria-busy', 'true');
  try {
    switch (view) {
      case 'files': await renderFolder(main, arg || ctx.me.rootId, ctx); break;
      case 'recent': await renderRecent(main, ctx); break;
      case 'favorites': await renderFavorites(main, ctx); break;
      case 'shared-in': await renderSharedIn(main, ctx); break;
      case 'shared-out': await renderSharedOut(main, ctx); break;
      case 'search': await renderSearch(main, ctx, decodeURIComponent(arg || '')); break;
      case 'trash': await renderTrash(main, ctx); break;
      case 'calendar': await renderCalendar(main, ctx); break;
      case 'contacts': await renderContacts(main, ctx); break;
      case 'settings': await renderSettings(main, ctx); break;
      case 'admin': await renderAdmin(main, ctx); break;
      default: location.hash = '#/files';
    }
    document.title = `${nav.querySelector('a.active span')?.textContent || t('Files')} – Cloudy`;
  } catch (e) {
    if (e.status === 404 && view === 'files') location.hash = '#/files';
    else if (e.status !== 401) showError(e);
  } finally {
    main.removeAttribute('aria-busy');
  }
}

window.addEventListener('hashchange', route);
// Only an existing session can expire; at startup "not logged in" is handled below.
window.addEventListener('cloudy:unauthorized', () => {
  if (!ctx.me) return;
  stopLiveUpdates();
  ctx.me = null;
  renderLogin(t('Your session has expired. Please log in again.'));
});

await setLanguage(storedLanguage());
const startHash = location.hash;
const resetLink = /^#\/reset\/([\w-]+)$/.exec(startHash);
if (resetLink) renderReset(resetLink[1]);
else get('/api/me').then((me) => { ctx.me = me; return startSession(); }, () => (startHash === '#/forgot' ? renderForgot() : renderLogin()));
