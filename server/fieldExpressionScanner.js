// Finds references to one field inside CPQ Field Expressions on Conga Platform.
//
//   list:   POST /api/search/v1/objects/FieldExpression/query?includeTotalCount=true  (Id and Name only)
//   detail: GET  /api/revenue-admin/v1/field-expressions/{id}
//
// Detail shape (observed on a live tenant):
//   { Id, Name, IsActive, ModifiedDate, ExpressionType: 'Field Update', EvaluationContext: 'Record Update',
//     UpdateObject: 'LineItem', UpdateField: 'Attribute.Internet_Speed_c', SourceObject: 'LineItem',
//     ConditionExpression: '$.Quantity > 0', ConditionScope: 'Product', Expression: "'25 Mbps'",
//     GroupByField, ParentField, Operation, Product: { Id, Name }, ProductGroup, CreatedBy, ModifiedBy, ETag, ... }
//
// Only the reference-bearing properties are checked; everything else is shown as context.
//   UpdateField                  path from UpdateObject   ("Quantity", "AttributeValue.Battery_Capacity_c")
//   ConditionExpression, Expression   expressions; `$.Path` is a path from SourceObject
//   GroupByField, ParentField    paths from SourceObject
// Relationship segments are followed through lookup fields in the tenant schemas.
//
// Product attributes are not schema fields: they are Attribute records, referenced as `Attribute.<Name>` or
// `AttributeValue.<Name>` (the same thing). `__c` and `_c` name endings are treated as the same.
// In an attribute scan those paths are Exact; in a field scan they are never matches (unless a real lookup
// with that name resolves to the selected object).
// Browser-safe: runs in the standalone server and in the Chrome extension.

import { followLookup } from './formulaScanner.js';

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

const lower = (value) => String(value ?? '').toLowerCase();
const normalizeObject = (value) => lower(value).replace(/[^a-z0-9]/g, '');
const sameObject = (left, right) => Boolean(left) && Boolean(right) && normalizeObject(left) === normalizeObject(right);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const expressionPath = /(\$\.)?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
const rank = { Exact: 2, Probable: 1 };
const attributePrefixes = new Set(['attribute', 'attributevalue']);
export const normalizeAttributeName = (value) => lower(value).replace(/__c$/, '_c');

const pathProperties = [
  { key: 'UpdateField', usage: 'Field update', owner: 'update' },
  { key: 'GroupByField', usage: 'Group by field', owner: 'source' },
  { key: 'ParentField', usage: 'Parent field', owner: 'source' }
];
const expressionProperties = [
  { key: 'ConditionExpression', usage: 'Condition' },
  { key: 'Expression', usage: 'Value expression' }
];

// Classifies one dotted path, read from `owner`, as a reference to objectName.fieldName.
// Returns { confidence, note } or null.
export function classifyPath(schemas, owner, segments, objectName, fieldName) {
  if (!segments.length || lower(segments.at(-1)) !== lower(fieldName)) return null;
  let hops = segments.slice(0, -1);
  if (hops.length && owner && sameObject(hops[0], owner)) hops = hops.slice(1);
  if (!hops.length) return owner && sameObject(owner, objectName) ? { confidence: 'Exact' } : null;
  if (hops.length === 1 && sameObject(hops[0], objectName)) return { confidence: 'Exact' };
  let current = owner;
  for (const hop of hops) {
    const next = schemas && current ? followLookup(schemas, current, hop) : null;
    if (!next && attributePrefixes.has(lower(hops[0]))) return null; // a product attribute, not this field
    if (!next) return { confidence: 'Probable', note: `relationship ${hops.join('.')} could not be resolved from ${owner || 'the expression object'}` };
    current = next;
  }
  return sameObject(current, objectName) ? { confidence: 'Exact', note: `${hops.join('.')} → ${current}` } : null;
}

// Classifies one dotted path as a reference to the product attribute `attributeName`.
export function classifyAttributePath(owner, segments, attributeName) {
  if (!segments.length || normalizeAttributeName(segments.at(-1)) !== normalizeAttributeName(attributeName)) return null;
  let hops = segments.slice(0, -1);
  if (hops.length && owner && sameObject(hops[0], owner)) hops = hops.slice(1);
  if (hops.length === 1 && attributePrefixes.has(lower(hops[0]))) return { confidence: 'Exact' };
  if (!hops.length) return { confidence: 'Probable', note: 'attribute name without Attribute. prefix' };
  return null;
}

function stripLiterals(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (match) => ' '.repeat(match.length));
}

