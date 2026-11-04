// Contacts app over CardDAV-backed address books.
import { api, get, post, put, patch, del } from './api.js';
import { h, icon, toast, showError, confirmDialog, promptDialog, showMenu, copyText, modal } from './ui.js';
import { attachDropZone } from './files.js';
import { t, locale } from './i18n.js';

let currentBook = null;
let currentUri = null;
let filter = '';

/** Uploads a .vcf / .csv file into `book` and shows what happened. */
async function importContacts(book, file, rerender) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return showError(new Error(t('That file is too large (20 MB at most).')));
  try {
    toast(t('Importing {name}…', { name: file.name }));
    const r = await api('POST', `/api/addressbooks/${book.id}/import`, file);
    const lines = [
      t('{n} new contact(s) added to "{book}".', { n: r.imported, book: book.name }),
      r.updated && t('{n} existing contact(s) updated (same contact ID).', { n: r.updated }),
      r.duplicates && t('{n} skipped because they are already in the address book.', { n: r.duplicates }),
      r.skipped && t('{n} could not be read.', { n: r.skipped }),
    ].filter(Boolean);
    await modal({ title: t('Import finished'), body: h('div', {},
      lines.map((l) => h('p', {}, l)),
      r.errors?.length ? h('details', {}, h('summary', {}, t('Details')), h('ul', {}, r.errors.map((e) => h('li', { class: 'small muted' }, e)))) : null),
      buttons: [{ label: t('OK'), value: 'ok', primary: true }] });
    rerender();
  } catch (e) { showError(e); }
}

const pickFile = (onFile) => {
  const input = h('input', { type: 'file', accept: '.vcf,.vcard,.csv,text/vcard,text/x-vcard,text/csv', hidden: true,
    onchange: () => { onFile(input.files[0]); input.remove(); } });
  document.body.append(input);
  input.click();
};

