// Builds "view in Conga" links for usage-scan results from admin-configured URL templates.
// Placeholders: {platformUrl} {id} {objectName} {fieldName} {name}. Values are URL-encoded,
// except {platformUrl}, which is the already-validated tenant origin.
const placeholder = /\{(platformUrl|id|objectName|fieldName|name)\}/g;

// Browser-safe: falls back to an empty environment when `process` does not exist (Chrome extension).
export function referenceLinkTemplates(env = globalThis.process?.env ?? {}) {
  env = env ?? globalThis.process?.env ?? {};
  const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    field: clean(env.CONGA_FIELD_URL_TEMPLATE),
    workflow: clean(env.CONGA_WORKFLOW_URL_TEMPLATE) ?? '{platformUrl}/workflow/{id}/',
    fieldExpression: clean(env.CONGA_FIELD_EXPRESSION_URL_TEMPLATE) ?? '{platformUrl}/cadmin/field-expression/{id}',
    constraintRule: clean(env.CONGA_CONSTRAINT_RULE_URL_TEMPLATE) ?? '{platformUrl}/cadmin/constraint-rule/{id}',
    customCode: clean(env.CONGA_CUSTOM_CODE_URL_TEMPLATE)
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
