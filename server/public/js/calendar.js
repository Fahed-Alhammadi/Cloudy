// Calendar app: month grid over CalDAV-backed calendars.
import { get, post, put, patch, del } from './api.js';
import { h, icon, toast, showError, modal, confirmDialog, promptDialog, showMenu, copyText } from './ui.js';
import { t, locale } from './i18n.js';

const HIDDEN_KEY = 'cloudy-hidden-calendars';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** A time as the language writes it (the grid used 24-hour times while the dialog used the language's own). */
const clock = (d) => d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
/** The first day of the week in the user's language and region (it was always Monday). 0 = Sunday. */
function firstWeekday() {
  try {
    const l = new Intl.Locale(navigator.language.startsWith(locale()) ? navigator.language : locale());
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch { /* older browsers */ }
  return 1;
}
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const parseDay = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toDate = (v, allDay) => (allDay ? parseDay(v) : new Date(v));

// Calendar colors come from CalDAV clients too: only plain hex colors are used, and text on a filled
// (all-day) event is black or white, whichever reads better on that color.
const DEFAULT_COLOR = '#0b6bcb';
const safeColor = (c) => (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c || '') ? c.slice(0, c.length === 9 ? 7 : c.length) : DEFAULT_COLOR);
function textOn(hex) {
  let x = hex.slice(1);
  if (x.length === 3) x = [...x].map((ch) => ch + ch).join('');
  const lin = (i) => { const v = parseInt(x.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  // White as before on mid-tone colors (the default blue is 4.2:1); black only where white would be hard to read.
  const onWhite = 1.05 / (l + 0.05);
  return onWhite >= 4 || onWhite >= (l + 0.05) / 0.05 ? '#fff' : '#111';
}

function loadHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch { return new Set(); }
}
function saveHidden(set) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch { /* storage unavailable */ }
}

// The month on screen survives a reload of the tab (it went back to the current month).
const MONTH_KEY = 'cloudy-calendar-month';
let month = (() => {
  try {
    const m = /^(\d{4})-(\d{2})$/.exec(sessionStorage.getItem(MONTH_KEY) || '');
    if (m) return new Date(+m[1], +m[2] - 1, 1);
  } catch { /* storage unavailable */ }
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
})();
const setMonth = (d) => {
  month = new Date(d.getFullYear(), d.getMonth(), 1);
  try { sessionStorage.setItem(MONTH_KEY, `${month.getFullYear()}-${pad(month.getMonth() + 1)}`); } catch { /* storage unavailable */ }
};
let renderSeq = 0;

export async function renderCalendar(main, ctx) {
  // Two quick clicks on "Next": only the last month asked for is drawn (a slow first answer drew December's events
  // under January's title).
  const seq = ++renderSeq;
  const shown = month;
  const calendars = await get('/api/calendars');
  const hidden = loadHidden();
  const rerender = () => renderCalendar(main, ctx).catch(showError);

  const first = firstWeekday();
  const gridStart = addDays(shown, -((shown.getDay() - first + 7) % 7));
  const gridEnd = addDays(gridStart, 42);
  const visible = calendars.filter((c) => !hidden.has(c.id));
  let failedCalendars = 0;
  const events = (await Promise.all(visible.map((c) =>
    get(`/api/calendars/${c.id}/events?start=${gridStart.toISOString()}&end=${gridEnd.toISOString()}`).catch(() => { failedCalendars++; return []; }),
  ))).flat();
  if (seq !== renderSeq) return;
  const colorOf = Object.fromEntries(calendars.map((c) => [c.id, safeColor(c.color)]));

  const side = h('aside', { class: 'cal-side' },
    // A new event starts in the month on screen (today when that is this month).
    h('button', { class: 'btn primary block', onclick: () => {
      const now = new Date();
      eventDialog(null, calendars, rerender, now.getMonth() === shown.getMonth() && now.getFullYear() === shown.getFullYear() ? now : shown, hidden);
    } }, icon('plus'), t('New event')),
    h('h3', {}, t('Calendars')),
    h('ul', { class: 'cal-list' }, calendars.map((c) => h('li', {},
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !hidden.has(c.id), onchange: (e) => { e.target.checked ? hidden.delete(c.id) : hidden.add(c.id); saveHidden(hidden); rerender(); } }),
        h('span', { class: 'dot', style: { background: colorOf[c.id] } }), c.name),
      h('button', { class: 'icon-btn', 'aria-haspopup': 'menu', 'aria-label': t('Options for {name}', { name: c.name }), onclick: (e) => showMenu(e.currentTarget, [
        { label: t('Rename'), icon: 'edit', onclick: async () => {
          const name = await promptDialog(t('Rename calendar'), t('Name'), c.name, t('Save'));
          if (name) await patch(`/api/calendars/${c.id}`, { name }).then(rerender, showError);
        } },
        { label: t('Change color'), icon: 'settings', onclick: () => colorDialog(c, rerender) },
        { label: t('Copy CalDAV link'), icon: 'link', onclick: () => copyText(`${location.origin}/dav/calendars/${encodeURIComponent(ctx.me.id)}/${encodeURIComponent(c.uri)}/`) },
        '-',
        { label: t('Delete'), icon: 'trash', danger: true, onclick: async () => {
          if (await confirmDialog(t('Delete calendar'), t('Delete "{name}" and all its events?', { name: c.name }), t('Delete'), true)) await del(`/api/calendars/${c.id}`).then(rerender, showError);
        } },
      ]) }, icon('more')),
    ))),
    h('button', { class: 'btn ghost block', onclick: async () => {
      const name = await promptDialog(t('New calendar'), t('Name'), '', t('Create'));
      if (name) await post('/api/calendars', { name }).then(rerender, showError);
    } }, icon('plus'), t('New calendar')),
  );

  const title = shown.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
  const header = h('div', { class: 'toolbar cal-toolbar' },
    h('h1', { class: 'view-title' }, icon('calendar'), h('span', { class: 'title-text' }, title)), h('div', { class: 'grow' }),
    h('button', { class: 'icon-btn', 'aria-label': t('Previous month'), onclick: () => { setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1)); rerender(); } }, icon('left')),
    h('button', { class: 'btn', onclick: () => { setMonth(new Date()); rerender(); } }, t('Today')),
    h('button', { class: 'icon-btn', 'aria-label': t('Next month'), onclick: () => { setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1)); rerender(); } }, icon('right')),
  );
  // A calendar whose events could not be loaded says so (the month just looked empty).
  const loadNotice = failedCalendars > 0 && h('p', { class: 'notice', role: 'alert' }, icon('cloud'),
    t('Some events could not be loaded.'), h('button', { class: 'btn ghost', type: 'button', onclick: rerender }, t('Try again')));

  const weekdays = [...Array(7)].map((_, i) => addDays(gridStart, i));
  // Weeks are ARIA rows (display: contents keeps the 7-column CSS grid); each day is named by its full date.
  const grid = h('div', { class: 'month-grid', role: 'grid', 'aria-label': title },
    h('div', { class: 'week', role: 'row' }, weekdays.map((d) => h('div', { class: 'weekday', role: 'columnheader', 'aria-label': d.toLocaleDateString(locale(), { weekday: 'long' }) },
      d.toLocaleDateString(locale(), { weekday: 'short' })))));
  const today = ymd(new Date());
  // On the days after its first one, a timed event that runs past midnight shows when it ends ("– 02:00"), not
  // its start time again.
  const eventButton = (ev, onOpen, day) => {
    const start = new Date(ev.start);
    const continued = !ev.allDay && day && start < day;
    const end = new Date(ev.end);
    const when = ev.allDay ? null : continued ? (end < addDays(day, 1) ? `– ${clock(end)}` : '…') : clock(start);
    return h('button', {
      type: 'button',
      class: `event ${ev.allDay ? 'all-day' : ''}`,
      style: ev.allDay ? { background: colorOf[ev.calendarId], color: textOn(colorOf[ev.calendarId]) } : { '--cal': colorOf[ev.calendarId] },
      title: ev.summary,
      onclick: (e) => { e.stopPropagation(); onOpen(ev); },
    }, when && h('span', { class: 'time', dir: 'ltr' }, when), h('span', { class: 'ev-title', dir: 'auto' }, ev.summary || t('(no title)')));
  };
  const openEvent = (ev) => eventDialog(ev, calendars, rerender, null, hidden);
  let week;
  for (let i = 0; i < 42; i++) {
    if (i % 7 === 0) grid.append(week = h('div', { class: 'week', role: 'row' }));
    const day = addDays(gridStart, i);
    const next = addDays(day, 1);
    const dayEvents = events
      .filter((e) => toDate(e.start, e.allDay) < next && toDate(e.end, e.allDay) > day)
      .sort((a, b) => (b.allDay - a.allDay) || (toDate(a.start, a.allDay) - toDate(b.start, b.allDay)));
    const label = day.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })
      + (dayEvents.length ? ` – ${t('{n} event(s)', { n: dayEvents.length })}` : '');
    const cell = h('div', {
      class: `day ${day.getMonth() !== shown.getMonth() ? 'other' : ''} ${ymd(day) === today ? 'today' : ''}`,
      role: 'gridcell', tabindex: 0, 'aria-label': label, 'aria-current': ymd(day) === today ? 'date' : null,
      onclick: () => eventDialog(null, calendars, rerender, day, hidden),
      onkeydown: (e) => { if (e.target === e.currentTarget && e.key === 'Enter') eventDialog(null, calendars, rerender, day, hidden); },
    },
      h('span', { class: 'day-num', 'aria-hidden': 'true' }, day.getDate()),
      dayEvents.slice(0, dayEvents.length > 4 ? 3 : 4).map((ev) => eventButton(ev, openEvent, day)),
      // Events that don't fit used to be unreachable; "+n more" lists the whole day.
      dayEvents.length > 4 && h('button', { type: 'button', class: 'more-events', onclick: (e) => {
        e.stopPropagation();
        dayDialog(day, dayEvents, (ev, open) => eventButton(ev, open, day), openEvent, () => eventDialog(null, calendars, rerender, day, hidden));
      } }, t('+{n} more', { n: dayEvents.length - 3 })),
    );
    week.append(cell);
  }

  main.replaceChildren(h('section', { class: 'calendar-view' }, side, h('div', { class: 'cal-main' }, header, loadNotice, grid)));
}

