// App shell: login, navigation and routing (plain addresses: /files/12, /settings…).
import { get, post, patch } from './api.js';
import { h, icon, avatar, isolate, showError, showMenu, closeMenu, formatSize, navigate, currentView, modal, toast, confirmDialog, setLeaveGuard, mayLeave } from './ui.js';
import { renderFolder, renderRecent, renderFavorites, renderSharedIn, renderSharedOut, renderSearch, renderTrash, placeOf, restorePlace } from './files.js';
import { renderSettings, renderAdmin } from './settings.js';
import { passkeysSupported, passkeyAutofillAvailable, getPasskey, isPasskeyCancel } from './passkey.js';
import { loadOfficeInfo } from './office.js';
import { setDropTarget } from './drop.js';
import { uploadsRunning, stopAllUploads } from './upload.js';
import { consumeViewerBack } from './viewer.js';
import { t } from './i18n.js';

const app = document.getElementById('app');
const ctx = { me: null, rerender: () => route({ refresh: true }), refreshMe, markNav: (view) => markNav(view),
  // A refresh that waits while the user is busy (a selection, a dialog, a menu), like the live updates do.
  refreshWhenFree: () => scheduleRefresh(0) };
// Back and Forward put each page back where it was scrolled to (the browser's own attempt runs before the page is drawn).
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

async function refreshMe() {
  ctx.me = await get('/api/me');
  await startSession();
}

async function startSession() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!ctx.me.timezone && zone) patch('/api/me', { timezone: zone }).then(() => { ctx.me.timezone = zone; }, () => {});
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
let reconnectTimer = null;
let reconnectDelay = 5000;
let missedUpdates = false;

