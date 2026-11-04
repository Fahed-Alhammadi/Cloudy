// Full-screen HTML5 viewer: images, video, audio, PDF and an editable text view.
import { api } from './api.js';
import { h, icon, formatSize, toast, showError, confirmDialog } from './ui.js';
import { t } from './i18n.js';

const TEXT_LIMIT = 2 * 1024 * 1024;

export function kindOf(node) {
  const m = node.mime || '';
  if (/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(m)) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/') || /json|xml|javascript|yaml/.test(m)) return 'text';
  return null;
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

  // A file that can't be loaded says so in the viewer, with the download as a way out.
  function failed(e) {
    showError(e);
    const node = files[index];
    stage.replaceChildren(h('div', { class: 'no-preview' }, icon('file'), h('p', {}, t(e?.message || String(e))),
      h('a', { class: 'btn primary', href: src.url(node, false), download: node.name }, icon('download'), t('Download'))));
  }

  const confirmDiscard = () => confirmDialog(t('Discard changes?'), t('You have unsaved changes.'), t('Discard'), true);

  async function close() {
    if (dirty && !(await confirmDiscard())) return;
    dlg.close();
  }

  async function go(delta) {
    if (dirty && !(await confirmDiscard())) return;
    const n = files.length;
    index = (index + delta + n) % n;
    show().catch(failed);
  }

  async function show() {
    dirty = false;
    const node = files[index];
    const kind = kindOf(node);
    title.replaceChildren(h('strong', {}, node.name), h('span', { class: 'muted' }, ` · ${formatSize(node.size)}`));
    actions.replaceChildren(
      h('a', { class: 'btn ghost', href: src.url(node, false), download: node.name }, icon('download'), t('Download')),
    );
    prev.hidden = next.hidden = files.length < 2;
    stage.replaceChildren();
    const inline = src.url(node, true);
    if (kind === 'image') stage.append(h('img', { src: inline, alt: node.name }));
    else if (kind === 'video') stage.append(h('video', { src: inline, controls: true, autoplay: true, playsinline: true }));
    else if (kind === 'audio') stage.append(h('div', { class: 'audio-card' }, icon('audio'), h('div', {}, node.name), h('audio', { src: inline, controls: true, autoplay: true })));
    else if (kind === 'pdf') stage.append(h('iframe', { src: inline, title: node.name }));
    else if (src.preview?.(node)) await showPreview(node, src.preview(node));
    else if (kind === 'text' && node.size <= TEXT_LIMIT) await showText(node, inline);
    else stage.append(h('div', { class: 'no-preview' }, icon('file'), h('p', {}, t('No preview available for this file type.')),
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

  async function showText(node, inline) {
    const res = await fetch(inline, { credentials: 'same-origin' });
    // An error page must never land in the editor (saving it would overwrite the file).
    if (!res.ok) throw new Error(await res.json().then((j) => j.error, () => res.statusText));
    const text = await res.text();
    // The user may have gone on to another file while this one loaded.
    if (files[index] !== node) return;
    if (!src.canEdit) {
      stage.append(h('pre', { class: 'text-view' }, text));
      return;
    }
    const area = h('textarea', { class: 'text-editor', spellcheck: false, 'aria-label': node.name, value: text });
    const save = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
      try {
        save.disabled = true;
        const updated = await api('PUT', `/api/nodes/${node.id}/content`, new Blob([area.value], { type: 'text/plain' }));
        files[index] = { ...node, ...updated };
        dirty = false;
        toast(t('Saved'));
        src.onSaved?.();
      } catch (e) {
        save.disabled = false;
        showError(e);
      }
    } }, icon('save'), t('Save'));
    area.addEventListener('input', () => { dirty = true; save.disabled = false; });
    area.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!save.disabled) save.click(); }
    });
    actions.prepend(save);
    stage.append(area);
    area.focus();
  }

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('keydown', (e) => {
    // Arrow keys inside the editor or a video/audio player (seeking, volume) stay there.
    if (/^(TEXTAREA|INPUT|VIDEO|AUDIO|SELECT)$/.test(e.target.tagName) || files.length < 2) return;
    // In right-to-left languages "previous" sits on the right, so the arrows swap too.
    const rtl = document.documentElement.dir === 'rtl';
    if (e.key === 'ArrowLeft') go(rtl ? 1 : -1);
    if (e.key === 'ArrowRight') go(rtl ? -1 : 1);
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  show().catch(failed);
}
