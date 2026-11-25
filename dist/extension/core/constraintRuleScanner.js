// Finds references to one field (or product attribute) inside CPQ Constraint Rules.
//
//   list:       POST /api/search/v1/objects/ConstraintRule/query?includeTotalCount=true   { Success, Data: [{ Id, Name, Type, IsActive }] }
//   conditions: GET  /api/revenue-admin/v1/constraint-rules/{id}/conditions?sort=asc(Sequence)   bare array
//   actions:    GET  /api/revenue-admin/v1/constraint-rules/{id}/actions                         bare array
//
// Observed shapes (preview-rls09):
//   condition.ConditionCriteria  JSON string { ObjectName, filter: { predicates: [{ FieldName, FieldLabel, ObjectName,
//                                LookupObjectName, FieldValue, RHSFieldType, ... }], childFilter }, fields, extFields, exprStr }
//   condition.ProductFieldA..D   Product field names (with ProductFieldOperatorX / ProductFieldValueX)
//   action.ActionCriteria        same criteria format as ConditionCriteria (often null)
//   action.ActionExpression      expression text (often null)
// Names, Message, product/group names and audit fields are never matches.
// Browser-safe: runs in the standalone server and in the Chrome extension.

import { attributeNameVariants } from './workflowScanner.js';

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

