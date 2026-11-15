// Full-screen HTML5 viewer: images, video, audio, PDF and an editable text view.
import { api } from './api.js';
import { h, icon, formatSize, toast, showError, confirmDialog, modal } from './ui.js';
import { t } from './i18n.js';

const TEXT_LIMIT = 2 * 1024 * 1024;

const OFFICE = /^application\/(vnd\.openxmlformats|vnd\.oasis\.opendocument|msword|vnd\.ms-)/;

export function kindOf(node) {
  const m = node.mime || '';
  if (/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(m)) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (OFFICE.test(m)) return null;
  if (m.startsWith('text/') || /^application\/((.+\+)?(json|xml)|(x-)?(javascript|yaml|sh)|sql|toml)$/.test(m)) return 'text';
  return null;
}

// Back closes the viewer: it adds a history entry when it opens. app.js asks whether a "back" was the viewer's own.
let ownBack = false;
export function consumeViewerBack() {
  const was = ownBack;
  ownBack = false;
  return was || !!document.querySelector('dialog.viewer[open]');
}

/**
 * Reads a text file for the editor: the byte-order mark and Windows line ends are remembered and written back
 * (saving used to drop them), and a file that is not UTF-8 is shown read-only (saving it would have damaged every
 * character outside ASCII for good).
 */
async function readText(res) {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  let utf8 = true;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    utf8 = false;
    text = new TextDecoder('utf-8').decode(bytes);
  }
  if (bom) text = text.replace(/^﻿/, '');
  const crlf = /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
  return { text, bom, crlf, utf8 };
}

/**
 * files: the sibling files (for prev/next), start: index.
 * src = { url(node, inline) -> string, preview?(node) -> PDF preview URL or null, canEdit: bool, onSaved?() }
 */
