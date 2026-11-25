// Pure helpers for filtering result tables in the browser. No DOM, no storage:
// used by public/app.js in both the standalone site and the Chrome extension.

export const NO_PROJECT = '(No project)';
export const NO_CALLBACK = '(No callback)';

export function projectLabel(item) { return String(item?.projectName ?? '').trim() || NO_PROJECT; }
export function accessLabel(item) { return String(item?.access ?? '').trim() || '—'; }

// Callback names mapped to the row's project/class, or "(No callback)".
export function callbackLabels(item) {
  const names = [...new Set((item?.callbacks ?? []).map((entry) => String(entry?.name ?? '').trim()).filter(Boolean))];
  return names.length ? names : [NO_CALLBACK];
}

// Distinct values with counts, sorted A–Z (case-insensitive), "(No project)"/"(No callback)" last.
// labelFor may return one label or several (a row mapped to two callbacks counts under both).
export function filterOptions(items, labelFor) {
  const counts = new Map();
  for (const item of items ?? []) {
    const labels = labelFor(item);
    for (const label of Array.isArray(labels) ? labels : [labels]) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const last = (value) => value === NO_PROJECT || value === NO_CALLBACK;
  return [...counts].map(([value, count]) => ({ value, count }))
    .sort((a, b) => last(a.value) - last(b.value) || a.value.localeCompare(b.value, undefined, { sensitivity: 'base' }));
}

export function searchTerms(query) { return String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean); }

// A row is shown when it matches the selected project, access and callback and every search word.
// An empty selection means "all".
export function customCodeRowVisible(item, rowText, { project = '', access = '', callback = '', terms = [] } = {}) {
  if (project && projectLabel(item) !== project) return false;
  if (access && accessLabel(item) !== access) return false;
  if (callback && !callbackLabels(item).includes(callback)) return false;
  const text = String(rowText ?? '').toLowerCase();
  return terms.every((term) => text.includes(term));
}
