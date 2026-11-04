// Personal settings and the admin console.
import { get, post, put, patch, del } from './api.js';
import { h, icon, formatSize, fullDate, toast, showError, modal, confirmDialog, promptDialog, copyText } from './ui.js';
import { passkeysSupported, createPasskey, isPasskeyCancel } from './passkey.js';
import { t, LANGUAGES, setLanguage } from './i18n.js';

// ---------------------------------------------------------------- password confirmation
// Sensitive changes ask for the current password. A wrong one (or any other refusal) is shown inside the
// dialog/form, next to the field, and the dialog stays open for another try.

function passwordInput(label = t('Confirm with your password')) {
  const input = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': label });
  const error = h('p', { class: 'error', role: 'alert' });
  const field = h('label', { class: 'field' }, h('span', {}, label), input);
  return { input, error, field };
}

function inlineError(pw, e) {
  pw.error.textContent = t(e?.message || String(e));
  pw.input.focus();
  pw.input.select();
}

/**
 * Dialog that confirms an action with the password: `submit(password)` does the request and returns its result;
 * resolves with that result, or null when cancelled.
 */
export async function withPasswordDialog({ title, okLabel, danger = false, intro = null, fields = [], submit }) {
  const pw = passwordInput();
  let result = null;
  await modal({
    title,
    body: h('div', {}, intro, fields, pw.field, pw.error),
    buttons: [{ label: t('Cancel'), value: null }, { label: okLabel, value: 'ok', primary: true, danger }],
    onSubmit: async () => {
      pw.error.textContent = '';
      try { result = (await submit(pw.input.value)) ?? {}; return true; } catch (e) { inlineError(pw, e); return false; }
    },
  });
  return result;
}

