// Finds references to one field inside Conga Platform workflow definitions.
// A definition is a list of activities; each activity has properties whose
// expressions are keyed by syntax (Liquid, Literal, Json, JavaScript, ...).

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenPattern = (value) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(value)}($|[^A-Za-z0-9_])`, 'i');
const conditionProperties = new Set(['workflowcondition', 'updatecondition', 'entrycriteria', 'criteria', 'condition']);
const fieldKeyNames = new Set(['key', 'fieldname', 'field', 'name']);

function usageFor(propertyName, structured) {
  const name = propertyName.toLowerCase();
  if (conditionProperties.has(name) || name.endsWith('condition') || name.endsWith('criteria')) return 'Condition';
  if (structured && name.includes('update')) return 'Field update';
  if (structured) return 'Field mapping';
  return 'Expression';
}

function snippetAround(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return text.slice(0, 200);
  const start = Math.max(0, match.index - 80);
  const end = Math.min(text.length, match.index + match[0].length + 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function tryParseJson(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed || !'[{'.includes(trimmed[0])) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

// Object keys in Json expressions such as {"Key":"ApprovalStatus","Value":"Notified"}.
function structuredFieldKeys(value, depth = 0, found = []) {
  if (depth > 8 || value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) { value.forEach((item) => structuredFieldKeys(item, depth + 1, found)); return found; }
  for (const [key, nested] of Object.entries(value)) {
    if (fieldKeyNames.has(key.toLowerCase()) && typeof nested === 'string') found.push(nested);
    else structuredFieldKeys(nested, depth + 1, found);
  }
  return found;
}

function propertyTargetsOtherObject(activity, workflowObject) {
  const properties = pick(activity, 'properties', 'Properties') ?? [];
  const value = (name) => {
    const property = properties.find((item) => String(pick(item, 'name', 'Name') ?? '').toLowerCase() === name);
    const expressions = pick(property, 'expressions', 'Expressions') ?? {};
    return Object.values(expressions).find((text) => typeof text === 'string' && text.trim()) ?? '';
  };
  const updateType = value('updatetype').toLowerCase();
  if (!updateType || updateType.includes('context')) return null;
  const related = value('relatedobjectname') || value('unrelatedobjectname');
  return related && related.toLowerCase() !== workflowObject.toLowerCase() ? related : null;
}

export function findFieldInWorkflow(definition, objectName, fieldName) {
  const workflowObject = String(pick(definition, 'objectName', 'ObjectName') ?? '');
  const sameObject = workflowObject.toLowerCase() === objectName.toLowerCase();
  const qualified = tokenPattern(`${objectName}.${fieldName}`);
  const bare = tokenPattern(fieldName);
  const matches = [];
  const seen = new Set();

  const activities = pick(definition, 'activities', 'Activities') ?? [];
  for (const activity of Array.isArray(activities) ? activities : []) {
    const otherObject = propertyTargetsOtherObject(activity, workflowObject);
    const properties = pick(activity, 'properties', 'Properties') ?? [];
    for (const property of Array.isArray(properties) ? properties : []) {
      const propertyName = String(pick(property, 'name', 'Name') ?? '');
      const expressions = pick(property, 'expressions', 'Expressions') ?? {};
      for (const [syntax, text] of Object.entries(expressions)) {
        if (typeof text !== 'string' || !text) continue;
        let confidence = null; let structured = false;
        if (qualified.test(text)) confidence = 'Exact';
        else if (sameObject && !otherObject) {
          const keys = structuredFieldKeys(tryParseJson(text));
          if (keys.some((key) => key.toLowerCase() === fieldName.toLowerCase())) { confidence = 'Exact'; structured = true; }
          else if (bare.test(text)) confidence = 'Probable';
        }
        if (!confidence) continue;
        const activityId = pick(activity, 'activityId', 'ActivityId') ?? '';
        const key = `${activityId}|${propertyName}|${syntax}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          activityId,
          activityName: pick(activity, 'displayName', 'DisplayName') || pick(activity, 'type', 'Type') || 'Activity',
          activityType: pick(activity, 'type', 'Type') ?? '',
          property: propertyName,
          syntax,
          usage: usageFor(propertyName, structured),
          confidence,
          snippet: snippetAround(text, qualified.test(text) ? qualified : bare)
        });
      }
    }
  }

  for (const [label, raw] of [['Variables', pick(definition, 'variables', 'Variables')], ['Custom attributes', pick(definition, 'customAttributes', 'CustomAttributes')]]) {
    const text = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
    if (!text) continue;
    const confidence = qualified.test(text) ? 'Exact' : sameObject && bare.test(text) ? 'Probable' : null;
    if (confidence) matches.push({ activityId: '', activityName: label, activityType: 'Definition', property: label, syntax: 'Json', usage: 'Variable', confidence, snippet: snippetAround(text, qualified.test(text) ? qualified : bare) });
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

export async function scanWorkflows(client, objectName, fieldName) {
  const summaries = await client.listWorkflowDefinitions();
  const failures = [];
  const perWorkflow = await mapWithConcurrency(summaries, 5, async (summary) => {
    const definitionId = String(pick(summary, 'DefinitionId', 'definitionId') ?? pick(summary, 'Id', 'id') ?? '');
    try {
      const definition = await client.getWorkflowDefinition(definitionId);
      return findFieldInWorkflow(definition, objectName, fieldName).map((match) => ({
        id: `workflow:${definitionId}:${match.activityId}:${match.property}:${match.syntax}`,
        recordId: definitionId,
        versionId: pick(definition, 'versionId', 'VersionId', 'id') ?? null,
        workflowName: pick(definition, 'displayName', 'DisplayName') || pick(definition, 'name', 'Name') || definitionId,
        workflowType: pick(definition, 'workflowType', 'WorkflowType') ?? pick(summary, 'WorkflowType') ?? '',
        triggerType: pick(definition, 'triggerType', 'TriggerType') ?? '',
        objectName: pick(definition, 'objectName', 'ObjectName') ?? '',
        version: pick(definition, 'version', 'Version') ?? null,
        published: Boolean(pick(definition, 'isPublished', 'IsPublished')),
        ootb: Boolean(pick(definition, 'isOOTB', 'IsOOTB')),
        ...match
      }));
    } catch (error) {
      failures.push(pick(summary, 'DisplayName', 'Name') || definitionId);
      return [];
    }
  });
  return { results: perWorkflow.flat(), workflowsScanned: summaries.length, failures };
}
