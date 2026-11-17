// Text helpers. The web app is English only (since 2.0); t() fills in {placeholders}.

/** `text` with {placeholders} filled in from `vars`. */
export function t(text, vars) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}

/**
 * Locale for Intl / toLocale*(): the browser's own English variant, so dates and the first day of the week follow the
 * region (English in Britain writes 15/11/2026, in the US 11/15/2026).
 */
let cached = null;
export const locale = () => {
  if (cached) return cached;
  const regional = (navigator.languages?.length ? navigator.languages : [navigator.language])
    .find((l) => String(l || '').split('-')[0].toLowerCase() === 'en');
  try { cached = Intl.getCanonicalLocales(regional || 'en')[0]; } catch { cached = 'en'; }
  return cached;
};
