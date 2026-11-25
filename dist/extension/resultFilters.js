// Pure helpers for filtering result tables in the browser. No DOM, no storage:
// used by public/app.js in both the standalone site and the Chrome extension.

export const NO_PROJECT = '(No project)';

export function projectLabel(item) { return String(item?.projectName ?? '').trim() || NO_PROJECT; }
export function accessLabel(item) { return String(item?.access ?? '').trim() || '—'; }

// Distinct values with counts, sorted A–Z (case-insensitive), "(No project)" last.
export function filterOptions(items, labelFor) {
  const counts = new Map();
  for (const item of items ?? []) { const label = labelFor(item); counts.set(label, (counts.get(label) ?? 0) + 1); }
  return [...counts].map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value === NO_PROJECT) - (b.value === NO_PROJECT) || a.value.localeCompare(b.value, undefined, { sensitivity: 'base' }));
}

export function searchTerms(query) { return String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean); }

// A row is shown when it matches the selected project, the selected access and every search word.
// An empty project/access selection means "all".
export function customCodeRowVisible(item, rowText, { project = '', access = '', terms = [] } = {}) {
  if (project && projectLabel(item) !== project) return false;
  if (access && accessLabel(item) !== access) return false;
  const text = String(rowText ?? '').toLowerCase();
  return terms.every((term) => text.includes(term));
}