export async function renderSettings(main, ctx) {
  const me = await get('/api/me');
  const [appPasswords, passkeys] = await Promise.all([get('/api/me/app-passwords'), get('/api/me/passkeys')]);
  const rerender = () => renderSettings(main, ctx).catch(showError);
  const davBase = `${location.origin}/dav`;

  const name = h('input', { type: 'text', value: me.displayName });
  const email = h('input', { type: 'email', value: me.email });
  const notifyShares = h('input', { type: 'checkbox', checked: me.notifyShares !== false });
  const language = h('select', {}, h('option', { value: '' }, t('Automatic (browser language)')),
    LANGUAGES.map(([code, label]) => h('option', { value: code, selected: me.language === code }, label)));
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  // Changing the email address needs the current password (reset links go there); other profile edits don't.
  const emailPw = passwordInput(t('Current password (needed to change the email)'));
  const emailPwBox = h('div', { class: 'wide', hidden: true }, emailPw.field, emailPw.error);
  const emailChanged = () => email.value.trim() !== (me.email || '');
  email.addEventListener('input', () => {
    emailPwBox.hidden = !emailChanged();
    emailPw.input.required = emailChanged();
    if (!emailChanged()) { emailPw.input.value = ''; emailPw.error.textContent = ''; }
  });
  emailPw.input.required = false;
  const pwError = h('p', { class: 'error wide', role: 'alert' });
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const pct = me.quotaBytes ? Math.min(100, (me.used / me.quotaBytes) * 100) : 0;

  const urlRow = (label, url) => h('div', { class: 'url-row' }, h('span', { class: 'muted' }, label),
    h('code', {}, url), h('button', { class: 'icon-btn', 'aria-label': t('Copy {what}', { what: label }), onclick: () => copyText(url) }, icon('copy')));

  main.replaceChildren(h('section', { class: 'settings-view' },
    h('h1', { class: 'view-title' }, icon('settings'), t('Settings')),

    h('div', { class: 'card' }, h('h2', {}, t('Storage')),
      me.quotaBytes ? h('progress', { max: 100, value: pct, class: 'quota' }) : null,
      h('p', {}, me.quotaBytes
        ? t('{used} of {quota} used, including trash and versions.', { used: formatSize(me.used), quota: formatSize(me.quotaBytes) })
        : t('{used} used (no quota), including trash and versions.', { used: formatSize(me.used) }))),

    h('form', { class: 'card form-grid', onsubmit: busyForm(async () => {
      emailPw.error.textContent = '';
      const body = { displayName: name.value, email: email.value, notifyShares: notifyShares.checked, language: language.value || null };
      if (emailChanged()) body.password = emailPw.input.value;
      try {
        await patch('/api/me', body);
      } catch (err) {
        if (emailChanged()) inlineError(emailPw, err);
        else showError(err);
        return;
      }
      // A new language redraws the whole app (sidebar included).
      if ((me.language || '') !== language.value) await setLanguage(language.value || null);
      toast(t('Profile saved'));
      await ctx.refreshMe();
    }) },
      h('h2', { class: 'wide' }, t('Profile')),
      h('label', { class: 'field' }, h('span', {}, t('Display name')), name),
      h('label', { class: 'field' }, h('span', {}, t('Email')), email),
      h('label', { class: 'field' }, h('span', {}, t('Language')), language),
      emailPwBox,
      h('label', { class: 'check wide' }, notifyShares, t('Email me when something is shared with me')),
      h('p', { class: 'muted small wide' }, t('Your language is used here, in the Android and desktop apps and in emails. Your email is also used for password reset links and security notices.')),
      h('div', { class: 'wide row end' }, h('button', { class: 'btn primary', type: 'submit' }, t('Save profile')))),

    h('form', { class: 'card form-grid', onsubmit: busyForm(async (e) => {
      pwError.textContent = '';
      try {
        await post('/api/me/password', { current: cur.value, password: pw1.value });
        toast(t('Password changed'));
        e.target.reset();
      } catch (err) {
        pwError.textContent = t(err.message);
        cur.focus();
      }
    }) },
      h('h2', { class: 'wide' }, t('Password')),
      h('label', { class: 'field' }, h('span', {}, t('Current password')), cur),
      h('label', { class: 'field' }, h('span', {}, t('New password (8+ characters)')), pw1),
      pwError,
      h('div', { class: 'wide row end' }, h('button', { class: 'btn primary', type: 'submit' }, t('Change password')))),

    passkeysCard(passkeys, rerender),
    twoFactorCard(me, rerender),

    h('div', { class: 'card' }, h('h2', {}, t('Connect apps and devices')),
      h('p', {}, t('Use these addresses in a WebDAV client (Finder, Windows Explorer, rclone, Cyberduck) or a calendar/contacts app (Thunderbird, DAVx⁵, Apple Calendar/Contacts). Sign in with your username and an app password.')),
      urlRow(t('Files (WebDAV)'), `${davBase}/files/${encodeURIComponent(me.id)}/`),
      urlRow(t('Calendars & contacts'), `${davBase}/`),
      urlRow(t('Username'), me.id),
      h('h3', {}, t('App passwords')),
      appPasswords.length ? h('ul', { class: 'plain-list' }, appPasswords.map((p) => h('li', {}, icon('key'),
        h('span', { class: 'grow' }, p.name, h('small', { class: 'muted' }, ' · ' + t('created {date}', { date: fullDate(p.createdAt) }) + (p.lastUsedAt ? ' · ' + t('last used {date}', { date: fullDate(p.lastUsedAt) }) : ''))),
        h('button', { class: 'btn ghost danger', onclick: async () => {
          if (await confirmDialog(t('Revoke app password'), t('Devices using "{name}" will be signed out.', { name: p.name }), t('Revoke'), true)) await del(`/api/me/app-passwords/${p.id}`).then(rerender, showError);
        } }, t('Revoke'))))) : h('p', { class: 'muted' }, t('No app passwords yet.')),
      h('button', { class: 'btn', onclick: async () => {
        const label = h('input', { type: 'text', required: true, maxlength: 100, value: t('My laptop'), 'aria-label': t('Device name') });
        const r = await withPasswordDialog({
          title: t('New app password'), okLabel: t('Create'),
          fields: [h('label', { class: 'field' }, h('span', {}, t('Device name')), label)],
          submit: (password) => post('/api/me/app-passwords', { name: label.value.trim(), password }),
        });
        if (!r?.password) return;
        await modal({ title: t('App password created'), body: h('div', {},
          h('p', {}, t('Copy it now — it will not be shown again.')),
          h('div', { class: 'url-row' }, h('code', { class: 'secret' }, r.password), h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Copy'), onclick: () => copyText(r.password) }, icon('copy')))) });
        rerender();
      } }, icon('plus'), t('Create app password'))),

    deleteAccountCard(),
  ));
}

/** Form submit handler that disables the form's buttons while `fn` runs (no double submits). */
function busyForm(fn) {
  return async (e) => {
    e.preventDefault();
    const buttons = [...e.currentTarget.querySelectorAll('button')];
    buttons.forEach((b) => { b.disabled = true; });
    try { await fn(e); } catch (err) { showError(err); } finally { buttons.forEach((b) => { b.disabled = false; }); }
  };
}

// ---------------------------------------------------------------- delete account

// Same wording and flow as the Android and iPhone apps: explain what goes, confirm with the password, then sign out.
function deleteAccountCard() {
  const open = async () => {
    const deleted = await withPasswordDialog({
      title: t('Delete account?'), okLabel: t('Delete account'), danger: true,
      intro: h('p', {}, t('This permanently deletes your account and everything in it: files (including trash and versions), shares and links, calendars, contacts and devices. It can’t be undone.')),
      submit: (password) => post('/api/me/delete', { password }),
    });
    if (deleted) location.reload(); // the session is gone: back to the sign-in page
  };
  return h('div', { class: 'card' }, h('h2', {}, t('Delete account')),
    h('p', {}, t('Deletes your account and all your data on this server for good.')),
    h('button', { class: 'btn danger', onclick: open }, icon('trash'), t('Delete account')));
}

// ---------------------------------------------------------------- passkeys

function passkeysCard(passkeys, rerender) {
  const add = async () => {
    const name = h('input', { type: 'text', maxlength: 60, placeholder: t('e.g. MacBook, iPhone, YubiKey'), 'aria-label': t('Passkey name') });
    const pw = passwordInput();
    let added = false;
    await modal({
      title: t('Add a passkey'),
      body: h('div', {},
        h('p', {}, t('Your device will ask you to confirm with your fingerprint, face, screen lock or security key.')),
        h('label', { class: 'field' }, h('span', {}, t('Name')), name),
        pw.field, pw.error),
      buttons: [{ label: t('Cancel'), value: null }, { label: t('Continue'), value: 'ok', primary: true }],
      onSubmit: async () => {
        pw.error.textContent = '';
        let options;
        try {
          options = await post('/api/me/passkeys/options', { password: pw.input.value });
        } catch (e) { inlineError(pw, e); return false; }
        try {
          const cred = await createPasskey(options);
          await post('/api/me/passkeys', { ...cred, name: name.value.trim() });
          added = true;
          return true;
        } catch (e) {
          if (e?.name === 'InvalidStateError') pw.error.textContent = t('This device already has a passkey for your account');
          else if (!isPasskeyCancel(e)) pw.error.textContent = t(e?.message || String(e));
          return false;
        }
      },
    });
    if (added) { toast(t('Passkey added')); rerender(); }
  };

  return h('div', { class: 'card' }, h('h2', {}, t('Passkeys')),
    h('p', {}, t('Sign in without a password using your fingerprint, face, screen lock or a security key. A passkey replaces both your password and the two-factor code.')),
    passkeys.length ? h('ul', { class: 'plain-list' }, passkeys.map((p) => h('li', {}, icon('key'),
      h('span', { class: 'grow' }, p.name, h('small', { class: 'muted' }, ' · ' + t('added {date}', { date: fullDate(p.createdAt) }) + (p.lastUsedAt ? ' · ' + t('last used {date}', { date: fullDate(p.lastUsedAt) }) : ''))),
      h('button', { class: 'icon-btn', 'aria-label': t('Rename {name}', { name: p.name }), onclick: async () => {
        const name = await promptDialog(t('Rename passkey'), t('Name'), p.name, t('Rename'));
        if (name) await patch(`/api/me/passkeys/${p.id}`, { name }).then(rerender, showError);
      } }, icon('edit')),
      h('button', { class: 'btn ghost danger', onclick: async () => {
        if (await confirmDialog(t('Remove passkey'), t('You will no longer be able to sign in with "{name}". Also delete it from the device or password manager.', { name: p.name }), t('Remove'), true)) await del(`/api/me/passkeys/${p.id}`).then(rerender, showError);
      } }, t('Remove'))))) : h('p', { class: 'muted' }, t('No passkeys yet.')),
    passkeysSupported()
      ? h('button', { class: 'btn', onclick: add }, icon('plus'), t('Add a passkey'))
      : h('p', { class: 'muted small' }, t('This browser cannot create passkeys here. Passkeys need HTTPS (or localhost) and a recent browser.')));
}

// ---------------------------------------------------------------- two-factor authentication

function recoveryCodesBody(codes) {
  const text = codes.join('\n');
  return h('div', {},
    h('p', {}, t('Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. They will not be shown again.')),
    h('pre', { class: 'recovery-codes' }, text),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => copyText(text) }, icon('copy'), t('Copy')),
      h('button', { type: 'button', class: 'btn', onclick: () => {
        // A short-lived blob URL (one per click, released right after) instead of one kept for the whole session.
        const url = URL.createObjectURL(new Blob([`Cloudy recovery codes\n\n${text}\n`], { type: 'text/plain' }));
        const a = h('a', { href: url, download: 'cloudy-recovery-codes.txt' });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }, icon('download'), t('Download'))));
}

function twoFactorCard(me, rerender) {
  const enable = async () => {
    // Step 1: the password (the server checks it before handing out a new secret).
    const setup = await withPasswordDialog({
      title: t('Turn on two-factor authentication'), okLabel: t('Continue'),
      submit: (password) => post('/api/me/2fa/setup', { password }),
    });
    if (!setup?.secret) return;
    const codeError = h('p', { class: 'error', role: 'alert' });
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, placeholder: '123 456', 'aria-label': t('Code from the app') });
    let codes = null;
    await modal({
      title: t('Turn on two-factor authentication'),
      body: h('div', { class: 'twofa-setup' },
        h('p', {}, t('1. Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).')),
        h('img', { class: 'qr', alt: t('QR code for your authenticator app'), src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(setup.qrSvg) }),
        h('p', { class: 'muted small' }, t("Can't scan? Enter this key manually:"), ' ', h('code', { class: 'secret' }, setup.secret.replace(/(.{4})/g, '$1 ').trim())),
        h('label', { class: 'field' }, h('span', {}, t('2. Enter the 6-digit code the app shows')), code), codeError),
      buttons: [{ label: t('Cancel'), value: null }, { label: t('Turn on'), value: 'ok', primary: true }],
      onSubmit: async () => {
        codeError.textContent = '';
        try {
          codes = (await post('/api/me/2fa/enable', { code: code.value })).recoveryCodes;
          return true;
        } catch (e) { codeError.textContent = t(e.message); code.focus(); code.select(); return false; }
      },
    });
    if (codes) {
      await modal({ title: t('Two-factor authentication is on'), body: recoveryCodesBody(codes), buttons: [{ label: t("I've saved them"), value: 'ok', primary: true }] });
      rerender();
    }
  };

  const withPassword = (title, okLabel, danger, path) => withPasswordDialog({ title, okLabel, danger, submit: (password) => post(path, { password }) });

  return h('div', { class: 'card' }, h('h2', {}, t('Two-factor authentication')),
    me.twoFactor
      ? h('div', {},
          h('p', {}, h('span', { class: 'pill' }, t('on')), ' ', t('Signing in requires a code from your authenticator app. Apps that use WebDAV, CalDAV or CardDAV must use an app password.')),
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: async () => {
              const r = await withPassword(t('New recovery codes'), t('Create new codes'), false, '/api/me/2fa/recovery-codes');
              if (r?.recoveryCodes) await modal({ title: t('New recovery codes'), body: recoveryCodesBody(r.recoveryCodes), buttons: [{ label: t('Done'), value: 'ok', primary: true }] });
            } }, icon('key'), t('New recovery codes')),
            h('button', { class: 'btn danger', onclick: async () => {
              if (await withPassword(t('Turn off two-factor authentication'), t('Turn off'), true, '/api/me/2fa/disable')) { toast(t('Two-factor authentication is off')); rerender(); }
            } }, t('Turn off'))))
      : h('div', {},
          h('p', {}, t('Protect your account with a code from your phone in addition to your password.')),
          h('button', { class: 'btn primary', onclick: enable }, icon('lock'), t('Turn on two-factor authentication'))),
  );
}