export function openViewer(files, start, src) {
  let index = start;
  let dirty = false;
  const stage = h('div', { class: 'viewer-stage' });
  const title = h('div', { class: 'viewer-title', id: 'viewer-title' });
  const actions = h('div', { class: 'viewer-actions' });
  const prev = h('button', { class: 'icon-btn viewer-nav prev', 'aria-label': t('Previous'), onclick: () => go(-1) }, icon('left'));
  const next = h('button', { class: 'icon-btn viewer-nav next', 'aria-label': t('Next'), onclick: () => go(1) }, icon('right'));
  const dlg = h('dialog', { class: 'viewer', 'aria-labelledby': 'viewer-title' },
    h('header', {}, title, actions, h('button', { class: 'icon-btn', 'aria-label': t('Close'), onclick: () => close() }, icon('x'))),
    stage, prev, next,
  );
  const setDirty = (on) => {
    dirty = on;
    dlg.dataset.dirty = String(on); // app.js: a session that ends now asks to sign in again instead of closing this
  };

  // A file that can't be loaded says so in the viewer, with the download as a way out.
  function failed(e) {
    showError(e);
    const node = files[index];
    stage.replaceChildren(h('div', { class: 'no-preview' }, icon('file'), h('p', {}, t(e?.message || String(e))),
      h('a', { class: 'btn primary', href: src.url(node, false), download: node.name }, icon('download'), t('Download'))));
  }
  const gone = () => {
    const node = files[index];
    stage.replaceChildren(h('div', { class: 'no-preview' }, icon('file'), h('p', {}, t('This file is no longer available. It may have been moved, deleted or unshared.'))));
    title.replaceChildren(h('strong', { dir: 'auto' }, node.name));
  };
  // A picture, video or sound that does not show: gone (404), or a format or a damage this browser cannot handle
  // (AVI, MKV, HEVC video…). Only the first is "no longer available"; the second offers the download.
  const mediaFailed = async () => {
    const node = files[index];
    const status = await fetch(src.url(node, false), { method: 'HEAD', credentials: 'same-origin' }).then((r) => r.status, () => 0);
    if (files[index] !== node || !dlg.open) return; // moved on meanwhile
    if (status === 404) return gone();
    stage.replaceChildren(h('div', { class: 'no-preview' }, icon('file'), h('p', {}, t('This file cannot be shown in the browser.')),
      h('a', { class: 'btn primary', href: src.url(node, false), download: node.name }, icon('download'), t('Download'))));
  };

  const confirmDiscard = () => confirmDialog(t('Discard changes?'), t('You have unsaved changes.'), t('Discard'), true);
  // Closing the tab or reloading with unsaved text: the browser asks first.
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // The browser's Back closes the viewer (it used to leave the folder, and unsaved text with it).
  const openedAt = location.href;
  history.pushState({ cloudyViewer: true }, '', openedAt);
  let asking = false;
  const onPop = async () => {
    if (!dlg.open || asking) return; // Back again while "Discard changes?" is open: one question is enough
    asking = true;
    const leave = !dirty || (await confirmDiscard());
    asking = false;
    if (!leave) {
      // Stays open: its entry comes back (and the page's own entry first, when Back went past it).
      if (location.href !== openedAt) history.pushState(null, '', openedAt);
      history.pushState({ cloudyViewer: true }, '', openedAt);
      return;
    }
    finish();
    // Back pressed more than once went past the page the viewer was opened on: show the page the address is at now.
    if (location.href !== openedAt) window.dispatchEvent(new Event('cloudy:navigate'));
  };
  window.addEventListener('popstate', onPop);

  function finish() {
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('beforeunload', beforeUnload);
    if (dlg.open) dlg.close();
  }

  async function close() {
    if (dirty && !(await confirmDiscard())) return;
    setDirty(false);
    finish();
    if (history.state?.cloudyViewer) { ownBack = true; history.back(); }
  }

  async function go(delta) {
    if (dirty && !(await confirmDiscard())) return;
    const n = files.length;
    index = (index + delta + n) % n;
    show().catch(failed);
  }

  async function show() {
    setDirty(false);
    const node = files[index];
    const kind = kindOf(node);
    const position = files.length > 1 ? h('span', { class: 'muted' }, ` · ${t('{n} of {total}', { n: index + 1, total: files.length })}`) : null;
    const size = h('span', { class: 'muted' }, ` · ${formatSize(node.size)}`);
    title.replaceChildren(h('strong', { dir: 'auto' }, node.name), size, position);
    actions.replaceChildren(
      h('a', { class: 'btn ghost', href: src.url(node, false), download: node.name }, icon('download'), t('Download')),
    );
    prev.hidden = next.hidden = files.length < 2;
    stage.replaceChildren();
    const inline = src.url(node, true);
    // Video and audio wait for Play (they used to start, with sound, as soon as they were opened).
    if (kind === 'image') stage.append(h('img', { src: inline, alt: node.name, onerror: mediaFailed }));
    else if (kind === 'video') stage.append(h('video', { src: inline, controls: true, playsinline: true, preload: 'metadata', onerror: mediaFailed }));
    else if (kind === 'audio') stage.append(h('div', { class: 'audio-card' }, icon('audio'), h('div', { dir: 'auto' }, node.name), h('audio', { src: inline, controls: true, preload: 'metadata', onerror: mediaFailed })));
    else if (kind === 'pdf') stage.append(h('iframe', { src: inline, title: node.name }));
    else if (src.preview?.(node)) await showPreview(node, src.preview(node));
    else if (kind === 'text' && node.size <= TEXT_LIMIT) await showText(node, inline, size);
    else stage.append(h('div', { class: 'no-preview' }, icon('file'),
      h('p', {}, kind === 'text' ? t('This text file is too large to show here (over 2 MB). Download it to open it.') : t('No preview available for this file type.')),
      h('a', { class: 'btn primary', href: src.url(node, false), download: node.name }, icon('download'), t('Download'))));
  }

  /** Office document: the server converts it to PDF (can take a few seconds the first time). */
  async function showPreview(node, url) {
    const shown = node;
    const note = h('div', { class: 'no-preview' }, icon('file'), h('p', {}, t('Preparing preview…')));
    stage.append(note);
    // Wait for the conversion, then let the iframe load the (now cached) PDF; the body isn't read here.
    const ctl = new AbortController();
    const res = await fetch(url, { credentials: 'same-origin', signal: ctl.signal });
    if (res.ok) ctl.abort();
    if (files[index] !== shown) return;
    if (!res.ok) {
      const msg = await res.json().then((j) => j.error, () => null);
      note.replaceChildren(icon('file'), h('p', {}, msg ? t(msg) : t('No preview available for this file.')),
        h('a', { class: 'btn primary', href: src.url(node, false), download: node.name }, icon('download'), t('Download')));
      return;
    }
    stage.replaceChildren(h('iframe', { src: url, title: node.name }));
  }

  async function showText(node, inline, sizeLabel) {
    const res = await fetch(inline, { credentials: 'same-origin' });
    if (res.status === 404) return gone();
    // An error page must never land in the editor (saving it would overwrite the file).
    if (!res.ok) throw new Error(await res.json().then((j) => j.error, () => res.statusText));
    const { text, bom, crlf, utf8 } = await readText(res);
    // The user may have gone on to another file while this one loaded.
    if (files[index] !== node) return;
    if (!src.canEdit || !utf8) {
      if (!utf8 && src.canEdit) stage.append(h('p', { class: 'viewer-note' }, t('This file is not UTF-8 text. It is shown read-only, so that saving cannot damage it.')));
      stage.append(h('pre', { class: 'text-view', dir: 'auto' }, text));
      return;
    }
    let version = node.etag;
    const area = h('textarea', { class: 'text-editor', spellcheck: 'false', dir: 'auto', 'aria-label': node.name, value: text });
    const encode = (value) => (bom ? '﻿' : '') + (crlf ? value.replace(/\n/g, '\r\n') : value);
    const saveAs = async (body, overwrite) => {
      const headers = { 'X-Cloudy-Request': '1', 'Content-Type': 'application/octet-stream' };
      if (!overwrite && version) headers['If-Match'] = `"${version}"`;
      const res2 = await fetch(`/api/nodes/${node.id}/content`, { method: 'PUT', headers, body: new Blob([body], { type: 'text/plain' }), credentials: 'same-origin' });
      if (res2.status === 401) window.dispatchEvent(new CustomEvent('cloudy:unauthorized'));
      const data = res2.headers.get('content-type')?.includes('json') ? await res2.json() : null;
      if (!res2.ok) { const err = new Error(data?.error || res2.statusText); err.status = res2.status; throw err; }
      return data;
    };
    const save = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
      const sent = area.value;
      save.disabled = true;
      try {
        let updated;
        try {
          updated = await saveAs(encode(sent), false);
        } catch (e) {
          if (e.status !== 412) throw e;
          // Someone else saved a newer version since this one was opened.
          const choice = await modal({
            title: t('This file was changed'),
            body: h('p', {}, t('Someone else saved "{name}" after you opened it. Overwriting replaces their changes (their version stays under Versions).', { name: node.name })),
            buttons: [{ label: t('Cancel'), value: null }, { label: t('Overwrite'), value: 'overwrite', danger: true, primary: true }],
          });
          if (choice !== 'overwrite') { save.disabled = false; return; }
          updated = await saveAs(encode(sent), true);
        }
        files[index] = { ...node, ...updated };
        version = updated?.etag ?? version;
        sizeLabel.textContent = ` · ${formatSize(updated?.size ?? node.size)}`;
        // Text typed while the save was on its way is still unsaved.
        setDirty(area.value !== sent);
        save.disabled = !dirty;
        toast(t('Saved'));
        src.onSaved?.();
      } catch (e) {
        save.disabled = false;
        if (e.status !== 401) showError(e);
      }
    } }, icon('save'), t('Save'));
    area.addEventListener('input', () => { setDirty(true); save.disabled = false; });
    area.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!save.disabled) save.click(); }
    });
    actions.prepend(save);
    stage.append(area);
    area.focus();
  }

  // A click on the dark area around a picture or a document closes the viewer.
  // Only when the press started there too: selecting text by dragging past the editor's edge ends with a click on the
  // stage, which closed the editor.
  let pressedOnStage = false;
  stage.addEventListener('pointerdown', (e) => { pressedOnStage = e.target === stage; });
  stage.addEventListener('click', (e) => {
    if (e.target === stage && pressedOnStage) close();
    pressedOnStage = false;
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('keydown', (e) => {
    // Arrow keys inside the editor or a video/audio player (seeking, volume) stay there.
    if (/^(TEXTAREA|INPUT|VIDEO|AUDIO|SELECT)$/.test(e.target.tagName) || files.length < 2) return;
    // In right-to-left languages "previous" sits on the right, so the arrows swap too.
    const rtl = document.documentElement.dir === 'rtl';
    if (e.key === 'ArrowLeft') go(rtl ? 1 : -1);
    if (e.key === 'ArrowRight') go(rtl ? -1 : 1);
  });
  dlg.addEventListener('close', () => {
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('beforeunload', beforeUnload);
    dlg.remove();
  });
  document.body.append(dlg);
  dlg.showModal();
  show().catch(failed);
}
