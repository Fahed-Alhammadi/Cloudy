// Translations. Text is written in English in the code — t('Upload') — and looked up in
// /i18n/<lang>.json ({"English": "translation"}); anything missing stays English.
// The language is the account's choice (Settings → Profile), else the one picked on the login page,
// else the browser's. Keep LANGUAGES in sync with src/i18n.ts and Android's locales_config.xml.

export const LANGUAGES = [
  ['en', 'English'],
  ['ar', 'العربية'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
];
const RTL = new Set(['ar']);
const STORE_KEY = 'cloudy-lang';

let lang = 'en';
let dict = {};

const supported = (code) => LANGUAGES.some(([c]) => c === code);

/** Translates `text`, filling {placeholders} from `vars`. */
export function t(text, vars) {
  let out = dict[text] ?? text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

export const currentLanguage = () => lang;

/**
 * Locale for Intl / toLocale*(): the browser's own variant of the chosen language, so dates and the first day of the
 * week follow the region (English in Britain writes 15/11/2026, in the US 11/15/2026; it was always the US form).
 * Arabic keeps Latin digits so dates match sizes and times.
 */
let localeFor = { lang: null, value: null };
export const locale = () => {
  if (localeFor.lang === lang) return localeFor.value;
  const regional = (navigator.languages?.length ? navigator.languages : [navigator.language])
    .find((l) => String(l || '').split('-')[0].toLowerCase() === lang);
  let value = lang;
  for (const candidate of [regional, lang]) {
    if (!candidate) continue;
    const tag = lang === 'ar' ? `${String(candidate).split('-u-')[0]}-u-nu-latn` : String(candidate);
    try { value = Intl.getCanonicalLocales(tag)[0]; break; } catch { /* not a valid tag: the plain language */ }
  }
  localeFor = { lang, value };
  return value;
};

export function browserLanguage() {
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const code = String(l || '').split('-')[0].toLowerCase();
    if (supported(code)) return code;
  }
  return 'en';
}

export function storedLanguage() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

/**
 * Switches the language (null = the browser's) and remembers it on this device, so the login page
 * uses it too. Callers re-render afterwards.
 */
export async function setLanguage(code) {
  try {
    if (code && supported(code)) localStorage.setItem(STORE_KEY, code);
    else localStorage.removeItem(STORE_KEY);
  } catch { /* storage unavailable */ }
  if (!code || !supported(code)) code = browserLanguage();
  if (code === lang && (code === 'en' || Object.keys(dict).length)) return;
  dict = code === 'en' ? {} : await fetch(`/i18n/${code}.json`).then((r) => (r.ok ? r.json() : {}), () => ({}));
  lang = code;
  document.documentElement.lang = code;
  document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr';
}