// ---------------------------------------------------------------- admin

const GB = 1024 ** 3;

async function userDialog(user, groups, rerender) {
  const isNew = !user;
  const f = {
    id: h('input', { type: 'text', required: true, value: user?.id ?? '', disabled: !isNew, pattern: '[A-Za-z0-9._@-]+' }),
    displayName: h('input', { type: 'text', value: user?.displayName ?? '' }),
    email: h('input', { type: 'email', value: user?.email ?? '' }),
    password: h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: isNew, placeholder: isNew ? '' : t('Leave empty to keep') }),
    quota: h('input', { type: 'number', min: 0, step: 0.5, value: user?.quotaBytes ? +(user.quotaBytes / GB).toFixed(2) : '', placeholder: t('Unlimited') }),
    isAdmin: h('input', { type: 'checkbox', checked: !!user?.isAdmin }),
    disabled: h('input', { type: 'checkbox', checked: !!user?.disabled }),
    resetTwoFactor: h('input', { type: 'checkbox' }),
    removePasskeys: h('input', { type: 'checkbox' }),
    groups: h('select', { multiple: true, size: Math.min(6, Math.max(2, groups.length)) }, groups.map((g) => h('option', { value: g.id, selected: user?.groups.includes(g.id) }, g.id))),
  };
  await modal({
    title: isNew ? t('New user') : t('Edit {name}', { name: user.id }), wide: true,
    body: h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', {}, t('Username')), f.id),
      h('label', { class: 'field' }, h('span', {}, t('Password')), f.password),
      h('label', { class: 'field' }, h('span', {}, t('Display name')), f.displayName),
      h('label', { class: 'field' }, h('span', {}, t('Email')), f.email),
      h('label', { class: 'field' }, h('span', {}, t('Quota (GB)')), f.quota),
      h('label', { class: 'field' }, h('span', {}, t('Groups')), groups.length ? f.groups : h('span', { class: 'muted' }, t('No groups yet'))),
      h('label', { class: 'check' }, f.isAdmin, t('Administrator')),
      user?.twoFactor && h('label', { class: 'check' }, f.resetTwoFactor, t('Reset two-factor authentication (lost phone)')),
      user?.passkeys > 0 && h('label', { class: 'check' }, f.removePasskeys, t('Remove all passkeys ({n})', { n: user.passkeys })),
      !isNew && h('label', { class: 'check' }, f.disabled, t('Disabled')),
    ),
    buttons: [{ label: t('Cancel'), value: null }, { label: isNew ? t('Create') : t('Save'), value: 'save', primary: true }],
    onSubmit: async () => {
      const data = {
        displayName: f.displayName.value, email: f.email.value, isAdmin: f.isAdmin.checked,
        quotaBytes: f.quota.value ? Math.round(Number(f.quota.value) * GB) : null,
        groups: [...f.groups.selectedOptions].map((o) => o.value),
      };
      try {
        if (isNew) await post('/api/admin/users', { ...data, id: f.id.value.trim(), password: f.password.value });
        else await patch(`/api/admin/users/${encodeURIComponent(user.id)}`, { ...data, disabled: f.disabled.checked, password: f.password.value || undefined, resetTwoFactor: f.resetTwoFactor.checked || undefined, removePasskeys: f.removePasskeys.checked || undefined });
        rerender();
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
  });
}

