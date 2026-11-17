// Files dragged in from the computer. One handler for the whole window, so a drop never falls through to the browser
// (which opens the file in the tab and leaves the app). While dragging, a strip under the top bar says where the files
// will go: the folder on screen, or the folder under the pointer, which lights up. The strip itself is the sure target
// for "this folder". Views that take no files (Recent…) say so and ignore the drop.
import { h, icon, showError, topDialog } from './ui.js';
import { filesFromDrop } from './upload.js';
import { t } from './i18n.js';

/** The folder on screen that takes drops: { root, here: {id, name}, readOnly, upload(dest, items) }, or null. */
let target = null;
let lit = null;
let watch = null;
const strip = h('div', { id: 'drop-strip', role: 'status', 'aria-live': 'polite' });

export const draggingFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

/** Called by the folder view each time it renders (and with null by views that take no files). */
export function setDropTarget(t) { target = t; }

function destination(e) {
  // A dialog (and the viewer) covers the page: files dropped there have no folder.
  if (topDialog()) return { blocked: t('Close the dialog to upload files') };
  if (!target || !target.root.isConnected) return { blocked: t('Open a folder to upload files') };
  if (target.readOnly) return { blocked: t('This folder is read-only') };
  const row = e.target?.closest?.('[data-folder-id]');
  if (row && target.root.contains(row)) return { id: Number(row.dataset.folderId), name: row.dataset.folderName, row };
  return { id: target.here.id, name: target.here.name };
}

function end() {
  clearTimeout(watch);
  document.body.classList.remove('file-drag');
  lit?.classList.remove('drop-target');
  lit = null;
  target?.root.classList.remove('drop-here');
  delete strip.dataset.key;
}

function onDrag(e) {
  if (!draggingFiles(e)) return;
  // A page that takes the drop itself cancels the event first: no strip then.
  if (e.defaultPrevented) return void end();
  e.preventDefault();
  clearTimeout(watch);
  watch = setTimeout(end, 900); // no dragover for a while: the drag left the window or was cancelled
  const dest = destination(e);
  e.dataTransfer.dropEffect = dest.blocked ? 'none' : 'copy';
  if (!strip.isConnected) document.body.append(strip);
  const key = dest.blocked || String(dest.id);
  if (strip.dataset.key !== key) {
    strip.dataset.key = key;
    strip.classList.toggle('blocked', !!dest.blocked);
    strip.classList.toggle('into', !!dest.row);
    strip.replaceChildren(...(dest.blocked
      ? [icon('lock'), h('span', {}, dest.blocked)]
      : [icon(dest.row ? 'folder' : 'upload'), h('span', {}, dest.row ? t('Drop to upload into') : t('Drop to upload to'), ' ', h('strong', { dir: 'auto' }, dest.name))]));
  }
  if (lit !== (dest.row || null)) {
    lit?.classList.remove('drop-target');
    lit = dest.row || null;
    lit?.classList.add('drop-target');
  }
  target?.root.classList.toggle('drop-here', !dest.blocked && !dest.row);
  document.body.classList.add('file-drag');
}

// dragenter as well as dragover: the destination is right the moment the pointer crosses onto a folder.
window.addEventListener('dragenter', onDrag);
window.addEventListener('dragover', onDrag);
window.addEventListener('drop', (e) => {
  if (!draggingFiles(e)) return;
  if (e.defaultPrevented) return void end();
  e.preventDefault();
  const dest = destination(e);
  const upload = target?.upload;
  end();
  if (dest.blocked || !upload) return;
  filesFromDrop(e.dataTransfer).then((items) => upload({ id: dest.id, name: dest.name }, items)).catch(showError);
});
