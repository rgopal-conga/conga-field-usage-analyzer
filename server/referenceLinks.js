// Builds "view in Conga" links for usage-scan results from admin-configured URL templates.
// Placeholders: {platformUrl} {id} {objectName} {fieldName} {name}. Values are URL-encoded,
// except {platformUrl}, which is the already-validated tenant origin.
const placeholder = /\{(platformUrl|id|objectName|fieldName|name)\}/g;

export function referenceLinkTemplates(env = process.env) {
  const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    serviceHook: clean(env.CONGA_SERVICE_HOOK_URL_TEMPLATE),
    field: clean(env.CONGA_FIELD_URL_TEMPLATE),
    workflow: clean(env.CONGA_WORKFLOW_URL_TEMPLATE) ?? '{platformUrl}/workflow/{id}/'
  };
}

export function buildReferenceUrl(template, values) {
  if (!template) return null;
  let missing = false;
  const filled = template.replace(placeholder, (_, key) => {
    const value = values[key];
    if (value === undefined || value === null || value === '') { missing = true; return ''; }
    return key === 'platformUrl' ? String(value) : encodeURIComponent(String(value));
  });
  if (missing) return null;
  let url;
  try { url = new URL(filled); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.toString();
}