/** All events of one day (opened from "+n more"). */
async function dayDialog(day, dayEvents, eventButton, openEvent, newEvent) {
  let picked = null;
  const body = h('div', { class: 'day-events' });
  body.append(...dayEvents.map((ev) => eventButton(ev, (e) => { picked = e; body.closest('dialog')?.close(); })));
  const v = await modal({
    title: day.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    body,
    buttons: [{ label: t('Close'), value: null }, { label: t('New event'), value: 'new', primary: true }],
  });
  if (picked) openEvent(picked);
  else if (v === 'new') newEvent();
}

async function colorDialog(c, rerender) {
  const input = h('input', { type: 'color', value: c.color || '#0082c9', 'aria-label': t('Color') });
  if ((await modal({ title: t('Color of "{name}"', { name: c.name }), body: input, buttons: [{ label: t('Cancel'), value: null }, { label: t('Save'), value: 'ok', primary: true }] })) === 'ok') {
    await patch(`/api/calendars/${c.id}`, { color: input.value }).then(rerender, showError);
  }
}

async function eventDialog(ev, calendars, rerender, day, hidden = new Set()) {
  if (!calendars.length) return toast(t('Create a calendar first'), 'error');
  const allDay = ev ? ev.allDay : false;
  // Recurring events are edited as a series, so show the series' own times.
  const start = ev ? toDate(ev.recurring ? ev.masterStart : ev.start, allDay) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
  let end = ev ? toDate(ev.recurring ? ev.masterEnd : ev.end, allDay) : new Date(start.getTime() + 3600000);
  if (allDay) end = addDays(end, -1); // all-day ends are exclusive

  const f = {
    summary: h('input', { type: 'text', required: true, value: ev?.summary ?? '', placeholder: t('Event title') }),
    allDay: h('input', { type: 'checkbox', checked: allDay }),
    startDate: h('input', { type: 'date', required: true, value: ymd(start) }),
    startTime: h('input', { type: 'time', value: hm(start) }),
    endDate: h('input', { type: 'date', required: true, value: ymd(end) }),
    endTime: h('input', { type: 'time', value: hm(end) }),
    rrule: h('select', {}, [['', t('Does not repeat')], ['DAILY', t('Daily')], ['WEEKLY', t('Weekly')], ['MONTHLY', t('Monthly')], ['YEARLY', t('Yearly')]]
      .map(([v, l]) => h('option', { value: v, selected: (ev?.rrule ?? '') === v }, l))),
    // A new event goes to a calendar that is shown (it went into the first one, even when that was hidden).
    calendar: h('select', { disabled: !!ev, title: ev ? t('To move an event to another calendar, use a calendar app') : null },
      calendars.map((c) => h('option', { value: c.id, selected: ev ? ev.calendarId === c.id : c.id === (calendars.find((x) => !hidden.has(x.id)) ?? calendars[0]).id }, c.name))),
    location: h('input', { type: 'text', value: ev?.location ?? '' }),
    description: h('textarea', { rows: 3, value: ev?.description ?? '' }),
  };
  const syncTimes = () => { f.startTime.hidden = f.endTime.hidden = f.allDay.checked; };
  // An all-day event made a timed one gets an hour from 9 (it kept 00:00–00:00, and vanished from the month).
  f.allDay.addEventListener('change', () => {
    if (!f.allDay.checked && f.startTime.value === f.endTime.value && f.startDate.value === f.endDate.value) {
      f.startTime.value = '09:00';
      f.endTime.value = '10:00';
      length = 3600000;
    }
  });
  f.allDay.addEventListener('change', syncTimes);
  syncTimes();
  f.startTime.setAttribute('aria-label', t('Start time'));
  f.endTime.setAttribute('aria-label', t('End time'));
  // Moving the start keeps the event's length (like other calendar apps), so the end can't land before it.
  const startsAt = () => new Date(`${f.startDate.value}T${f.allDay.checked ? '00:00' : f.startTime.value || '00:00'}`);
  const endsAt = () => new Date(`${f.endDate.value}T${f.allDay.checked ? '00:00' : f.endTime.value || '00:00'}`);
  let length = endsAt() - startsAt();
  const keepLength = () => {
    const s = startsAt();
    if (Number.isNaN(s.getTime()) || !(length >= 0)) return;
    const e = new Date(s.getTime() + length);
    f.endDate.value = ymd(e);
    if (!f.allDay.checked) f.endTime.value = hm(e);
  };
  const remember = () => { const l = endsAt() - startsAt(); if (l >= 0) length = l; };
  f.startDate.addEventListener('change', keepLength);
  f.startTime.addEventListener('change', keepLength);
  f.endDate.addEventListener('change', remember);
  f.endTime.addEventListener('change', remember);
  const error = h('p', { class: 'error wide', role: 'alert' });

  const body = h('div', { class: 'form-grid' },
    h('label', { class: 'field wide' }, h('span', {}, t('Title')), f.summary),
    h('label', { class: 'check wide' }, f.allDay, t('All day')),
    h('label', { class: 'field' }, h('span', {}, t('Starts')), h('div', { class: 'row' }, f.startDate, f.startTime)),
    h('label', { class: 'field' }, h('span', {}, t('Ends')), h('div', { class: 'row' }, f.endDate, f.endTime)),
    h('label', { class: 'field' }, h('span', {}, t('Repeat')), f.rrule),
    h('label', { class: 'field' }, h('span', {}, t('Calendar')), f.calendar),
    h('label', { class: 'field wide' }, h('span', {}, t('Location')), f.location),
    h('label', { class: 'field wide' }, h('span', {}, t('Description')), f.description),
    ev?.recurring && h('p', { class: 'muted wide' }, t('Changes apply to every occurrence of this repeating event.')),
    error,
  );

  const payload = () => {
    if (f.allDay.checked) {
      return { allDay: true, start: f.startDate.value, end: ymd(addDays(parseDay(f.endDate.value), 1)) };
    }
    // tz: the event keeps its local time when the clocks change (a weekly 09:00 meeting stayed at 09:00 UTC).
    return {
      allDay: false,
      start: new Date(`${f.startDate.value}T${f.startTime.value || '00:00'}`).toISOString(),
      end: new Date(`${f.endDate.value}T${f.endTime.value || '00:00'}`).toISOString(),
      tz: zone(),
    };
  };

  const buttons = [{ label: t('Cancel'), value: null }];
  if (ev) buttons.push({ label: t('Delete'), value: 'delete', danger: true });
  buttons.push({ label: t('Save'), value: 'save', primary: true });
  await modal({
    title: ev ? t('Edit event') : t('New event'), body, buttons, wide: true,
    onSubmit: async (v) => {
      try {
        if (v === 'delete') {
          if (!(await confirmDialog(t('Delete event'), ev.recurring ? t('Delete all occurrences of this event?') : t('Delete this event?'), t('Delete'), true))) return false;
          await del(`/api/calendars/${ev.calendarId}/events/${encodeURIComponent(ev.uri)}`);
        } else {
          if (endsAt() < startsAt()) {
            error.textContent = t('The event ends before it starts.');
            (f.allDay.checked ? f.endDate : f.endTime).focus();
            return false;
          }
          error.textContent = '';
          const data = { summary: f.summary.value, location: f.location.value, description: f.description.value, rrule: f.rrule.value, ...payload() };
          if (ev) await put(`/api/calendars/${ev.calendarId}/events/${encodeURIComponent(ev.uri)}`, data);
          else await post(`/api/calendars/${f.calendar.value}/events`, data);
        }
        rerender();
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
  });
}