function startLiveUpdates() {
  events?.close();
  clearTimeout(reconnectTimer);
  if (!window.EventSource) return;
  const source = (events = new EventSource('/api/events'));
  source.addEventListener('change', (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (affectsView(ev)) scheduleRefresh(300);
    if (ev.folders.length) refreshUsageSoon();
  });
  source.addEventListener('open', () => {
    reconnectDelay = 5000;
    // Back after a gap: file lists may have missed changes and are reloaded once. Never other pages: the settings
    // forms are not dialogs, and reloading them would throw away what is being typed.
    if (missedUpdates) {
      missedUpdates = false;
      if (['files', 'recent', 'favorites', 'shared-in', 'shared-out', 'search', 'trash'].includes(currentView().view)) scheduleRefresh(0);
    }
  });
  // The browser reconnects by itself after network errors, but gives up for good after an answer other than 200 (a
  // proxy's 502 while the server restarts): live updates then stopped until a reload. Start again, a little later
  // each time.
  source.addEventListener('error', () => {
    if (events !== source) return;
    missedUpdates = true;
    if (source.readyState !== EventSource.CLOSED) return;
    reconnectTimer = setTimeout(() => {
      if (!ctx.me || events !== source) return;
      startLiveUpdates();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  });
}

function stopLiveUpdates() {
  events?.close();
  events = null;
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  refreshTimer = null;
}

function affectsView(ev) {
  if (!ctx.me) return false;
  const { view, arg } = currentView();
  // A share given, changed or taken away: an open folder of someone else's may now be editable, read-only or gone.
  if (view === 'files') return ev.shares || ev.folders.includes(Number(arg || ctx.me.rootId));
  if (view === 'shared-in') return ev.shares || ev.folders.length > 0;
  return ['recent', 'favorites', 'shared-out', 'search', 'trash'].includes(view) && ev.folders.length > 0;
}

const userIsBusy = () => !!document.querySelector('dialog[open], .menu') || !!main?.querySelector('.selection-bar:not([hidden])');

// One refresh at a time. A change that arrives while one is waiting or running does not push it back (while changes
// kept arriving, e.g. another device uploading many files, the view used to wait for a quiet moment that never came
// and showed none of them); it only asks for one more pass once the current one is done.
let refreshAgain = false;
function scheduleRefresh(delay) {
  if (refreshTimer) { refreshAgain = true; return; }
  refreshAgain = false;
  refreshTimer = setTimeout(async () => {
    const done = () => {
      refreshTimer = null;
      if (refreshAgain && ctx.me) scheduleRefresh(300);
    };
    if (!ctx.me || !main) return done();
    if (userIsBusy()) {
      refreshTimer = null;
      return scheduleRefresh(1500);
    }
    try {
      await route({ refresh: true }); // keeps the scroll position and the focused row (route)
    } finally {
      done();
    }
  }, delay);
}

/** Scrolls to `y`, first drawing enough of a long file list for the page to reach it (lists draw 200 rows at first). */
function restoreScroll(y) {
  main?.querySelector('.file-list')?.renderUntil?.(y + window.innerHeight);
  window.scrollTo(0, y);
}

/** The sidebar entry for `view` is marked (a folder shared with you marks "Shared with you", not "Files"). */
function markNav(view) {
  nav?.querySelectorAll('a').forEach((a) => {
    const on = a.dataset.view === view;
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
}

// The rail's "x of y used" (with a bar when there is a quota): read at sign-in, then again after files change (at most
// every 10 seconds).
let usageLine = null;
let usageTimer = null;
function showUsage() {
  if (!usageLine || !ctx.me) return;
  const { used, quotaBytes } = ctx.me;
  const pct = quotaBytes ? Math.min(100, (used / quotaBytes) * 100) : null;
  usageLine.replaceChildren(...[
    pct != null && h('div', { class: `usage-bar${pct >= 90 ? ' full' : ''}`, 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })),
    h('span', {}, quotaBytes != null
      ? t('{used} of {quota} used', { used: formatSize(used), quota: formatSize(quotaBytes) })
      : t('{used} used', { used: formatSize(used) })),
  ].filter(Boolean));
}
function refreshUsageSoon() {
  if (usageTimer) return;
  usageTimer = setTimeout(async () => {
    usageTimer = null;
    const who = ctx.me?.id;
    if (!who) return;
    try {
      const me = await get('/api/me');
      if (ctx.me?.id !== who) return;
      ctx.me.used = me.used;
      ctx.me.quotaBytes = me.quotaBytes;
      showUsage();
    } catch { /* the next change tries again */ }
  }, 10_000);
}

// Only one WebAuthn request may be pending; the autofill one is aborted before any other login.
let passkeyAbort = null;

/** Passkeys are bound to the server's name: on an address like 192.168.1.10 the browser refuses them. */
const ipAddressHost = () => /^\d+(\.\d+){3}$/.test(location.hostname) || location.hostname.includes(':');

function renderLogin(message, notice = false, keep = {}) {
  stopAllUploads(); // signed out: running uploads end, and their panel does not stay on the sign-in page
  passkeyAbort?.abort();
  passkeyAbort = null;
  if (/^\/(forgot|reset)(\/|$)/.test(location.pathname)) history.replaceState(null, '', '/');
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username webauthn', required: true, autofocus: true, 'aria-label': t('Username'), value: keep.user ?? '' });
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': t('Password'), value: keep.pass ?? '' });
  // Second step for accounts with two-factor authentication; shown when the server asks for it.
  const code = h('input', { type: 'text', name: 'code', autocomplete: 'one-time-code', inputmode: 'numeric', 'aria-label': t('Authentication code'), placeholder: '123 456' });
  const codeField = h('label', { class: 'field', hidden: true }, h('span', {}, t('Authentication code')), code,
    h('small', { class: 'muted' }, t('From your authenticator app, or one of your recovery codes.')));
  const error = h('p', { class: notice ? 'notice' : 'error', role: 'alert' }, message || '');
  const forgot = h('a', { class: 'forgot-link', href: '/forgot', hidden: true, onclick: (e) => { e.preventDefault(); renderForgot(user.value.trim()); } }, t('Forgot password?'));
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
      // A failing background (autofill) request stays quiet; errors after the user picked a passkey are shown.
      if (!isPasskeyCancel(err) && (picked || !conditional)) error.textContent = t(err.message);
      // Offer passkeys in autofill again after a dialog or a failed sign-in (not after the
      // autofill request itself failed, which would just fail again).
      if ((picked || !conditional) && passkeyAbort === abort && app.contains(user)) {
        passkeyAutofillAvailable().then((ok) => ok && passkeyAbort === abort && passkeyLogin(true));
      }
    }
  };
  const passkeyBtn = passkeysSupported() && !ipAddressHost() && h('button', { class: 'btn block', type: 'button', onclick: () => passkeyLogin(false) }, icon('key'), t('Sign in with a passkey'));
  app.replaceChildren(h('main', { class: 'login' },
    loginHero(),
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
          else if (err.status === 401) pass.select(); // the password, ready to type again
        }
        btn.disabled = false;
        passkeyAutofillAvailable().then((ok) => ok && passkeyAbort?.signal.aborted && app.contains(user) && passkeyLogin(true));
      }
    } },
      h('label', { class: 'field' }, h('span', {}, t('Username')), user),
      h('label', { class: 'field' }, h('span', {}, t('Password')), pass),
      forgot,
      codeField,
      error, btn,
      passkeyBtn && h('div', { class: 'login-or', 'aria-hidden': 'true' }, t('or')),
      passkeyBtn)));
  get('/api/auth/options').then((o) => { forgot.hidden = !o.passwordReset; }, () => {});
  (user.value ? pass : user).focus();
  if (!ipAddressHost()) passkeyAutofillAvailable().then((ok) => ok && !passkeyAbort && app.contains(user) && passkeyLogin(true));
}

