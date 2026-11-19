import { projectLabel, accessLabel, filterOptions, searchTerms, customCodeRowVisible } from './resultFilters.js';

const state = {
  config: null, connection: null,
  selectedObject: null, selectedField: null,
  objectResults: [], fieldResults: [],
  objectSearchSequence: 0, fieldSearchSequence: 0
};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
const debounce = (fn, wait = 250) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; };

// One UI, two runtimes. Every API call goes through request():
//   - standalone site: HTTP to the local Node server (server/index.js);
//   - Chrome extension: the same API router (server/api.js, copied to core/api.js by
//     `npm run build:extension`) runs in this page and calls Conga Platform directly.
// Never call the /api/ routes any other way, or the extension build breaks.
const isExtension = globalThis.location?.protocol === 'chrome-extension:';
let localApi = null;
async function extensionApi() {
  if (!localApi) {
    const [{ createApi }, { default: config }] = await Promise.all([import('./core/api.js'), import('./extension-config.js')]);
    localApi = createApi({
      runtime: 'extension',
      env: {},
      platformUrlOptions: { allowedHosts: config.allowedHosts ?? [] },
      linkTemplates: config.linkTemplates
    });
  }
  return localApi;
}
async function request(path, options = {}) {
  if (isExtension) {
    const api = await extensionApi();
    const url = new URL(path, 'https://extension.invalid');
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    const result = await api.handle({ method: options.method ?? 'GET', pathname: url.pathname, body });
    if (result.status < 200 || result.status >= 300) throw new Error(result.body?.error ?? `Request failed (${result.status})`);
    return result.body;
  }
  const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'omit', headers: { 'Content-Type': 'application/json', ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}
function applyRuntimeLabels() {
  if (!isExtension) return;
  document.body.classList.add('runtime-extension');
  $('#mode-title').textContent = 'Extension mode';
  $('#mode-detail').textContent = 'Runs in your browser';
  $('#connect-copy').textContent = 'Enter your Conga Platform URL and a current bearer token. The extension validates both directly with Conga Platform from this browser tab. Nothing passes through another server, and no session, cookie, file, cache entry, or extension storage is created.';
  $('#trust-copy').textContent = 'ⓘ Transient memory is required to execute requests, but nothing is persisted at rest. Closing or reloading this tab clears the connection.';
}
function showError(error) { $('#error span').textContent = error.message ?? String(error); $('#error').classList.remove('hidden'); }
function clearError() { $('#error').classList.add('hidden'); }
function option(value, text) { return `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`; }
function connectionPayload(extra = {}) {
  if (!state.connection) throw new Error('Connect to Conga Platform first');
  return { platformUrl: state.connection.platformUrl, bearerToken: state.connection.bearerToken, ...extra };
}
async function platformRequest(path, extra = {}) {
  return request(path, { method: 'POST', body: JSON.stringify(connectionPayload(extra)) });
}
function openOptions(kind) { $(`#${kind}-options`).classList.remove('hidden'); $(`#${kind}-search`).setAttribute('aria-expanded', 'true'); }
function closeOptions(kind) { $(`#${kind}-options`).classList.add('hidden'); $(`#${kind}-search`).setAttribute('aria-expanded', 'false'); }
function formatObject(item) { return `${item.label} - ${item.name}`; }
function formatField(item) { return `${item.label} - ${item.name} - ${item.type}`; }

async function initialize() {
  try {
    applyRuntimeLabels();
    state.config = await request('/api/config');
    $('#platform-url').value = '';
    $('#connect-dialog').classList.remove('hidden');
  } catch (error) { showError(error); }
}
async function connect() {
  const button = $('#connect');
  const pending = { platformUrl: $('#platform-url').value.trim(), bearerToken: $('#bearer-token').value };
  try {
    clearError(); button.disabled = true; button.innerHTML = '<span class="spin">◌</span> Validating';
    const validation = await request('/api/platform/validate', { method: 'POST', body: JSON.stringify(pending) });
    state.connection = { ...pending, platformUrl: validation.platformUrl, organizationName: validation.organizationName };
    $('#bearer-token').value = ''; $('#connect-dialog').classList.add('hidden');
    activateConnection(); await searchObjects('');
  } catch (error) { pending.bearerToken = ''; state.connection = null; showError(error); }
  finally { button.disabled = false; button.innerHTML = '✓ Validate and load metadata'; }
}
function tenantName(platformUrl) { return new URL(platformUrl).hostname.split('.')[0]; }
function activateConnection() {
  const tenant = state.connection.organizationName || tenantName(state.connection.platformUrl);
  $('#object-search').disabled = false; $('#object-search').value = ''; $('#field-search').value = ''; $('#field-search').disabled = true;
  $('#tenant-name').textContent = tenant; $('#tenant-url').textContent = state.connection.platformUrl; $('#tenant-chip').title = state.connection.platformUrl;
  $('#side-session').textContent = `${tenant} · connected`; $('#tenant-chip').classList.remove('hidden'); $('#disconnect').classList.remove('hidden');
}
async function searchObjects(query) {
  if (!state.connection) return;
  const sequence = ++state.objectSearchSequence;
  $('#object-search-status').textContent = 'Searching all object pages…';
  $('#object-options').innerHTML = '<div class="combo-message"><span class="spin">◌</span> Searching tenant…</div>'; openOptions('object');
  try {
    const result = await platformRequest('/api/platform/objects/search', { query, limit: 50 });
    if (sequence !== state.objectSearchSequence) return;
    state.objectResults = result.items;
    $('#object-search-status').textContent = `${result.totalMatches.toLocaleString()} match${result.totalMatches === 1 ? '' : 'es'} across ${result.totalScanned.toLocaleString()} objects`;
    $('#object-options').innerHTML = result.items.length ? result.items.map((item, index) => `<button type="button" role="option" data-index="${index}"><strong>${escapeHtml(formatObject(item))}</strong>${item.category ? `<small>${escapeHtml(item.category)}</small>` : ''}</button>`).join('') : '<div class="combo-message">No matching objects</div>';
  } catch (error) { if (sequence === state.objectSearchSequence) { showError(error); $('#object-options').innerHTML = '<div class="combo-message error-text">Object search failed</div>'; } }
}
function selectObject(item) {
  state.selectedObject = item; state.selectedField = null; state.fieldResults = [];
  $('#object-search').value = formatObject(item); closeOptions('object');
  $('#field-search').disabled = false; $('#field-search').value = ''; $('#field-search').placeholder = 'Search field label, API name, or data type';
  $('#run-scan').disabled = true; $('#field-identity').classList.add('hidden'); $('#usage-results').classList.add('hidden');
  searchFields(''); $('#field-search').focus();
}
async function searchFields(query) {
  if (!state.connection || !state.selectedObject) return;
  const sequence = ++state.fieldSearchSequence;
  $('#field-search-status').textContent = 'Searching complete object schema…';
  $('#field-options').innerHTML = '<div class="combo-message"><span class="spin">◌</span> Searching fields…</div>'; openOptions('field');
  try {
    const result = await platformRequest('/api/platform/fields/search', { objectName: state.selectedObject.name, query, limit: 50 });
    if (sequence !== state.fieldSearchSequence) return;
    state.fieldResults = result.items;
    $('#field-search-status').textContent = `${result.totalMatches.toLocaleString()} match${result.totalMatches === 1 ? '' : 'es'} across ${result.totalScanned.toLocaleString()} fields`;
    $('#field-options').innerHTML = result.items.length ? result.items.map((item, index) => `<button type="button" role="option" data-index="${index}"><strong>${escapeHtml(formatField(item))}</strong></button>`).join('') : '<div class="combo-message">No matching fields</div>';
  } catch (error) { if (sequence === state.fieldSearchSequence) { showError(error); $('#field-options').innerHTML = '<div class="combo-message error-text">Field search failed</div>'; } }
}
function selectField(field) {
  state.selectedField = field; $('#field-search').value = formatField(field); closeOptions('field');
  $('#run-scan').disabled = false; renderField(field); $('#usage-results').classList.add('hidden');
}
function renderField(field) {
  $('#field-identity code').textContent = `${state.selectedObject.name}.${field.name}`; $('#field-identity .type').textContent = field.type;
  for (const [selector, enabled] of [['.required', field.required], ['.calculated', field.calculated], ['.protected', field.protected]]) $('#field-identity').querySelector(selector).classList.toggle('hidden', !enabled);
  $('#field-identity').classList.remove('hidden');
}
async function runUsageScan() {
  if (!state.selectedObject || !state.selectedField) return;
  const button = $('#run-scan');
  try {
    clearError(); button.disabled = true; button.innerHTML = '<span class="spin">◌</span> Scanning';
    $('#usage-results').classList.remove('hidden'); $('#usage-panel').open = true; $('#usage-status').className = 'pill running'; $('#usage-status').textContent = '◌ Scanning';
    const result = await platformRequest('/api/platform/usage-scan', { objectName: state.selectedObject.name, fieldName: state.selectedField.name });
    renderUsage(result); $('#usage-status').className = 'pill success'; $('#usage-status').textContent = '✓ Complete';
  } catch (error) { $('#usage-status').className = 'pill failed'; $('#usage-status').textContent = '⚠ Failed'; showError(error); }
  finally { button.disabled = false; button.innerHTML = 'Find usage'; }
}
function usageSection(title, count, emptyText, body, open = false) {
  const header = (tag) => `<${tag} class="section-row"><span class="section-arrow" aria-hidden="true"></span><span class="section-title">${escapeHtml(title)}</span><span class="section-count">${count}</span>${count ? '' : `<span class="section-note">${escapeHtml(emptyText)}</span>`}</${tag}>`;
  if (!count) return `<div class="usage-section is-empty" aria-disabled="true">${header('div')}</div>`;
  return `<details class="usage-section"${open ? ' open' : ''}>${header('summary')}${body}</details>`;
}
function table(headers, rows) {
  return `<table class="usage-table"><thead><tr>${headers.map((text) => `<th>${escapeHtml(text)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderUsage(result) {
  const workflows = result.workflows ?? [];
  const fieldExpressions = result.fieldExpressions ?? [];
  const customCode = result.customCode ?? [];
  const total = result.formulaDependencies.length + workflows.length + fieldExpressions.length + customCode.length;
  $('#usage-summary').textContent = `${result.field.objectName}.${result.field.fieldName} · ${total} reference${total === 1 ? '' : 's'}`;
  const coverage = [
    ...result.coverage.collectors.map((item) => `${item.label}: ${item.status}, ${item.matches} match${item.matches === 1 ? '' : 'es'}`),
    `Scanned: ${result.coverage.objectsScanned ?? 1} objects, ${result.coverage.fieldsScanned} fields, ${result.coverage.workflowsScanned ?? 0} workflows, ${result.coverage.fieldExpressionsScanned ?? 0} field expressions, ${result.coverage.customCodeProjectsScanned ?? 0} custom code projects (${result.coverage.customCodeFilesScanned ?? 0} files), ${result.coverage.serviceHooksScanned ?? 0} Service Hooks`
  ];
  $('#coverage-section').innerHTML = usageSection('Scan coverage', coverage.length, '', `<ul class="plain-list">${coverage.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`);
  $('#formula-section').innerHTML = usageSection('Formula dependencies', result.formulaDependencies.length, 'No formula dependencies found',
    table(['Object', 'Field name', 'Formula'], result.formulaDependencies.map((item) => [
      escapeHtml(item.objectName),
      `${referenceTitle(item.fieldName, item.viewUrl)}${item.direction === 'depends-on' ? ' <span class="muted">(selected field\'s own formula)</span>' : ''}`,
      item.expression ? `<code>${escapeHtml(item.expression)}</code>` : `<code>${escapeHtml((item.dependencies ?? []).join(', '))}</code>`
    ])));
  $('#workflow-section').innerHTML = usageSection('Workflows', workflows.length, 'No workflow references found',
    table(['Workflow name', 'Type'], workflows.map((item) => [
      referenceTitle(item.workflowName, item.viewUrl), escapeHtml(item.usage)
    ])));
  $('#fieldexpression-section').innerHTML = usageSection('Field expressions', fieldExpressions.length, 'No field expression references found',
    fieldExpressionLegend + table(['Field expression name', 'Is active', 'Expression type', 'Scope', 'Filter expression', 'Update object', 'Update field', 'Update expression'],
      fieldExpressions.map(fieldExpressionRow)));
  renderCustomCode(customCode);
}
// One Field Expression row. The cell that references the scanned field is highlighted:
// green = exact match, orange = probable match (see the legend above the table). Blank values stay blank.
function fieldExpressionRow(item) {
  const matches = item.matches ?? [];
  const level = (...properties) => {
    const hit = matches.filter((match) => properties.includes(match.property));
    if (!hit.length) return null;
    return { confidence: hit.some((match) => match.confidence === 'Exact') ? 'exact' : 'probable', title: hit.map((match) => match.note).filter(Boolean).join('; ') };
  };
  const mark = (html, ...properties) => {
    const hit = level(...properties);
    if (!hit || !html) return html;
    return `<span class="field-match field-match-${hit.confidence}"${hit.title ? ` title="${escapeHtml(hit.title)}"` : ''}>${html}</span>`;
  };
  const code = (value) => (value ? `<code>${escapeHtml(value)}</code>` : '');
  const extra = matches.filter((match) => match.property === 'GroupByField' || match.property === 'ParentField')
    .map((match) => `<div class="muted">${escapeHtml(match.usage)}: ${mark(code(match.snippet), match.property)}</div>`).join('');
  return [
    `${referenceTitle(item.expressionName, item.viewUrl)}${extra}`,
    item.active === null || item.active === undefined ? '' : item.active ? 'Yes' : 'No',
    escapeHtml(item.expressionType ?? ''),
    escapeHtml(fieldExpressionScope(item)),
    mark(code(item.conditionExpression), 'ConditionExpression'),
    escapeHtml(item.updateObject ?? ''),
    mark(code(item.updateField), 'UpdateField'),
    mark(code(item.expression), 'Expression')
  ];
}
const fieldExpressionLegend = '<div class="match-legend"><span><i class="field-match-exact"></i>Exact match</span><span><i class="field-match-probable"></i>Probable match</span></div>';
// "Product - Internet Service", "Product Group - Hardware"; a scope with no item (e.g. Header) is shown on its own.
function fieldExpressionScope(item) {
  const scope = item.conditionScope || '';
  const key = scope.toLowerCase().replace(/[^a-z]/g, '');
  const target = key === 'product' ? item.product : key === 'productgroup' ? item.productGroup : null;
  if (!scope) return item.product ? `Product - ${item.product}` : item.productGroup ? `Product Group - ${item.productGroup}` : '';
  return target ? `${scope} - ${target}` : scope;
}
function runsAsText(item) {
  if (!item.runsAs || !item.runsAs.length) return '<span class="muted">Not linked to a hook, callback or Custom API</span>';
  return item.runsAs.map((entry) => `<div><strong>${escapeHtml(entry.type)}</strong> ${escapeHtml(entry.name)}${entry.objectName ? ` <span class="muted">on ${escapeHtml(entry.objectName)}</span>` : ''}${entry.active === false ? ' <span class="muted">(inactive)</span>' : ''}</div>`).join('');
}
function confidenceBadge(value) { return `<span class="confidence confidence-${escapeHtml(String(value).toLowerCase())}">${escapeHtml(value)}</span>`; }
function customCodeLocation(item) {
  if (item.access === 'Condition') {
    return `<strong>Service Hook condition</strong>${item.projectName ? `<div class="muted">${referenceTitle(item.projectName, item.viewUrl)}</div>` : ''}`;
  }
  return `${referenceTitle(item.projectName, item.viewUrl)}<div class="muted">${escapeHtml(item.filePath)}:${escapeHtml(item.line)}</div>`;
}
function filterCustomCode(section, items) {
  const filters = {
    project: section.querySelector('.table-filter-project')?.value ?? '',
    access: section.querySelector('.table-filter-access')?.value ?? '',
    terms: searchTerms(section.querySelector('.table-search-input')?.value)
  };
  const rows = [...section.querySelectorAll('tbody tr')];
  let shown = 0;
  rows.forEach((row, index) => {
    const visible = customCodeRowVisible(items[index], row.textContent, filters);
    row.classList.toggle('hidden', !visible);
    if (visible) shown += 1;
  });
  const filtered = filters.project || filters.access || filters.terms.length;
  section.querySelector('.table-search-count').textContent = filtered ? `${shown} of ${rows.length} shown` : '';
  section.querySelector('.table-search-empty').classList.toggle('hidden', shown > 0);
  section.querySelector('.table-filter-clear').classList.toggle('hidden', !filtered);
}
function filterSelect(className, label, allText, options) {
  return `<label class="table-filter"><span>${escapeHtml(label)}</span><select class="${className}" aria-label="Filter by ${escapeHtml(label.toLowerCase())}"><option value="">${escapeHtml(allText)}</option>${options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.value)} (${option.count})</option>`).join('')}</select></label>`;
}
function renderCustomCode(items) {
  // Reuses existing styles (.top-actions, .search-box) because the CSP blocks inline styles.
  const controls = '<div class="top-actions table-filters">' +
    '<div class="search-box"><span class="muted" aria-hidden="true">⌕</span><input type="search" class="table-search-input" placeholder="Search custom code results" aria-label="Search custom code results" autocomplete="off" spellcheck="false"></div>' +
    filterSelect('table-filter-project', 'Project', 'All projects', filterOptions(items, projectLabel)) +
    filterSelect('table-filter-access', 'Access', 'All access', filterOptions(items, accessLabel)) +
    '<button type="button" class="link-button table-filter-clear hidden">Clear filters</button>' +
    '<span class="table-search-count muted"></span></div>';
  const empty = '<div class="table-search-empty muted hidden">No results match your filters.</div>';
  $('#customcode-section').innerHTML = usageSection('Custom code', items.length, 'No custom code references found', controls +
    table(['Project / file', 'Class · method', 'Access', 'Confidence', 'Runs as', 'Code'], items.map((item) => [
      customCodeLocation(item),
      escapeHtml([item.className, item.methodName].filter(Boolean).join(' · ') || '—'),
      escapeHtml(item.access),
      confidenceBadge(item.confidence),
      runsAsText(item),
      `<code>${escapeHtml(item.snippet)}</code>`
    ])) + empty);
  const section = $('#customcode-section');
  if (!section.querySelector('.table-filters')) return;
  const apply = () => filterCustomCode(section, items);
  section.querySelector('.table-search-input').addEventListener('input', apply);
  section.querySelector('.table-filter-project').addEventListener('change', apply);
  section.querySelector('.table-filter-access').addEventListener('change', apply);
  section.querySelector('.table-filter-clear').addEventListener('click', () => {
    section.querySelector('.table-search-input').value = '';
    section.querySelector('.table-filter-project').value = '';
    section.querySelector('.table-filter-access').value = '';
    apply();
  });
}
function safeHref(value) { try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null; } catch { return null; } }
function referenceTitle(text, viewUrl) { const href = viewUrl && safeHref(viewUrl); return href ? `<a class="reference-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open in Conga Platform">${escapeHtml(text)} <span aria-hidden="true">↗</span></a>` : escapeHtml(text); }
function disconnect() {
  if (state.connection) { state.connection.bearerToken = ''; state.connection.platformUrl = ''; }
  state.connection = null; state.selectedObject = null; state.selectedField = null; state.objectResults = []; state.fieldResults = [];
  $('#bearer-token').value = ''; $('#object-search').value = ''; $('#field-search').value = ''; $('#object-search').disabled = true; $('#field-search').disabled = true; $('#run-scan').disabled = true;
  closeOptions('object'); closeOptions('field'); $('#tenant-chip').classList.add('hidden'); $('#disconnect').classList.add('hidden'); $('#field-identity').classList.add('hidden'); $('#usage-results').classList.add('hidden'); $('#side-session').textContent = 'Not connected'; $('#tenant-name').textContent = ''; $('#tenant-url').textContent = '';
  $('#object-search-status').textContent = ''; $('#field-search-status').textContent = ''; $('#connect-dialog').classList.remove('hidden');
}
function toggleTokenVisibility() { const input = $('#bearer-token'); const showing = input.type === 'text'; input.type = showing ? 'password' : 'text'; $('#toggle-token').textContent = showing ? 'Show' : 'Hide'; }

const debouncedObjectSearch = debounce((value) => searchObjects(value));
const debouncedFieldSearch = debounce((value) => searchFields(value));
$('#object-search').addEventListener('input', (event) => { state.selectedObject = null; state.selectedField = null; $('#field-search').disabled = true; $('#run-scan').disabled = true; debouncedObjectSearch(event.target.value); });
$('#object-search').addEventListener('focus', () => { if (state.connection) searchObjects(state.selectedObject ? '' : $('#object-search').value); });
$('#field-search').addEventListener('input', (event) => { state.selectedField = null; $('#run-scan').disabled = true; debouncedFieldSearch(event.target.value); });
$('#field-search').addEventListener('focus', () => { if (state.selectedObject) searchFields(state.selectedField ? '' : $('#field-search').value); });
$('#object-options').addEventListener('mousedown', (event) => { const button = event.target.closest('button[data-index]'); if (button) { event.preventDefault(); selectObject(state.objectResults[Number(button.dataset.index)]); } });
$('#field-options').addEventListener('mousedown', (event) => { const button = event.target.closest('button[data-index]'); if (button) { event.preventDefault(); selectField(state.fieldResults[Number(button.dataset.index)]); } });
document.addEventListener('mousedown', (event) => { if (!$('#object-combo').contains(event.target)) closeOptions('object'); if (!$('#field-combo').contains(event.target)) closeOptions('field'); });
$('#connect').addEventListener('click', connect);
$('#feedback').addEventListener('click', () => { $('#feedback-dialog').classList.remove('hidden'); $('#feedback-close').focus(); });
$('#feedback-close').addEventListener('click', () => $('#feedback-dialog').classList.add('hidden'));
$('#feedback-dialog').addEventListener('click', (event) => { if (event.target.id === 'feedback-dialog') $('#feedback-dialog').classList.add('hidden'); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('#feedback-dialog').classList.add('hidden'); }); $('#disconnect').addEventListener('click', disconnect); $('#run-scan').addEventListener('click', runUsageScan); $('#toggle-token').addEventListener('click', toggleTokenVisibility);
window.addEventListener('pagehide', () => { if (state.connection) state.connection.bearerToken = ''; });
initialize();
