// How a list of files is shown, shared by the app and the public link page: list or grid, sort order, tile pictures.
import { h, fileIcon } from './ui.js';
import { locale } from './i18n.js';

// ---------------------------------------------------------------- how a folder is shown
// List or grid and the sort order are kept per browser (the phone apps keep theirs per phone).
const pref = (key, fallback, allowed) => { try { const v = localStorage.getItem(`cloudy.${key}`); return allowed.includes(v) ? v : fallback; } catch { return fallback; } };
const setPref = (key, value) => { try { localStorage.setItem(`cloudy.${key}`, value); } catch { /* private window */ } };
export const viewPrefs = () => ({ view: pref('view', 'list', ['list', 'grid']), key: pref('sort', 'name', 'name mtime size'.split(' ')), desc: pref('desc', '0', ['0', '1']) === '1' });
export const SORTS = [['name', 'Name', 'A to Z', 'Z to A'], ['mtime', 'Modified', 'Oldest first', 'Newest first'], ['size', 'Size', 'Smallest first', 'Largest first']];
export function chooseSort(look, key) {
  if (key === look.key) setPref('desc', look.desc ? '0' : '1');
  else { setPref('sort', key); setPref('desc', key === 'name' ? '0' : '1'); }
}
export const setView = (view) => setPref('view', view);
export const setDescending = (desc) => setPref('desc', desc ? '1' : '0');

/** Folders first, then by the chosen column. Names compare the way people read them: "File 2" before "File 10". */
export function sortItems(items, { key, desc }) {
  const names = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
  const by = key === 'size' ? (a, b) => a.size - b.size || names.compare(a.name, b.name)
    : key === 'mtime' ? (a, b) => new Date(a.mtime) - new Date(b.mtime) || names.compare(a.name, b.name)
    : (a, b) => names.compare(a.name, b.name);
  return [...items].sort((a, b) => (b.isDir - a.isDir) || (desc ? by(b, a) : by(a, b)));
}

export const THUMBABLE = /^(image\/(jpeg|png|gif|webp|avif|heic|heif|tiff)|application\/pdf)$/; // as the server (thumbs.ts)

/** A grid tile's picture: the file's thumbnail when the server makes them, else its type's colour and icon. */
export function tileArt(item, thumbUrl) {
  const ic = fileIcon(item);
  const box = h('div', { class: `tile-art ${[...ic.classList].find((c) => c.startsWith('ic-')) || ''}` }, ic);
  if (thumbUrl && !item.isDir && THUMBABLE.test(item.mime || '') && item.size > 0) {
    // Until it has loaded, the picture lies invisible over the icon (CSS .pending). It must keep its place on the
    // page: a hidden lazy image is never loaded. No thumbnail (a broken or unusual file): the icon stays.
    const img = h('img', { class: 'pending', src: thumbUrl(item), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => { img.classList.remove('pending'); box.replaceChildren(img); }, { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    box.append(img);
  }
  return box;
}