// ---------------------------------------------------------------- password reset by email

function authCard(...kids) {
  passkeyAbort?.abort();
  app.replaceChildren(h('main', { class: 'login' }, loginHero(), h('form', { class: 'login-card' }, ...kids.filter(Boolean))));
  return app.querySelector('form');
}

/** The mark, the name and what Cloudy is, on the night sky above the form. */
function loginHero() {
  return h('div', { class: 'login-hero' },
    h('img', { class: 'mark', src: '/favicon.svg', alt: '', width: 60, height: 60 }),
    h('h1', {}, 'Cloudy'),
    h('p', { class: 'tagline' }, t('Your files, on your own server.')));
}

// ---------------------------------------------------------------- invitations
// An administrator's invitation link (/invite#<token>, the token stays out of server logs like reset links): the person
// picks their own username and password, and is signed in straight away. The token waits in this tab's storage until
// the account exists, so a reload does not lose the invitation. The server counts wrong links per address: the link is
// checked once per page, never again for a language switch.
const INVITE_KEY = 'cloudy-invite';
function keepInvite(token) {
  try { token ? sessionStorage.setItem(INVITE_KEY, token) : sessionStorage.removeItem(INVITE_KEY); } catch { /* storage unavailable */ }
}
function keptInvite() {
  try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; }
}
const toLoginFromInvite = (e) => { e?.preventDefault(); keepInvite(null); history.replaceState(null, '', '/'); renderLogin(); };

/** The link could not be used: invalid or expired (said by the server), too many tries, or no connection. */
function inviteProblem(token, err) {
  const unreachable = !err?.status || err.status >= 500;
  if (err?.status === 400) keepInvite(null);
  document.title = 'Cloudy';
  authCard(
    h('h2', { class: 'card-title' }, unreachable ? t('This page could not be loaded.') : t('This invitation can’t be used')),
    h('p', { class: 'card-lead' }, t(err?.message || String(err))),
    unreachable && h('button', { class: 'btn primary block', type: 'button', onclick: () => renderInvite(token) }, icon('restore'), t('Try again')),
    h('a', { class: `btn block${unreachable ? '' : ' primary'}`, href: '/', onclick: toLoginFromInvite }, t('Go to sign in')));
}