export async function renderAdmin(main, ctx) {
  const [users, groups, mail] = await Promise.all([get('/api/admin/users'), get('/api/admin/groups'), get('/api/admin/mail')]);
  const rerender = () => renderAdmin(main, ctx).catch(showError);
  main.replaceChildren(h('section', { class: 'settings-view' },
    h('div', { class: 'toolbar' }, h('h1', { class: 'view-title' }, icon('shield'), t('Administration')), h('div', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: () => userDialog(null, groups, rerender) }, icon('plus'), t('New user'))),
    h('div', { class: 'card' }, h('h2', {}, t('Users ({n})', { n: users.length })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, [t('User'), t('Email'), t('Groups'), t('Storage'), t('Role'), h('span', { class: 'sr-only' }, t('Actions'))].map((th) => h('th', {}, th)))),
        h('tbody', {}, users.map((u) => h('tr', { class: u.disabled ? 'dim' : '' },
          h('td', {}, h('strong', {}, u.displayName), h('div', { class: 'muted small' }, u.id)),
          h('td', {}, u.email),
          h('td', {}, u.groups.join(', ')),
          h('td', { class: 'nowrap' }, `${formatSize(u.used)}${u.quotaBytes ? ` / ${formatSize(u.quotaBytes)}` : ''}`),
          h('td', {}, u.isAdmin ? h('span', { class: 'pill' }, t('admin')) : '', u.twoFactor ? h('span', { class: 'pill' }, '2FA') : '', u.passkeys ? h('span', { class: 'pill' }, t('passkey')) : '', u.disabled ? h('span', { class: 'pill warn' }, t('disabled')) : ''),
          h('td', { class: 'nowrap' },
            h('button', { class: 'icon-btn', 'aria-label': t('Edit {name}', { name: u.id }), onclick: () => userDialog(u, groups, rerender) }, icon('edit')),
            u.id !== ctx.me.id && h('button', { class: 'icon-btn', 'aria-label': t('Delete {name}', { name: u.id }), onclick: async () => {
              if (await confirmDialog(t('Delete user'), t('Delete {name} and ALL their files, calendars and contacts? This cannot be undone.', { name: u.id }), t('Delete'), true)) {
                await del(`/api/admin/users/${encodeURIComponent(u.id)}`).then(rerender, showError);
              }
            } }, icon('trash'))),
        )))))),
    h('div', { class: 'card' }, h('h2', {}, t('Groups')),
      groups.length ? h('ul', { class: 'plain-list' }, groups.map((g) => h('li', {}, icon('users'),
        h('span', { class: 'grow' }, g.id, h('small', { class: 'muted' }, ' · ' + t('{n} member(s)', { n: g.members }))),
        h('button', { class: 'icon-btn', 'aria-label': t('Delete group {name}', { name: g.id }), onclick: async () => {
          if (await confirmDialog(t('Delete group'), t('Delete group "{name}"? Shares with this group are removed.', { name: g.id }), t('Delete'), true)) await del(`/api/admin/groups/${encodeURIComponent(g.id)}`).then(rerender, showError);
        } }, icon('trash'))))) : h('p', { class: 'muted' }, t('No groups yet.')),
      h('button', { class: 'btn', onclick: async () => {
        const id = await promptDialog(t('New group'), t('Group name'), '', t('Create'));
        if (id) await post('/api/admin/groups', { id }).then(rerender, showError);
      } }, icon('plus'), t('New group'))),
    mailCard(mail, ctx, rerender),
  ));
}

