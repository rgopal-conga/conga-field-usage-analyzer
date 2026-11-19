// Finds references to a product attribute (or a field) inside CPQ Attribute-Based Constraint Rules.
//
//   list:    POST /api/search/v1/objects/AttributeConstraintRule/query?includeTotalCount=true   { Success, Data: [{ Id, Name, RuleType, IsActive }] }
//   entries: GET  /api/revenue-admin/v1/attribute-constraint-rules/{id}/entries               bare array
//
// Observed entry shape (preview-rls09):
//   ConditionAttributes  [{ Name: 'Internet_Speed_c', Operator: 'equal to', Type: 'Discrete', Value: '10 Mbps' }]
//   ActionProduct        { Id, Name }   ActionIntent 'Auto Include'   TargetFields null   Sequence 1
// The condition side of an entry is its ConditionAttributes; the action side is its TargetFields.
// TargetFields was null in every sample, so its format is read defensively (array, JSON string or delimited list).
// Values, product names, entry/rule names and audit fields are never matches.
// Browser-safe: runs in the standalone server and in the Chrome extension.

import { attributeNameVariants } from './workflowScanner.js';

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

const lower = (value) => String(value ?? '').toLowerCase();
const normalizeObject = (value) => lower(value).replace(/[^a-z0-9]/g, '');
const rank = { Exact: 2, Probable: 1 };
const attributePrefixes = ['attribute', 'attributevalue'];

// Attribute mode: the attribute name, bare or as Attribute./AttributeValue.<name>, is Exact (__c and _c are the same).
// Field mode: only an explicit <Object>.<Field> on the selected object is Exact; attribute names never match a field.
export function classifyAttributeRuleName(value, objectName, fieldName, { attribute = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const segments = value.trim().split('.');
  const last = lower(segments.at(-1));
  const prefix = segments.length > 1 ? lower(segments.slice(0, -1).join('.')) : null;
  if (attribute) {
    if (!attributeNameVariants(fieldName).map(lower).includes(last)) return null;
    return !prefix || attributePrefixes.includes(prefix) ? 'Exact' : null;
  }
  return prefix && last === lower(fieldName) && normalizeObject(prefix) === normalizeObject(objectName) ? 'Exact' : null;
}

// Field names listed in TargetFields: an array of strings or { Name | FieldName | AttributeName } objects,
// a JSON string of either, or a comma/semicolon separated list.
function targetFieldNames(value, depth = 0) {
  if (value === null || value === undefined || depth > 6) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (/^[[{]/.test(text)) { try { return targetFieldNames(JSON.parse(text), depth + 1); } catch { /* fall through to a list */ } }
    return text.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap((item) => targetFieldNames(item, depth + 1));
  if (typeof value === 'object') {
    const own = pick(value, 'Name', 'name', 'FieldName', 'fieldName', 'AttributeName', 'attributeName', 'Field', 'field');
    return [
      ...(typeof own === 'string' && own.trim() ? [own.trim()] : []),
      ...Object.entries(value).filter(([, nested]) => nested && typeof nested === 'object').flatMap(([, nested]) => targetFieldNames(nested, depth + 1))
    ];
  }
  return [];
}

function best(list) {
  return list.reduce((top, item) => (!top || rank[item.confidence] > rank[top.confidence] ? item : top), null);
}

export function findFieldInAttributeRuleCondition(entry, objectName, fieldName, options = {}) {
  const conditions = pick(entry, 'ConditionAttributes', 'conditionAttributes');
  const hits = (Array.isArray(conditions) ? conditions : []).map((condition) => {
    const name = pick(condition, 'Name', 'name');
    const confidence = classifyAttributeRuleName(name, objectName, fieldName, options);
    if (!confidence) return null;
    const operator = pick(condition, 'Operator', 'operator');
    const value = pick(condition, 'Value', 'value');
    return { confidence, snippet: [name, operator, value === null || value === undefined ? null : String(value)].filter((part) => part !== null && part !== undefined && part !== '').join(' ') };
  }).filter(Boolean);
  const top = best(hits);
  return top ? { name: pick(entry, 'Name', 'name') ?? 'Entry', confidence: top.confidence, snippet: hits.map((hit) => hit.snippet).join('; ') } : null;
}

export function findFieldInAttributeRuleAction(entry, objectName, fieldName, options = {}) {
  const hits = targetFieldNames(pick(entry, 'TargetFields', 'targetFields'))
    .map((name) => ({ name, confidence: classifyAttributeRuleName(name, objectName, fieldName, options) }))
    .filter((hit) => hit.confidence);
  const top = best(hits);
  if (!top) return null;
  const intent = pick(entry, 'ActionIntent', 'actionIntent');
  const product = pick(pick(entry, 'ActionProduct', 'actionProduct') ?? {}, 'Name', 'name');
  const context = [intent, product].filter(Boolean).join(' ');
  return { name: pick(entry, 'Name', 'name') ?? 'Entry', confidence: top.confidence, snippet: `${context ? `${context} · ` : ''}Target fields: ${hits.map((hit) => hit.name).join(', ')}` };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function scanAttributeConstraintRules(client, objectName, fieldName, { attribute = false } = {}) {
  const rules = await client.listAttributeConstraintRules();
  const failures = [];
  const perRule = await mapWithConcurrency(rules, 5, async (rule) => {
    const id = String(pick(rule, 'Id', 'id') ?? '');
    const name = pick(rule, 'Name', 'name') || id;
    let entries = [];
    try { entries = await client.getAttributeConstraintRuleEntries(id); } catch { failures.push(name); return null; }
    const conditionMatches = entries.map((entry) => findFieldInAttributeRuleCondition(entry, objectName, fieldName, { attribute })).filter(Boolean);
    const actionMatches = entries.map((entry) => findFieldInAttributeRuleAction(entry, objectName, fieldName, { attribute })).filter(Boolean);
    if (!conditionMatches.length && !actionMatches.length) return null;
    const active = pick(rule, 'IsActive', 'isActive');
    const all = [...conditionMatches, ...actionMatches];
    return {
      id: `attribute-constraint-rule:${id}`,
      recordId: id,
      ruleName: name,
      ruleType: pick(rule, 'RuleType', 'ruleType', 'Type', 'type') ?? null,
      active: active === undefined || active === null ? null : Boolean(active),
      usage: [conditionMatches.length ? 'Condition' : null, actionMatches.length ? 'Action' : null].filter(Boolean).join(', '),
      confidence: all.some((item) => item.confidence === 'Exact') ? 'Exact' : 'Probable',
      conditions: conditionMatches,
      actions: actionMatches
    };
  });
  const results = perRule.filter(Boolean).sort((left, right) => (rank[right.confidence] - rank[left.confidence]) || left.ruleName.localeCompare(right.ruleName));
  return { results, attributeConstraintRulesScanned: rules.length, failures };
}