async function renderInvite(token, keep = {}, known = null) {
  stopAllUploads();
  let { info, signedIn } = known ?? {};
  if (!info) {
    try {
      [info, signedIn] = await Promise.all([post('/api/invitations/check', { token }), get('/api/me').catch(() => null)]);
    } catch (err) {
      return inviteProblem(token, err);
    }
  }
  document.title = `${t('Create your account')} – Cloudy`;
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: 100, value: keep.name ?? info.displayName ?? '', dir: 'auto' });
  const user = h('input', { type: 'text', autocomplete: 'username', required: true, maxlength: 64, pattern: '[A-Za-z0-9][A-Za-z0-9._@\\-]{0,63}', value: keep.user ?? info.username ?? '', dir: 'ltr', autocapitalize: 'none', spellcheck: 'false' });
  const email = !info.email && h('input', { type: 'email', autocomplete: 'email', value: keep.email ?? '', dir: 'ltr' });
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true, value: keep.pw1 ?? '' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true, value: keep.pw2 ?? '' });
  const msg = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Create account'));
  const form = authCard(
    h('h2', { class: 'card-title' }, t('Create your account')),
    h('div', { class: 'invite-from' }, icon('mail'),
      h('p', {}, info.invitedBy ? t('{who} invited you to Cloudy. Choose how you want to sign in.', { who: isolate(info.invitedBy) }) : t('You are invited to Cloudy. Choose how you want to sign in.'))),
    // Someone already signed in here (an administrator trying the link): the new account takes this browser over.
    signedIn && h('p', { class: 'notice' }, icon('user'),
      t('You are signed in as {name} in this browser. Creating the account signs you out of it.', { name: isolate(signedIn.displayName || signedIn.id) })),
    h('label', { class: 'field' }, h('span', {}, t('Your name')), name),
    h('label', { class: 'field' }, h('span', {}, t('Username')), user, h('small', {}, t('Letters, digits and . _ @ - (you sign in with it)'))),
    email ? h('label', { class: 'field' }, h('span', {}, t('Email (optional)')), email, h('small', {}, t('For password reset links.')))
      : h('p', { class: 'muted small' }, t('Password reset links go to {email}.', { email: isolate(info.email) })),
    h('label', { class: 'field' }, h('span', {}, t('Password (8+ characters)')), pw1),
    h('label', { class: 'field' }, h('span', {}, t('Repeat password')), pw2),
    msg, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    if (pw1.value !== pw2.value) { msg.textContent = t('The passwords do not match.'); pw2.focus(); return; }
    btn.disabled = true;
    let created = false;
    try {
      if (signedIn) { await post('/api/logout').catch(() => {}); signedIn = null; }
      await post('/api/invitations/accept', {
        token, username: user.value.trim(), displayName: name.value.trim() || undefined, password: pw1.value,
        ...(email && email.value.trim() ? { email: email.value.trim() } : {}),
      });
      created = true;
      keepInvite(null);
      history.replaceState(null, '', '/');
      await refreshMe();
      toast(t('Welcome to Cloudy!'));
    } catch (err) {
      // The account exists and this browser is signed in to it: only opening the app failed. Start it afresh (a second
      // try of the form would say the link is used up).
      if (created) return void location.assign('/');
      msg.textContent = t(err.message);
      btn.disabled = false;
      if (err.status === 409 || /username/i.test(err.message)) user.select();
    }
  });
  (user.value ? pw1 : user).focus();
}

function renderForgot(initial = '') {
  const login = h('input', { type: 'text', autocomplete: 'username', required: true, value: initial, 'aria-label': t('Username or email') });
  const msg = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, t('Send reset link'));
  const form = authCard(
    h('p', {}, t('Enter your username or email. If your account has an email address, we will send you a link to choose a new password.')),
    h('label', { class: 'field' }, h('span', {}, t('Username or email')), login),
    msg, btn,
    h('a', { href: '/', onclick: (e) => { e.preventDefault(); renderLogin(); } }, t('Back to login')));
  get('/api/auth/options').then((o) => {
    if (o.passwordReset) return;
    msg.className = 'notice';
    msg.textContent = t('Password reset by email is not set up on this server. Ask your administrator to set a new password.');
    btn.disabled = true;
    login.disabled = true;
  }, () => {});
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
    msg, btn);
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
];

let main;
let nav;

