// The app is English only: t() fills in {name} placeholders, e.g. t('Kept both versions of {name}.', { name }).
export function t(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}