const displayName = (c) => c.fn || c.org || c.emails?.[0] || c.phones?.[0] || t('(no name)');
const initials = (c) => (c.fn || c.org || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

export async function renderContacts(main, ctx) {
  const books = await get('/api/addressbooks');
  const rerender = () => renderContacts(main, ctx).catch(showError);
  if (!books.length) {
    main.replaceChildren(h('section', { class: 'empty' }, icon('contacts'), h('p', {}, t('No address books')),
      h('button', { class: 'btn primary', onclick: async () => { await post('/api/addressbooks', { name: t('Contacts') }).catch(showError); rerender(); } }, t('Create address book'))));
    return;
  }
  if (!books.some((b) => b.id === currentBook)) currentBook = books[0].id;
  const book = books.find((b) => b.id === currentBook);
  const contacts = await get(`/api/addressbooks/${book.id}/contacts`);

  const list = h('ul', { class: 'contact-list' });
  const detail = h('div', { class: 'contact-detail' });
  const search = h('input', { type: 'search', placeholder: t('Search contacts'), value: filter, 'aria-label': t('Search contacts') });

  const drawList = () => {
    const q = filter.toLowerCase();
    const shown = contacts.filter((c) => !q || [c.fn, c.org, ...c.emails, ...c.phones].join(' ').toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown.map((c) => h('li', {},
      h('button', { class: `contact-item ${c.uri === currentUri ? 'active' : ''}`, 'aria-current': c.uri === currentUri ? 'true' : null, onclick: () => { currentUri = c.uri; drawList(); drawDetail(c, true); } },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(c)),
        h('span', { class: 'grow' }, h('strong', { dir: 'auto' }, displayName(c)), h('small', { class: 'muted' }, c.emails[0] || c.phones[0] || c.org || ''))))) : [h('li', { class: 'muted pad' }, contacts.length ? t('No matches') : t('No contacts yet'))]));
  };
  search.addEventListener('input', () => { filter = search.value; drawList(); });

  // `reveal`: on phones the form sits below the list, so it is scrolled into view.
  const drawDetail = (c, reveal = false) => {
    const isNew = !c;
    c = c || { fn: '', givenName: '', familyName: '', emails: [], phones: [], org: '', title: '', address: '', birthday: '', note: '' };
    const f = {
      givenName: h('input', { type: 'text', value: c.givenName, autocomplete: 'off' }),
      familyName: h('input', { type: 'text', value: c.familyName, autocomplete: 'off' }),
      org: h('input', { type: 'text', value: c.org }),
      title: h('input', { type: 'text', value: c.title }),
      emails: h('textarea', { rows: 2, value: c.emails.join('\n'), placeholder: t('One per line') }),
      phones: h('textarea', { rows: 2, value: c.phones.join('\n'), placeholder: t('One per line') }),
      address: h('input', { type: 'text', value: c.address }),
      birthday: h('input', { type: 'date', value: /^\d{4}-\d{2}-\d{2}/.test(c.birthday) ? c.birthday.slice(0, 10) : '' }),
      note: h('textarea', { rows: 3, value: c.note }),
    };
    let birthdayTouched = false;
    f.birthday.addEventListener('input', () => { birthdayTouched = true; birthdayNote.hidden = true; });
    const noYear = /^--(\d{2})-?(\d{2})$/.exec(c.birthday || '');
    const birthdayNote = h('small', { class: 'muted', hidden: !c.birthday || f.birthday.value !== '' },
      noYear
        ? t('{date} (no year)', { date: new Date(2000, Number(noYear[1]) - 1, Number(noYear[2])).toLocaleDateString(locale(), { day: 'numeric', month: 'long' }) })
        : c.birthday);
    const save = async (e) => {
      e.preventDefault();
      const data = {
        givenName: f.givenName.value, familyName: f.familyName.value, org: f.org.value, title: f.title.value,
        emails: f.emails.value.split('\n'), phones: f.phones.value.split('\n'), address: f.address.value,
        // A birthday the date field can't show (no year "--04-15", or with a time) goes back exactly as it came,
        // unless the user picked a new date; saving used to erase it.
        birthday: birthdayTouched ? f.birthday.value : (c.birthday || ''), note: f.note.value,
      };
      try {
        const saved = isNew
          ? await post(`/api/addressbooks/${book.id}/contacts`, data)
          : await put(`/api/addressbooks/${book.id}/contacts/${encodeURIComponent(c.uri)}`, data);
        currentUri = saved.uri;
        toast(t('Contact saved'));
        rerender();
      } catch (err) { showError(err); }
    };
    detail.replaceChildren(h('form', { class: 'form-grid', onsubmit: save },
      h('div', { class: 'contact-head wide' }, h('span', { class: 'avatar big' }, isNew ? icon('plus') : initials(c)), h('h2', {}, isNew ? t('New contact') : displayName(c))),
      h('label', { class: 'field' }, h('span', {}, t('First name')), f.givenName),
      h('label', { class: 'field' }, h('span', {}, t('Last name')), f.familyName),
      h('label', { class: 'field' }, h('span', {}, t('Organization')), f.org),
      h('label', { class: 'field' }, h('span', {}, t('Job title')), f.title),
      h('label', { class: 'field' }, h('span', {}, t('Email')), f.emails),
      h('label', { class: 'field' }, h('span', {}, t('Phone')), f.phones),
      h('label', { class: 'field wide' }, h('span', {}, t('Address')), f.address),
      h('label', { class: 'field' }, h('span', {}, t('Birthday')), f.birthday, birthdayNote),
      h('label', { class: 'field wide' }, h('span', {}, t('Notes')), f.note),
      h('div', { class: 'wide row end' },
        !isNew && h('button', { type: 'button', class: 'btn danger', onclick: async () => {
          if (!(await confirmDialog(t('Delete contact'), t('Delete {name}?', { name: displayName(c) }), t('Delete'), true))) return;
          await del(`/api/addressbooks/${book.id}/contacts/${encodeURIComponent(c.uri)}`).catch(showError);
          currentUri = null;
          rerender();
        } }, icon('trash'), t('Delete')),
        h('button', { type: 'submit', class: 'btn primary' }, icon('save'), t('Save'))),
    ));
    f.givenName.focus({ preventScroll: true });
    if (reveal && matchMedia('(max-width: 860px)').matches) detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const bookSelect = h('select', { 'aria-label': t('Address book'), onchange: (e) => { currentBook = Number(e.target.value); currentUri = null; rerender(); } },
    books.map((b) => h('option', { value: b.id, selected: b.id === book.id }, b.name)));

  main.replaceChildren(h('section', { class: 'contacts-view', 'data-drop-label': t('Drop a .vcf or .csv file to import') },
    h('div', { class: 'contacts-side' },
      h('div', { class: 'row' }, bookSelect, h('button', { class: 'icon-btn', 'aria-haspopup': 'menu', 'aria-label': t('Address book options'), onclick: (e) => showMenu(e.currentTarget, [
        { label: t('New address book'), icon: 'plus', onclick: async () => {
          const name = await promptDialog(t('New address book'), t('Name'), '', t('Create'));
          if (name) { const b = await post('/api/addressbooks', { name }).catch(showError); if (b) currentBook = b.id; rerender(); }
        } },
        { label: t('Rename'), icon: 'edit', onclick: async () => {
          const name = await promptDialog(t('Rename address book'), t('Name'), book.name, t('Save'));
          if (name) await patch(`/api/addressbooks/${book.id}`, { name }).then(rerender, showError);
        } },
        { label: t('Import contacts (.vcf, .csv)'), icon: 'upload', onclick: () => pickFile((f) => importContacts(book, f, rerender)) },
        { label: t('Export contacts (.vcf)'), icon: 'download', onclick: () => {
          const a = h('a', { href: `/api/addressbooks/${book.id}/export`, download: `${book.name}.vcf` });
          document.body.append(a); a.click(); a.remove();
        } },
        { label: t('Copy CardDAV link'), icon: 'link', onclick: () => copyText(`${location.origin}/dav/addressbooks/${encodeURIComponent(ctx.me.id)}/${encodeURIComponent(book.uri)}/`) },
        '-',
        { label: t('Delete address book'), icon: 'trash', danger: true, onclick: async () => {
          if (await confirmDialog(t('Delete address book'), t('Delete "{name}" and all its contacts?', { name: book.name }), t('Delete'), true)) await del(`/api/addressbooks/${book.id}`).then(rerender, showError);
        } },
      ]) }, icon('more'))),
      search,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', onclick: () => { currentUri = null; drawList(); drawDetail(null, true); } }, icon('plus'), t('New contact')),
        h('button', { class: 'btn', title: t('Import a .vcf or .csv file'), onclick: () => pickFile((f) => importContacts(book, f, rerender)) }, icon('upload'), t('Import'))),
      list),
    detail));
  // Dropping a .vcf / .csv file anywhere on the contacts view imports it.
  attachDropZone(main.querySelector('.contacts-view'), (items) => importContacts(book, items[0]?.file ?? items[0], rerender));
  drawList();
  const selected = contacts.find((c) => c.uri === currentUri);
  if (selected) drawDetail(selected);
  else detail.replaceChildren(h('div', { class: 'empty' }, icon('contacts'), h('p', {}, t('{n} contact(s)', { n: contacts.length })),
    h('p', { class: 'muted small' }, t('Import contacts from your phone, Google, Outlook or iCloud: export them as a .vcf (or .csv) file, then use Import or drop the file here.'))));
}