function renderShell() {
  search = h('input', { type: 'search', placeholder: t('Search your files'), 'aria-label': t('Search files'), enterkeyhint: 'search', onkeydown: (e) => {
    if (e.key === 'Enter' && search.value.trim()) navigate(`/search?q=${encodeURIComponent(search.value.trim())}`);
  } });
  // The rail: the mark, the places, then Settings and the storage meter at the foot. (Administration is in the
  // account menu, for administrators only.)
  nav = h('nav', { class: 'sidebar', id: 'sidebar', 'aria-label': t('Main'), onclick: (e) => { if (e.target.closest('a')) setNavOpen(false); } },
    h('a', { class: 'rail-brand', href: '/' }, h('img', { class: 'mark', src: '/favicon.svg', alt: '', width: 32, height: 32 }), 'Cloudy'),
    h('ul', {}, NAV.map((item) => item === '-' ? h('li', { class: 'sep', role: 'presentation' }) : h('li', {},
      h('a', { href: `/${item[0]}`, 'data-view': item[0] }, icon(item[2]), h('span', {}, t(item[1])))))),
    h('div', { class: 'grow' }),
    h('ul', {}, h('li', {}, h('a', { href: '/settings', 'data-view': 'settings' }, icon('settings'), h('span', {}, t('Settings'))))),
    usageLine = h('div', { class: 'usage' }),
  );
  showUsage();
  main = h('main', { class: 'content', id: 'content', tabindex: -1 });
  const header = h('header', { class: 'topbar' },
    menuToggle = h('button', { class: 'icon-btn menu-toggle', 'aria-label': t('Toggle menu'), 'aria-controls': 'sidebar', 'aria-expanded': 'false',
      onclick: () => setNavOpen(!document.body.classList.contains('nav-open')) }, icon('menu')),
    h('div', { class: 'search', role: 'search' }, icon('search'), search, h('kbd', { title: t('Press / to search'), 'aria-hidden': 'true' }, '/')),
    h('div', { class: 'topbar-end' },
      h('button', { class: 'avatar-btn', 'aria-label': t('Account menu'), 'aria-haspopup': 'menu', onclick: (e) => accountMenu(e.currentTarget) }, avatar(ctx.me))),
  );
  // Phones: the rail is a drawer over the page; a tap beside it closes it.
  const scrim = h('div', { class: 'nav-scrim', 'aria-hidden': 'true', onclick: () => setNavOpen(false) });
  app.replaceChildren(h('div', { class: 'layout' }, nav, scrim, h('div', { class: 'workspace' }, header, main)));
}

/**
 * The account menu: who is signed in (name and username; opens Settings), Administration for administrators only,
 * and Log out. Whether the entry is shown is a convenience: the server refuses every administration request from
 * anyone else.
 */
function accountMenu(anchor) {
  const me = ctx.me;
  if (!me) return;
  const name = me.displayName || me.id;
  const label = name === me.id ? t('{name}: account settings', { name: isolate(name) }) : t('{name} ({user}): account settings', { name: isolate(name), user: isolate(me.id) });
  showMenu(anchor, [
    { label, cls: 'account-head', onclick: () => navigate('/settings'),
      content: [avatar(me), h('span', { class: 'who' }, h('strong', { dir: 'auto' }, name), h('small', { dir: 'auto' }, me.id)), icon('right')] },
    me.isAdmin === true && '-',
    me.isAdmin === true && { label: t('Administration'), icon: 'shield', onclick: () => navigate('/admin') },
    '-',
    { label: t('Log out'), icon: 'logout', onclick: logOut },
  ], { className: 'account', label: t('Account') });
}

async function logOut() {
  if (uploadsRunning() && !(await confirmDialog(t('Log out'), t('Uploads that are still running will stop.'), t('Log out'), true))) return;
  stopLiveUpdates();
  await post('/api/logout').catch(() => {});
  ctx.me = null;
  document.body.classList.remove('nav-open');
  // Logged out on purpose: the address goes back to the start (/files/12 would otherwise stay in the address bar
  // and be where the next person signing in lands). An expired session keeps it, so signing in again returns there.
  history.replaceState(null, '', '/');
  renderLogin();
}

// "/" goes to the search box (as on many sites), unless the key is typed into a field.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !ctx.me || !search?.isConnected) return;
  const el = document.activeElement;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (document.querySelector('dialog[open], .menu')) return;
  e.preventDefault();
  setNavOpen(false);
  search.focus();
  search.select();
});

let menuToggle;
let search;
function setNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  menuToggle?.setAttribute('aria-expanded', String(open));
  if (open) nav.querySelector('a.active, a')?.focus();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('nav-open') && !document.querySelector('dialog[open], .menu')) {
    setNavOpen(false);
    menuToggle?.focus();
  }
});