// attribute: true scans for the product attribute `fieldName` (objectName is ignored).
export function findFieldInFieldExpression(definition, objectName, fieldName, { schemas = null, fieldLabel = null, attribute = false } = {}) {
  const updateObject = pick(definition, 'UpdateObject', 'updateObject') || pick(definition, 'SourceObject', 'sourceObject') || null;
  const sourceObject = pick(definition, 'SourceObject', 'sourceObject') || updateObject;
  const matches = [];

  for (const { key, usage, owner } of pathProperties) {
    const value = pick(definition, key, key[0].toLowerCase() + key.slice(1));
    if (typeof value !== 'string' || !value.trim()) continue;
    const text = value.trim();
    const segments = text.split('.').map((part) => part.trim());
    let found = null;
    if (segments.every((part) => identifier.test(part))) {
      const from = owner === 'update' ? updateObject : sourceObject;
      found = attribute ? classifyAttributePath(from, segments, fieldName) : classifyPath(schemas, from, segments, objectName, fieldName);
    }
    if (!found && fieldLabel && lower(text) === lower(fieldLabel)) {
      // e.g. UpdateField "Currency Attribute": a display name rather than an API name.
      found = { confidence: 'Probable', note: attribute ? 'matched by attribute display name' : 'matched by field label' };
    }
    if (found) matches.push({ property: key, usage, snippet: text, ...found });
  }

  for (const { key, usage } of expressionProperties) {
    const value = pick(definition, key, key[0].toLowerCase() + key.slice(1));
    if (typeof value !== 'string' || !value.trim()) continue;
    let best = null;
    for (const match of stripLiterals(value).matchAll(expressionPath)) {
      const anchored = Boolean(match[1]);
      const segments = match[0].replace(/^\$\./, '').split('.');
      let found = attribute ? classifyAttributePath(sourceObject, segments, fieldName) : classifyPath(schemas, sourceObject, segments, objectName, fieldName);
      // A path without `$.` is not tied to the record for certain, unless it names the selected object.
      if (found && !attribute && !anchored && found.confidence === 'Exact' && !(segments.length === 2 && sameObject(segments[0], objectName))) {
        found = { ...found, confidence: 'Probable' };
      }
      if (found && (!best || rank[found.confidence] > rank[best.confidence])) best = found;
    }
    if (best) matches.push({ property: key, usage, snippet: value.trim(), ...best });
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

const relatedName = (value) => (value && typeof value === 'object' ? pick(value, 'Name', 'name') : value) || null;

// `schemas` (optional) is a promise or Map of lower(objectName) -> fields, used to follow relationship paths.
// attribute (optional) = { name, label }: scan for that product attribute instead of objectName.fieldName.
export async function scanFieldExpressions(client, objectName, fieldName, { schemas = null, attribute = null } = {}) {
  const summaries = await client.listFieldExpressions();
  const failures = [];
  const definitions = await mapWithConcurrency(summaries, 5, async (summary) => {
    const id = String(pick(summary, 'Id', 'id') ?? '');
    try { return { summary, definition: await client.getFieldExpression(id) }; }
    catch { failures.push(pick(summary, 'Name', 'name') || id); return null; }
  });
  const schemaMap = await Promise.resolve(schemas).catch(() => null);
  const fieldLabel = attribute ? attribute.label ?? null : schemaMap?.get(lower(objectName))?.find((field) => lower(field.name) === lower(fieldName))?.label ?? null;

  const results = [];
  for (const entry of definitions) {
    if (!entry) continue;
    const { summary, definition } = entry;
    const matches = findFieldInFieldExpression(definition, objectName, fieldName, { schemas: schemaMap, fieldLabel, attribute: Boolean(attribute) });
    if (!matches.length) continue;
    const recordId = String(pick(definition, 'Id', 'id') ?? pick(summary, 'Id', 'id'));
    const active = pick(definition, 'IsActive', 'isActive');
    results.push({
      id: `field-expression:${recordId}`,
      recordId,
      expressionName: pick(definition, 'Name', 'name') || pick(summary, 'Name', 'name') || recordId,
      active: active === undefined ? null : Boolean(active),
      usage: matches.map((match) => match.usage).join(', '),
      confidence: matches.some((match) => match.confidence === 'Exact') ? 'Exact' : 'Probable',
      matches,
      expressionType: pick(definition, 'ExpressionType', 'expressionType') ?? null,
      evaluationContext: pick(definition, 'EvaluationContext', 'evaluationContext') ?? null,
      updateObject: pick(definition, 'UpdateObject', 'updateObject') ?? null,
      updateField: pick(definition, 'UpdateField', 'updateField') ?? null,
      sourceObject: pick(definition, 'SourceObject', 'sourceObject') ?? null,
      conditionScope: pick(definition, 'ConditionScope', 'conditionScope') ?? null,
      conditionExpression: pick(definition, 'ConditionExpression', 'conditionExpression') ?? null,
      expression: pick(definition, 'Expression', 'expression') ?? null,
      product: relatedName(pick(definition, 'Product', 'product')),
      productGroup: relatedName(pick(definition, 'ProductGroup', 'productGroup')),
      modifiedDate: pick(definition, 'ModifiedDate', 'modifiedDate') ?? null
    });
  }
  results.sort((left, right) => (rank[right.confidence] - rank[left.confidence]) || left.expressionName.localeCompare(right.expressionName));
  return { results, fieldExpressionsScanned: summaries.length, failures };
}
