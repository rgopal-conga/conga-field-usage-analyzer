const state = {
  config: null, connection: null,
  selectedObject: null, selectedField: null,
  objectResults: [], fieldResults: [],
  objectSearchSequence: 0, fieldSearchSequence: 0
};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
const debounce = (fn, wait = 250) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; };

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'omit', headers: { 'Content-Type': 'application/json', ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}
function showError(error) { $('#error span').textContent = error.message ?? String(error); $('#error').classList.remove('hidden'); }
function clearError() { $('#error').classList.add('hidden'); }
function option(value, text) { return `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`; }
function connectionPayload(extra = {}) {
  if (!state.connection) throw new Error('Connect to Conga Platform first');
  return { platformUrl: state.connection.platformUrl, bearerToken: state.connection.bearerToken, userId: state.connection.userId, ...extra };
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
    state.config = await request('/api/config');
    const urls = state.config.urlPolicy.suggestedUrls;
    $('#platform-url-options').innerHTML = urls.map((url) => option(url, url)).join('');
    $('#platform-url').value = urls[0] ?? '';
    $('#connect-dialog').classList.remove('hidden');
  } catch (error) { showError(error); }
}
async function connect() {
  const button = $('#connect');
  const pending = { platformUrl: $('#platform-url').value.trim(), bearerToken: $('#bearer-token').value, userId: $('#user-id').value.trim() };
  try {
    clearError(); button.disabled = true; button.innerHTML = '<span class="spin">◌</span> Validating';
    const validation = await request('/api/platform/validate', { method: 'POST', body: JSON.stringify(pending) });
    state.connection = { ...pending, platformUrl: validation.platformUrl };
    $('#bearer-token').value = ''; $('#user-id').value = ''; $('#connect-dialog').classList.add('hidden');
    activateConnection(); await searchObjects('');
  } catch (error) { pending.bearerToken = ''; state.connection = null; showError(error); }
  finally { button.disabled = false; button.innerHTML = '✓ Validate and load metadata'; }
}
function activateConnection() {
  const host = new URL(state.connection.platformUrl).hostname;
  $('#object-search').disabled = false; $('#object-search').value = ''; $('#field-search').value = ''; $('#field-search').disabled = true;
  $('#platform-value').textContent = host; $('#storage-value').textContent = 'None';
  $('#tenant-name').textContent = host; $('#tenant-environment').textContent = state.connection.userId ? 'Bearer · user context' : 'Bearer token';
  $('#side-session').textContent = `${host} · connected`; $('#tenant-chip').classList.remove('hidden'); $('#disconnect').classList.remove('hidden');
  $('#metadata-caption').textContent = 'Search spans all accessible metadata pages; only matching rows are returned.'; setMetadataStatus('success', '✓ Connected');
}
async function searchObjects(query) {
  if (!state.connection) return;
  const sequence = ++state.objectSearchSequence;
  $('#object-search-status').textContent = 'Searching all object pages…';
  $('#object-options').innerHTML = '<div class="combo-message"><span class="spin">◌</span> Searching tenant…</div>'; openOptions('object');
  try {
    const result = await platformRequest('/api/platform/objects/search', { query, limit: 50 });
    if (sequence !== state.objectSearchSequence) return;
    state.objectResults = result.items; $('#object-count').textContent = result.totalScanned.toLocaleString();
    $('#object-search-status').textContent = `${result.totalMatches.toLocaleString()} match${result.totalMatches === 1 ? '' : 'es'} across ${result.totalScanned.toLocaleString()} objects`;
    $('#object-options').innerHTML = result.items.length ? result.items.map((item, index) => `<button type="button" role="option" data-index="${index}"><strong>${escapeHtml(formatObject(item))}</strong>${item.category ? `<small>${escapeHtml(item.category)}</small>` : ''}</button>`).join('') : '<div class="combo-message">No matching objects</div>';
  } catch (error) { if (sequence === state.objectSearchSequence) { showError(error); $('#object-options').innerHTML = '<div class="combo-message error-text">Object search failed</div>'; } }
}
function selectObject(item) {
  state.selectedObject = item; state.selectedField = null; state.fieldResults = [];
  $('#object-search').value = formatObject(item); closeOptions('object');
  $('#field-search').disabled = false; $('#field-search').value = ''; $('#field-search').placeholder = 'Search field label, API name, or data type';
  $('#run-scan').disabled = true; $('#field-identity').classList.add('hidden'); $('#field-details').classList.add('hidden'); $('#usage-results').classList.add('hidden');
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
    state.fieldResults = result.items; $('#field-count').textContent = result.totalScanned.toLocaleString();
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
  $('#field-identity').classList.remove('hidden'); $('#field-title').textContent = field.label; $('#field-description').textContent = field.description || 'Live schema definition returned by Conga Platform.';
  $('#detail-name').textContent = field.name; $('#detail-type').textContent = field.type; $('#detail-access').textContent = `${field.readAccess === false ? 'No read' : 'Read'} / ${field.writeAccess === false ? 'No write' : 'Write'}`; $('#detail-lookup').textContent = field.lookupObjectName || '—';
  const hasFormula = Boolean(field.expression || field.expressionDependencies?.length); $('#formula-panel').classList.toggle('hidden', !hasFormula); $('#formula-text').textContent = field.expression || 'Expression dependency metadata'; $('#formula-dependencies').textContent = field.expressionDependencies?.length ? `Dependencies: ${field.expressionDependencies.join(', ')}` : '';
  $('#field-details').classList.remove('hidden');
}
async function runUsageScan() {
  if (!state.selectedObject || !state.selectedField) return;
  const button = $('#run-scan');
  try {
    clearError(); button.disabled = true; button.innerHTML = '<span class="spin">◌</span> Scanning';
    $('#usage-results').classList.remove('hidden'); $('#usage-status').className = 'pill running'; $('#usage-status').textContent = '◌ Scanning';
    const result = await platformRequest('/api/platform/usage-scan', { objectName: state.selectedObject.name, fieldName: state.selectedField.name });
    renderUsage(result); $('#usage-status').className = 'pill success'; $('#usage-status').textContent = '✓ Complete';
  } catch (error) { $('#usage-status').className = 'pill failed'; $('#usage-status').textContent = '⚠ Failed'; showError(error); }
  finally { button.disabled = false; button.innerHTML = 'Find usage'; }
}
function renderUsage(result) {
  const total = result.formulaDependencies.length + result.serviceHooks.length;
  $('#usage-total').textContent = total; $('#usage-summary').textContent = `${result.field.label} - ${result.field.fieldName} - ${result.field.dataType}`;
  $('#formula-count').textContent = result.formulaDependencies.length; $('#hook-count').textContent = result.serviceHooks.length;
  $('#coverage-grid').innerHTML = result.coverage.collectors.map((item) => `<div class="collector complete"><div class="collector-status">✓</div><div><strong>${escapeHtml(item.label)}</strong><small>${item.matches} match${item.matches === 1 ? '' : 'es'}</small></div></div>`).join('') + `<div class="collector complete"><div class="collector-status">✓</div><div><strong>Tenant coverage</strong><small>${result.coverage.fieldsScanned} fields · ${result.coverage.serviceHooksScanned} hooks</small></div></div>`;
  $('#scan-limitations').innerHTML = result.limitations.map((text) => `<div class="warning-note">⚠ <span>${escapeHtml(text)}</span></div>`).join('');
  $('#formula-results').innerHTML = result.formulaDependencies.length ? result.formulaDependencies.map((item) => `<article class="reference-card"><div class="reference-icon">ƒ</div><div class="reference-body"><div class="reference-topline"><div><span class="reference-type">${item.direction === 'depends-on' ? 'SELECTED FORMULA DEPENDS ON' : 'USED BY FORMULA'}</span><h3>${referenceTitle(item.fieldLabel || item.fieldName, item.viewUrl)} <code>${escapeHtml(item.objectName)}.${escapeHtml(item.fieldName)}</code></h3></div><div class="tags"><span class="confidence exact">Exact</span></div></div><p>${escapeHtml(item.expression || 'Dependency reported by Platform metadata')}</p><div class="reference-meta"><span>${escapeHtml(item.dataType || '')}</span><span>${escapeHtml(item.source)}</span>${referenceIdMeta(item)}${item.dependencies?.length ? `<span>${escapeHtml(item.dependencies.join(', '))}</span>` : ''}</div></div></article>`).join('') : emptyResult('No formula dependencies found');
  $('#hook-results').innerHTML = result.serviceHooks.length ? result.serviceHooks.map((item) => `<article class="reference-card"><div class="reference-icon">⚡</div><div class="reference-body"><div class="reference-topline"><div><span class="reference-type">SERVICE HOOK · CONDITION</span><h3>${referenceTitle(item.name, item.viewUrl)}</h3></div><div class="tags"><span class="confidence exact">Exact</span><span class="state ${item.active ? 'active' : ''}">${item.active ? 'Active' : 'Inactive'}</span></div></div><p><code>${escapeHtml(item.condition)}</code></p><div class="reference-meta"><span>${escapeHtml(item.eventTypes.join(', ') || item.ruleType)}</span>${referenceIdMeta(item)}${item.projectName ? `<span>${escapeHtml(item.projectName)}${item.className ? ` / ${escapeHtml(item.className)}` : ''}${item.methodName ? ` / ${escapeHtml(item.methodName)}` : ''}</span>` : ''}</div></div></article>`).join('') : emptyResult('No Service Hook condition references found');
}
function safeHref(value) { try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null; } catch { return null; } }
function referenceTitle(text, viewUrl) { const href = viewUrl && safeHref(viewUrl); return href ? `<a class="reference-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open in Conga Platform">${escapeHtml(text)} <span aria-hidden="true">↗</span></a>` : escapeHtml(text); }
function referenceIdMeta(item) { return item.recordId ? `<span>ID <code>${escapeHtml(item.recordId)}</code></span>` : ''; }
function emptyResult(text) { return `<div class="empty"><b>⌕</b><strong>${escapeHtml(text)}</strong><span>The collector completed successfully.</span></div>`; }
function setMetadataStatus(kind, text) { $('#metadata-status').className = `pill ${kind}`; $('#metadata-status').textContent = text; }
function disconnect() {
  if (state.connection) { state.connection.bearerToken = ''; state.connection.userId = ''; state.connection.platformUrl = ''; }
  state.connection = null; state.selectedObject = null; state.selectedField = null; state.objectResults = []; state.fieldResults = [];
  $('#bearer-token').value = ''; $('#user-id').value = ''; $('#object-search').value = ''; $('#field-search').value = ''; $('#object-search').disabled = true; $('#field-search').disabled = true; $('#run-scan').disabled = true;
  closeOptions('object'); closeOptions('field'); $('#tenant-chip').classList.add('hidden'); $('#disconnect').classList.add('hidden'); $('#field-identity').classList.add('hidden'); $('#field-details').classList.add('hidden'); $('#usage-results').classList.add('hidden'); $('#side-session').textContent = 'Not connected';
  $('#object-count').textContent = '—'; $('#field-count').textContent = '—'; $('#platform-value').textContent = '—'; $('#storage-value').textContent = 'None'; $('#metadata-caption').textContent = 'Connect to load live Conga Platform schema metadata.'; $('#object-search-status').textContent = ''; $('#field-search-status').textContent = ''; setMetadataStatus('neutral', '● Disconnected'); $('#connect-dialog').classList.remove('hidden');
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
$('#connect').addEventListener('click', connect); $('#disconnect').addEventListener('click', disconnect); $('#run-scan').addEventListener('click', runUsageScan); $('#toggle-token').addEventListener('click', toggleTokenVisibility);
window.addEventListener('pagehide', () => { if (state.connection) state.connection.bearerToken = ''; });
initialize();