// Each route renders into its own element, shown once its data has loaded. A view that finishes late (the user
// clicked on, or an upload's reload fired after leaving the folder) then writes into a detached element instead of
// replacing what is on screen.
let routeSeq = 0;
async function route({ refresh = false, scrollTo = null } = {}) {
  if (!ctx.me || !main) return;
  const seq = ++routeSeq;
  const { view, arg } = currentView();
  // A refresh keeps the scroll position (the page, not <main>, scrolls) and the focused row or control, so keyboard
  // users don't lose their place.
  const place = refresh ? placeOf(main) : null;
  let notFound = false;
  if (!refresh) { setNavOpen(false); closeMenu(); setLeaveGuard(null); shownAt = location.pathname + location.search; } // each page sets its own guard again
  markNav(view);
  if (search && view !== 'search' && !refresh) search.value = '';
  if (!refresh) setDropTarget(null);
  const slot = h('div', { class: 'view' });
  const shown = () => {
    if (seq !== routeSeq) return;
    if (main.firstChild !== slot) {
      main.replaceChildren(slot);
      if (!refresh) window.scrollTo(0, 0); // a new view starts at its top
    }
  };
  // Views call slot.replaceChildren(...) when ready; that's the moment to put the slot on screen.
  const put = slot.replaceChildren.bind(slot);
  slot.replaceChildren = (...kids) => { put(...kids); shown(); };
  main.setAttribute('aria-busy', 'true');
  try {
    switch (view) {
      // Only a numeric id goes into the API path (a crafted "/files/%2e%2e" would otherwise point the request elsewhere).
      case 'files': await renderFolder(slot, /^\d+$/.test(arg) ? arg : ctx.me.rootId, ctx); break;
      case 'recent': await renderRecent(slot, ctx); break;
      case 'favorites': await renderFavorites(slot, ctx); break;
      case 'shared-in': await renderSharedIn(slot, ctx); break;
      case 'shared-out': await renderSharedOut(slot, ctx); break;
      case 'search': {
        const query = new URLSearchParams(location.search).get('q') ?? '';
        if (search && document.activeElement !== search) search.value = query;
        await renderSearch(slot, ctx, query);
        break;
      }
      case 'trash': await renderTrash(slot, ctx); break;
      case 'settings': await renderSettings(slot, ctx, arg); break;
      case 'admin': await renderAdmin(slot, ctx, arg); break;
      default:
        notFound = true;
        slot.replaceChildren(h('div', { class: 'empty', role: 'alert' }, icon('cloud'), h('h1', { class: 'view-title' }, t('Page not found')),
          h('p', { class: 'muted' }, t('This address does not exist in Cloudy.')),
          h('a', { class: 'btn primary', href: '/' }, icon('folder'), t('Go to Files'))));
        break;
    }
    if (seq === routeSeq) {
      if (place) restorePlace(main, place);
      else if (scrollTo != null) restoreScroll(scrollTo);
      const label = view === 'admin' ? t('Administration') : nav.querySelector('a.active span:not(.icon)')?.textContent;
      document.title = `${notFound ? t('Page not found') : label || t('Files')} – Cloudy`;
      // Keyboard and screen-reader users start at the new page's content (focus was left on the clicked link,
      // or fell back to the page when the link was replaced).
      if (!refresh && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) main.focus({ preventScroll: true });
    }
  } catch (e) {
    if (seq !== routeSeq) return;
    if (e.status === 404 && view === 'files') {
      // Shown while it was taken away (the share removed, or the folder deleted elsewhere): say so before leaving it.
      if (refresh) toast(t('This folder is no longer available.'), 'error');
      navigate('/files', { replace: true });
    }
    else if (e.status !== 401) {
      showError(e);
      // A view that could not load says so (with a way to retry) instead of leaving the previous view under the new title.
      if (!refresh) {
        slot.replaceChildren(h('div', { class: 'empty', role: 'alert' }, icon('cloud'), h('p', {}, t('This page could not be loaded.')),
          h('p', { class: 'muted small' }, t(e.message || String(e))),
          h('button', { class: 'btn primary', type: 'button', onclick: () => route() }, icon('restore'), t('Try again'))));
      }
    }
  } finally {
    if (seq === routeSeq) main.removeAttribute('aria-busy');
  }
}

// Back/Forward, and moves made by the views (navigate() in ui.js).
// (Back while the viewer is open closes the viewer: that history entry is the viewer's, not a page.)
// Unsaved work asks first; staying puts the page's address back. Back pressed again while the
// question is open changes nothing more.
let shownAt = location.pathname + location.search;
let asking = false;
window.addEventListener('popstate', async () => {
  if (consumeViewerBack() || asking) return;
  asking = true;
  const ok = await mayLeave();
  asking = false;
  if (!ok) return void history.pushState(null, '', shownAt);
  route({ scrollTo: history.state?.scroll ?? null });
});
window.addEventListener('cloudy:navigate', () => route());
// Links to the app's own pages open in place; a Ctrl/⌘/Shift/middle click still opens a new tab or window
// (the server answers those addresses with the app too).
const APP_LINK = /^\/(files|recent|favorites|shared-in|shared-out|search|trash|settings|admin)?(\/|$)/;
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !ctx.me) return;
  const a = e.target.closest?.('a[href]');
  if (!a || a.target || a.hasAttribute('download') || a.origin !== location.origin || !APP_LINK.test(a.pathname)) return;
  e.preventDefault();
  navigate(a.pathname + a.search);
});