// ---------------------------------------------------------------- email (SMTP)

function mailCard(mail, ctx, rerender) {
  const f = {
    host: h('input', { type: 'text', value: mail?.host ?? '', placeholder: 'smtp.example.com' }),
    port: h('input', { type: 'number', min: 1, max: 65535, value: mail?.port ?? 587 }),
    security: h('select', {}, [['starttls', 'STARTTLS (port 587)'], ['tls', 'SSL/TLS (port 465)'], ['none', t('None (local relay only)')]]
      .map(([v, l]) => h('option', { value: v, selected: (mail?.security ?? 'starttls') === v }, l))),
    user: h('input', { type: 'text', value: mail?.user ?? '', autocomplete: 'off' }),
    password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: mail?.hasPassword ? t('Unchanged') : '' }),
    fromName: h('input', { type: 'text', value: mail?.fromName ?? 'Cloudy' }),
    fromEmail: h('input', { type: 'email', value: mail?.fromEmail ?? '', placeholder: 'cloudy@example.com' }),
  };
  f.security.addEventListener('change', () => { f.port.value = f.security.value === 'tls' ? 465 : f.security.value === 'none' ? 25 : 587; });
  const status = h('span', { class: 'muted' }, mail?.host ? t('Email is on.') : t('Email is off.'));
  const save = () => put('/api/admin/mail', {
    host: f.host.value.trim(), port: Number(f.port.value), security: f.security.value, user: f.user.value.trim(),
    password: f.password.value, fromName: f.fromName.value.trim(), fromEmail: f.fromEmail.value.trim(),
  });
  return h('form', { class: 'card form-grid', onsubmit: async (e) => {
    e.preventDefault();
    try { await save(); toast(f.host.value.trim() ? t('Email settings saved') : t('Email turned off')); rerender(); } catch (err) { showError(err); }
  } },
    h('h2', { class: 'wide' }, t('Email (SMTP)')),
    h('p', { class: 'muted wide' }, t("Lets Cloudy send password reset links, share notifications and security notices to the email address in each user's profile. Leave the server empty to turn email off.")),
    h('label', { class: 'field' }, h('span', {}, t('SMTP server')), f.host),
    h('label', { class: 'field' }, h('span', {}, t('Port')), f.port),
    h('label', { class: 'field' }, h('span', {}, t('Encryption')), f.security),
    h('label', { class: 'field' }, h('span', {}, t('Username')), f.user),
    h('label', { class: 'field' }, h('span', {}, t('Password')), f.password),
    h('label', { class: 'field' }, h('span', {}, t('From name')), f.fromName),
    h('label', { class: 'field wide' }, h('span', {}, t('From email')), f.fromEmail),
    h('div', { class: 'wide row end' }, status,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const to = await promptDialog(t('Send test email'), t('Send to'), ctx.me.email || '', t('Send'));
        if (!to) return;
        try {
          await save();
          status.textContent = t('Sending…');
          const r = await post('/api/admin/mail/test', { to });
          status.textContent = t('Test email sent to {to}.', { to: r.to });
          toast(t('Test email sent'));
        } catch (err) { status.textContent = ''; showError(err); }
      } }, t('Save and send test')),
      h('button', { class: 'btn primary', type: 'submit' }, t('Save'))),
  );
}
