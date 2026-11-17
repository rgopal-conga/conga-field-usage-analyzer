// Finds references to one field inside CPQ Field Expressions on Conga Platform.
//
//   list:   POST /api/search/v1/objects/FieldExpression/query?includeTotalCount=true
//   detail: GET  /api/revenue-admin/v1/field-expressions/{id}
//
// The detail shape is read generically: every string in the definition is checked, and the
// JSON key it sits under decides how the match is labelled (field update, filter, value).
// Browser-safe: runs in the standalone server and in the Chrome extension.

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenPattern = (value) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(value)}($|[^A-Za-z0-9_])`, 'i');
const normalizeObject = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Record bookkeeping that must never count as a reference (a field called "Name" would
// otherwise match every expression's own name).
const metadataKeys = new Set(['id', 'name', 'displayname', 'description', 'externalid', 'version', 'createddate', 'modifieddate',
  'isactive', 'ismodifiable', 'isdeleted', 'ownerid', 'organizationid', 'tenantid', 'createdbyid', 'modifiedbyid']);
const metadataSubtrees = /^(createdby|modifiedby|owner|organization|tenant|audit|systemfields)/i;
const updateFieldKeys = new Set(['updatefield', 'updatefieldname', 'targetfield', 'targetfieldname']);
const objectKeys = new Set(['updateobject', 'updateobjectname', 'sourceobject', 'sourceobjectname', 'targetobject', 'targetobjectname', 'objectname']);

function usageFor(path) {
  const keys = path.map((key) => String(key).toLowerCase());
  const last = keys.at(-1) ?? '';
  if (updateFieldKeys.has(last)) return 'Field update';
  if (keys.some((key) => key.includes('filter') || key.includes('criteria') || key.includes('condition'))) return 'Filter expression';
  if (keys.some((key) => key.includes('value'))) return 'Value expression';
  return 'Expression';
}

function snippetAround(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return text.slice(0, 200);
  const start = Math.max(0, match.index - 80);
  const end = Math.min(text.length, match.index + match[0].length + 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// Yields [path, value] for every string in the definition, skipping record metadata.
function* strings(value, path = [], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') { yield [path, value]; return; }
  if (Array.isArray(value)) { for (let index = 0; index < value.length; index += 1) yield* strings(value[index], path, depth + 1); return; }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (depth === 0 && metadataKeys.has(lower)) continue;
    if (metadataSubtrees.test(key)) continue;
    yield* strings(nested, [...path, key], depth + 1);
  }
}

// Objects the expression works on (update object / source object), used as context for
// bare field names. "Line Item" and "LineItem" are treated as the same object.
function expressionObjects(definition) {
  const found = new Set();
  for (const [path, text] of strings(definition)) {
    const key = String(path.at(-1) ?? '').toLowerCase();
    if (objectKeys.has(key) && text.trim()) found.add(normalizeObject(text));
    if (updateFieldKeys.has(key) && text.includes('.')) found.add(normalizeObject(text.split('.')[0]));
  }
  return found;
}

function objectInContext(objects, objectName) {
  const selected = normalizeObject(objectName);
  for (const candidate of objects) {
    if (!candidate) continue;
    if (candidate === selected || selected.startsWith(candidate) || candidate.startsWith(selected)) return true;
  }
  return false;
}

export function findFieldInFieldExpression(definition, objectName, fieldName) {
  const qualified = tokenPattern(`${objectName}.${fieldName}`);
  const bare = tokenPattern(fieldName);
  const sameObject = objectInContext(expressionObjects(definition), objectName);
  const matches = [];
  const seen = new Set();
  for (const [path, text] of strings(definition)) {
    if (!text) continue;
    const key = String(path.at(-1) ?? '').toLowerCase();
    if (objectKeys.has(key)) continue;
    let confidence = null;
    if (updateFieldKeys.has(key)) {
      const [maybeObject, maybeField] = text.includes('.') ? text.split('.', 2) : [null, text];
      if (maybeField.trim().toLowerCase() !== fieldName.toLowerCase()) continue;
      if (maybeObject) confidence = normalizeObject(maybeObject) === normalizeObject(objectName) ? 'Exact' : null;
      else confidence = sameObject ? 'Exact' : null;
    } else if (qualified.test(text)) confidence = 'Exact';
    else if (sameObject && bare.test(text)) confidence = 'Probable';
    if (!confidence) continue;
    const usage = usageFor(path);
    const property = path.join('.');
    const dedupe = `${usage}|${property}|${text}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    matches.push({ property, usage, confidence, snippet: snippetAround(text, qualified.test(text) ? qualified : bare) });
  }
  return matches;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function scanFieldExpressions(client, objectName, fieldName) {
  const summaries = await client.listFieldExpressions();
  const failures = [];
  const perExpression = await mapWithConcurrency(summaries, 5, async (summary) => {
    const expressionId = String(pick(summary, 'Id', 'id') ?? '');
    const summaryName = pick(summary, 'Name', 'name') || expressionId;
    try {
      const definition = await client.getFieldExpression(expressionId);
      const found = findFieldInFieldExpression(definition, objectName, fieldName);
      // The list row's UpdateField counts too, in case the detail spells it differently.
      const listUpdateField = pick(summary, 'UpdateField', 'updateField');
      if (typeof listUpdateField === 'string' && !found.some((match) => match.usage === 'Field update')) {
        const fromList = findFieldInFieldExpression({ ...definition, UpdateField: listUpdateField }, objectName, fieldName).filter((match) => match.usage === 'Field update');
        found.unshift(...fromList);
      }
      const active = pick(definition, 'IsActive', 'isActive') ?? pick(summary, 'IsActive', 'isActive');
      return found.map((match) => ({
        id: `field-expression:${expressionId}:${match.property}:${match.usage}`,
        recordId: expressionId,
        expressionName: pick(definition, 'Name', 'name') || summaryName,
        active: active === undefined ? null : Boolean(active),
        updateField: pick(definition, 'UpdateField', 'updateField') ?? listUpdateField ?? null,
        modifiedDate: pick(definition, 'ModifiedDate', 'modifiedDate') ?? pick(summary, 'ModifiedDate', 'modifiedDate') ?? null,
        ...match
      }));
    } catch (error) {
      failures.push(summaryName);
      return [];
    }
  });
  return { results: perExpression.flat(), fieldExpressionsScanned: summaries.length, failures };
}