/** Before 1.18 the views lived behind "#/…" (/#/files/12): such links (bookmarks, emails) open the same view at its plain address. */
function fromOldAddress() {
  if (!location.hash.startsWith('#/')) return false;
  const old = location.hash.replace(/^#[\/\\]+/, ''); // one leading slash only: "//host" would leave this site
  let path = '/' + old;
  const search = /^search\/(.*)$/.exec(old);
  if (search) { try { path = `/search?q=${encodeURIComponent(decodeURIComponent(search[1]))}`; } catch { path = '/search'; } }
  try { history.replaceState(null, '', path); } catch { history.replaceState(null, '', '/'); }
  return true;
}
window.addEventListener('hashchange', () => { if (fromOldAddress()) route(); });
// Only an existing session can expire; at startup "not logged in" is handled below.
let reauthenticating = false;
async function reauthenticate() {
  if (reauthenticating) return;
  reauthenticating = true;
  const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password', 'aria-label': t('Password') });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', 'aria-label': t('Authentication code') });
  const codeField = h('label', { class: 'field', hidden: true }, h('span', {}, t('Authentication code')), code);
  const error = h('p', { class: 'error', role: 'alert' });
  const ok = await modal({
    title: t('Sign in again'),
    body: h('div', {}, h('p', {}, t('Your session has ended. Sign in again to save your changes; nothing you typed is lost.')),
      h('label', { class: 'field' }, h('span', {}, t('Password')), pass), codeField, error),
    buttons: [{ label: t('Cancel'), value: null }, { label: t('Sign in'), value: 'ok', primary: true }],
    onSubmit: async () => {
      try {
        await post('/api/login', { user: ctx.me.id, password: pass.value, ...(codeField.hidden ? {} : { code: code.value.trim() }) });
        return true;
      } catch (err) {
        if (err.body?.twoFactor && codeField.hidden) { codeField.hidden = false; code.focus(); return false; }
        error.textContent = t(err.message);
        return false;
      }
    },
  });
  reauthenticating = false;
  if (ok) {
    startLiveUpdates();
    toast(t('Signed in again. You can save now.'));
  }
}

window.addEventListener('cloudy:unauthorized', () => {
  if (!ctx.me) return;
  if (document.querySelector('dialog.viewer[data-dirty="true"]')) return void reauthenticate();
  stopLiveUpdates();
  ctx.me = null;
  document.body.classList.remove('nav-open');
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  renderLogin(t('Your session has expired. Please log in again.'));
});

fromOldAddress();
// Reset links are /reset#<token>: browsers don't send the part after "#", so the token stays out of the access logs
// of the server and any proxy in front of it. Once read, the address bar shows just /reset. (/reset/<token> = an old link.)
const resetToken = location.pathname === '/reset' ? /^#([\w-]+)$/.exec(location.hash)?.[1] : /^\/reset\/([\w-]+)$/.exec(location.pathname)?.[1];
// Invitations work the same way: /invite#<token>. Opened while signed in (an administrator trying the link), the page
// still shows: creating the account signs in as the new person.
const inviteToken = location.pathname === '/invite' ? (/^#([\w-]+)$/.exec(location.hash)?.[1] ?? keptInvite()) : null;
if (location.pathname === '/invite' && !inviteToken) history.replaceState(null, '', '/');
if (resetToken) {
  history.replaceState(null, '', '/reset');
  renderReset(resetToken);
} else if (inviteToken) {
  keepInvite(inviteToken); // a reload of /invite finds it again
  history.replaceState(null, '', '/invite');
  renderInvite(inviteToken);
} else get('/api/me').then((me) => { ctx.me = me; return startSession(); }, () => {
  if (location.pathname === '/forgot') return renderForgot();
  let notice = null;
  try { notice = sessionStorage.getItem('cloudy-notice'); sessionStorage.removeItem('cloudy-notice'); } catch { /* storage unavailable */ }
  return notice === 'deleted' ? renderLogin(t('Your account was deleted.'), true) : renderLogin();
});
