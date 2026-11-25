// Finds references to a product attribute inside CPQ Attribute-Based Constraint Rules (attribute scans only).
//
//   list:    POST /api/search/v1/objects/AttributeConstraintRule/query?includeTotalCount=true   { Success, Data: [{ Id, Name, RuleType, IsActive }] }
//   entries: GET  /api/revenue-admin/v1/attribute-constraint-rules/{id}/entries               bare array
//
// Observed entry shape (preview-rls09):
//   ConditionAttributes  [{ Name: 'Internet_Speed_c', Operator: 'equal to', Type: 'Discrete', Value: '10 Mbps' }]
// Only ConditionAttributes[].Name is matched. Values, the action side, names and audit fields are never matches.
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
// Field mode: attribute names never match a schema field; only an explicit <Object>.<Field> would.
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
    if (!conditionMatches.length) return null;
    const active = pick(rule, 'IsActive', 'isActive');
    return {
      id: `attribute-constraint-rule:${id}`,
      recordId: id,
      ruleName: name,
      ruleType: pick(rule, 'RuleType', 'ruleType', 'Type', 'type') ?? null,
      active: active === undefined || active === null ? null : Boolean(active),
      usage: 'Condition',
      confidence: conditionMatches.some((item) => item.confidence === 'Exact') ? 'Exact' : 'Probable',
      conditions: conditionMatches
    };
  });
  const results = perRule.filter(Boolean).sort((left, right) => (rank[right.confidence] - rank[left.confidence]) || left.ruleName.localeCompare(right.ruleName));
  return { results, attributeConstraintRulesScanned: rules.length, failures };
}