const lower = (value) => String(value ?? '').toLowerCase();
const normalizeObject = (value) => lower(value).replace(/[^a-z0-9]/g, '');
const sameObject = (left, right) => Boolean(left) && Boolean(right) && normalizeObject(left) === normalizeObject(right);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenPattern = (value) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(value)}($|[^A-Za-z0-9_])`, 'i');
const attributePrefixes = ['attribute', 'attributevalue'];
const rank = { Exact: 2, Probable: 1 };
const isAttributeObject = (name) => /attribute/i.test(String(name ?? ''));

function parseCriteria(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

// Every { FieldName } entry in a criteria tree, with the object it belongs to (its own ObjectName, else the nearest parent's).
function criteriaFields(node, objectName = null, found = [], depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const item of node) criteriaFields(item, objectName, found, depth + 1); return found; }
  const own = pick(node, 'ObjectName', 'objectName');
  const context = typeof own === 'string' && own ? own : objectName;
  const fieldName = pick(node, 'FieldName', 'fieldName');
  if (typeof fieldName === 'string' && fieldName.trim()) {
    found.push({ fieldName: fieldName.trim(), objectName: context, label: pick(node, 'FieldLabel', 'fieldLabel') ?? null, value: pick(node, 'FieldValue', 'fieldValue'), rhs: Boolean(pick(node, 'RHSFieldType', 'rhsFieldType')) });
  }
  for (const [key, nested] of Object.entries(node)) {
    if (nested && typeof nested === 'object' && !/^optionvalues$/i.test(key)) criteriaFields(nested, context, found, depth + 1);
  }
  return found;
}

// Classifies one criteria field entry. Field mode: FieldName on the selected object (or Object.Field) is Exact.
// Attribute mode: the attribute name on an attribute object, or Attribute./AttributeValue.<name>, is Exact;
// the bare name on another object is Probable. A right-hand-side field reference in FieldValue is Probable.
function classifyCriteriaField(entry, objectName, fieldName, attribute) {
  const names = attribute ? attributeNameVariants(fieldName).map(lower) : [lower(fieldName)];
  const segments = entry.fieldName.split('.');
  const last = lower(segments.at(-1));
  if (names.includes(last)) {
    const prefix = segments.length > 1 ? segments.slice(0, -1).join('.') : null;
    if (attribute) {
      if (prefix && attributePrefixes.includes(lower(prefix))) return 'Exact';
      if (!prefix && isAttributeObject(entry.objectName)) return 'Exact';
      return prefix ? null : 'Probable';
    }
    if (prefix) return sameObject(prefix, objectName) ? 'Exact' : null;
    return sameObject(entry.objectName, objectName) ? 'Exact' : entry.objectName ? null : 'Probable';
  }
  if (entry.rhs && typeof entry.value === 'string' && names.includes(lower(entry.value.split('.').at(-1)))) return 'Probable';
  return null;
}

function best(list) {
  return list.reduce((top, item) => (!top || rank[item.confidence] > rank[top.confidence] ? item : top), null);
}

function matchCriteria(criteria, objectName, fieldName, attribute) {
  const parsed = parseCriteria(criteria);
  if (!parsed) return null;
  const hits = criteriaFields(parsed)
    .map((entry) => ({ entry, confidence: classifyCriteriaField(entry, objectName, fieldName, attribute) }))
    .filter((item) => item.confidence);
  const top = best(hits);
  if (!top) return null;
  const summary = pick(parsed, 'exprStr', 'ExprStr');
  return { confidence: top.confidence, snippet: typeof summary === 'string' && summary.trim() ? summary.trim() : `${top.entry.objectName ? `${top.entry.objectName}.` : ''}${top.entry.fieldName}` };
}

function matchExpression(text, objectName, fieldName, attribute) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const code = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ');
  const names = attribute ? attributeNameVariants(fieldName) : [fieldName];
  const qualifiers = attribute ? ['Attribute', 'AttributeValue'] : [objectName];
  if (qualifiers.some((qualifier) => names.some((name) => tokenPattern(`${qualifier}.${name}`).test(code)))) return { confidence: 'Exact', snippet: text.trim() };
  // A bare name preceded by another relationship (Other.Field) is not this field.
  if (names.some((name) => new RegExp(`(^|[^A-Za-z0-9_.])(\\$\\.)?${escapeRegex(name)}($|[^A-Za-z0-9_])`, 'i').test(code))) return { confidence: 'Probable', snippet: text.trim() };
  return null;
}

// Product fields A–D on a condition are fields of the Product object.
function matchProductFields(condition, objectName, fieldName, attribute) {
  if (attribute || !sameObject(objectName, 'Product')) return null;
  for (const letter of ['A', 'B', 'C', 'D']) {
    const value = pick(condition, `ProductField${letter}`);
    if (typeof value === 'string' && lower(value.trim()) === lower(fieldName)) {
      const operator = pick(condition, `ProductFieldOperator${letter}`) ?? '';
      const compare = pick(condition, `ProductFieldValue${letter}`);
      return { confidence: 'Exact', snippet: `Product.${value.trim()} ${operator}${compare !== null && compare !== undefined ? ` ${compare}` : ''}`.trim() };
    }
  }
  return null;
}

export function findFieldInConstraintCondition(condition, objectName, fieldName, { attribute = false } = {}) {
  const found = [matchCriteria(pick(condition, 'ConditionCriteria', 'conditionCriteria'), objectName, fieldName, attribute), matchProductFields(condition, objectName, fieldName, attribute)].filter(Boolean);
  const top = best(found);
  return top ? { name: pick(condition, 'Name', 'name') ?? 'Condition', ...top } : null;
}

export function findFieldInConstraintAction(action, objectName, fieldName, { attribute = false } = {}) {
  const found = [matchCriteria(pick(action, 'ActionCriteria', 'actionCriteria'), objectName, fieldName, attribute), matchExpression(pick(action, 'ActionExpression', 'actionExpression'), objectName, fieldName, attribute)].filter(Boolean);
  const top = best(found);
  return top ? { name: pick(action, 'Name', 'name') ?? 'Action', ...top } : null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function scanConstraintRules(client, objectName, fieldName, { attribute = false } = {}) {
  const rules = await client.listConstraintRules();
  const failures = [];
  const perRule = await mapWithConcurrency(rules, 5, async (rule) => {
    const id = String(pick(rule, 'Id', 'id') ?? '');
    const name = pick(rule, 'Name', 'name') || id;
    const [conditions, actions] = await Promise.allSettled([client.getConstraintRuleConditions(id), client.getConstraintRuleActions(id)]);
    if (conditions.status === 'rejected' || actions.status === 'rejected') failures.push(name);
    const conditionMatches = (conditions.status === 'fulfilled' ? conditions.value : []).map((item) => findFieldInConstraintCondition(item, objectName, fieldName, { attribute })).filter(Boolean);
    const actionMatches = (actions.status === 'fulfilled' ? actions.value : []).map((item) => findFieldInConstraintAction(item, objectName, fieldName, { attribute })).filter(Boolean);
    if (!conditionMatches.length && !actionMatches.length) return null;
    const active = pick(rule, 'IsActive', 'isActive');
    const all = [...conditionMatches, ...actionMatches];
    return {
      id: `constraint-rule:${id}`,
      recordId: id,
      ruleName: name,
      ruleType: pick(rule, 'Type', 'type') ?? null,
      active: active === undefined ? null : Boolean(active),
      usage: [conditionMatches.length ? 'Condition' : null, actionMatches.length ? 'Action' : null].filter(Boolean).join(', '),
      confidence: all.some((item) => item.confidence === 'Exact') ? 'Exact' : 'Probable',
      conditions: conditionMatches,
      actions: actionMatches
    };
  });
  const results = perRule.filter(Boolean).sort((left, right) => (rank[right.confidence] - rank[left.confidence]) || left.ruleName.localeCompare(right.ruleName));
  return { results, constraintRulesScanned: rules.length, failures };
}
