import { ATTRIBUTE_OBJECT, CongaApiError } from './congaClient.js';
import { buildReferenceUrl } from './referenceLinks.js';
import { scanWorkflows } from './workflowScanner.js';
import { scanFieldExpressions } from './fieldExpressionScanner.js';
import { findFormulaReferences, loadAllSchemas } from './formulaScanner.js';
import { scanCustomCode } from './customCodeScanner.js';

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

function fieldTokenInCondition(condition, objectName, fieldName) {
  if (!condition) return false;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = (value) => new RegExp(`(^|[^A-Za-z0-9_])${escape(value)}($|[^A-Za-z0-9_])`, 'i').test(condition);
  return boundary(`${objectName}.${fieldName}`) || boundary(fieldName);
}

// A Service Hook on the selected object whose configured condition names the field is reported
// as a Custom code entry with access "Condition", next to the code that hook runs.
function hookConditionResults(hooks, objectName, fieldName) {
  return hooks
    .filter((hook) => String(pick(hook, 'ObjectName', 'objectName') ?? '').toLowerCase() === objectName.toLowerCase())
    .filter((hook) => fieldTokenInCondition(pick(hook, 'Condition', 'condition'), objectName, fieldName))
    .map((hook) => {
      const details = pick(hook, 'CustomCodeDetails', 'customCodeDetails') ?? {};
      const name = pick(hook, 'Name', 'name') ?? 'Unnamed Service Hook';
      const ruleType = pick(hook, 'RuleType', 'ruleType');
      const events = pick(hook, 'EventTypes', 'eventTypes') ?? [];
      return {
        id: `service-hook-condition:${name}`,
        recordId: pick(hook, 'Id', 'id') ?? null,
        projectName: pick(details, 'ProjectName', 'projectName') ?? null,
        filePath: null,
        line: null,
        source: 'Service Hook condition',
        className: pick(details, 'ClassName', 'className') ?? null,
        methodName: pick(details, 'MethodName', 'methodName') ?? null,
        access: 'Condition',
        confidence: 'Exact',
        snippet: String(pick(hook, 'Condition', 'condition') ?? ''),
        runsAs: [{ type: 'Service Hook', name, objectName: pick(hook, 'ObjectName', 'objectName') ?? objectName, detail: [ruleType, events.join('/')].filter(Boolean).join(' · '), active: pick(hook, 'IsActive', 'isActive') !== false }]
      };
    })
    .sort((left, right) => left.runsAs[0].name.localeCompare(right.runsAs[0].name));
}

// Product attributes are Attribute records, not schema fields, so they have their own scan: Field Expressions,
// workflows and custom code are matched on the attribute API name (Attribute./AttributeValue. paths are Exact);
// formula dependencies do not apply.
const listText = (items) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ', …' : ''}`;
async function scanAttributeUsage(client, attributeName, { platformUrl, linkTemplates }) {
  if (typeof attributeName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(attributeName)) throw new CongaApiError('Attribute name is invalid', 400);
  const attributes = await client.listAttributes();
  const selected = attributes.find((item) => item.name === attributeName);
  if (!selected) throw new CongaApiError('Selected attribute was not found', 404);
  const objectName = ATTRIBUTE_OBJECT.name;

  let hookError = null;
  const hooksPromise = client.listServiceHooks().catch((error) => { hookError = error; return []; });
  const [workflowScan, fieldExpressionScan, customCodeScan, hooks] = await Promise.all([
    scanWorkflows(client, objectName, attributeName, { attribute: true }).catch((error) => ({ error })),
    scanFieldExpressions(client, objectName, attributeName, { attribute: { name: selected.name, label: selected.label } }).catch((error) => ({ error })),
    hooksPromise.then((list) => scanCustomCode(client, objectName, attributeName, { hooks: list, attribute: true })).catch((error) => ({ error })),
    hooksPromise
  ]);

  const workflowResults = workflowScan.error ? [] : workflowScan.results;
  for (const item of workflowResults) item.viewUrl = buildReferenceUrl(linkTemplates.workflow, { platformUrl, id: item.recordId, objectName: item.objectName, name: item.workflowName });
  const fieldExpressionResults = fieldExpressionScan.error ? [] : fieldExpressionScan.results;
  for (const item of fieldExpressionResults) item.viewUrl = buildReferenceUrl(linkTemplates.fieldExpression, { platformUrl, id: item.recordId, objectName, fieldName: attributeName, name: item.expressionName });
  const customCodeResults = customCodeScan.error ? [] : customCodeScan.results;
  for (const item of customCodeResults) item.viewUrl = buildReferenceUrl(linkTemplates.customCode, { platformUrl, id: item.projectName, objectName, fieldName: attributeName, name: item.projectName });

  const status = (scan) => (scan.error ? 'failed' : scan.failures.length ? 'partial' : 'complete');
  const limitations = [];
  if (workflowScan.error) limitations.push(`Workflow scan failed: ${workflowScan.error.message}. The other results are still complete.`);
  else if (workflowScan.failures.length) limitations.push(`${workflowScan.failures.length} workflow definition(s) could not be read and were skipped: ${listText(workflowScan.failures)}.`);
  if (fieldExpressionScan.error) limitations.push(`Field expression scan failed: ${fieldExpressionScan.error.message}. The other results are still complete.`);
  else if (fieldExpressionScan.failures.length) limitations.push(`${fieldExpressionScan.failures.length} field expression(s) could not be read and were skipped: ${listText(fieldExpressionScan.failures)}.`);
  if (hookError) limitations.push(`Service Hook rules could not be read (${hookError.message}); "Runs as" may omit Service Hooks.`);
  if (customCodeScan.error) limitations.push(`Custom code scan failed: ${customCodeScan.error.message}. The other results are still complete.`);
  else {
    if (customCodeScan.failures.length) limitations.push(`${customCodeScan.failures.length} custom code project(s) could not be read and were skipped: ${listText(customCodeScan.failures)}.`);
    limitations.push(...customCodeScan.notes);
  }
  limitations.push('Product attributes are matched on their API name (Attribute./AttributeValue. paths are exact). Formula dependencies do not apply.');

  return {
    field: { objectName, fieldName: selected.name, label: selected.label, dataType: selected.type, kind: 'attribute' },
    formulaDependencies: [],
    workflows: workflowResults,
    fieldExpressions: fieldExpressionResults,
    customCode: customCodeResults,
    coverage: {
      objectsScanned: 0, fieldsScanned: 0,
      workflowsScanned: workflowScan.error ? 0 : workflowScan.workflowsScanned,
      fieldExpressionsScanned: fieldExpressionScan.error ? 0 : fieldExpressionScan.fieldExpressionsScanned,
      customCodeProjectsScanned: customCodeScan.error ? 0 : customCodeScan.projectsScanned,
      customCodeFilesScanned: customCodeScan.error ? 0 : customCodeScan.filesScanned,
      serviceHooksScanned: hooks.length,
      attributesScanned: attributes.length,
      collectors: [
        { key: 'formulaDependencies', label: 'Formula dependencies (all objects)', status: 'not applicable', matches: 0 },
        { key: 'workflows', label: 'Workflow references', status: status(workflowScan), matches: workflowResults.length },
        { key: 'fieldExpressions', label: 'Field expression references', status: status(fieldExpressionScan), matches: fieldExpressionResults.length },
        { key: 'customCode', label: 'Custom code references', status: status(customCodeScan), matches: customCodeResults.length }
      ]
    },
    limitations
  };
}

export async function scanFieldUsage(client, objectName, fieldName, { platformUrl = null, linkTemplates = {}, kind = 'field' } = {}) {
  if (kind === 'attribute') return scanAttributeUsage(client, fieldName, { platformUrl, linkTemplates });
  if (typeof objectName !== 'string' || typeof fieldName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(objectName) || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(fieldName)) {
    throw new CongaApiError('Object or field name is invalid', 400);
  }

  // Service Hook rules are read only to show which hook runs a piece of custom code ("Runs as").
  // A failure here must not block the scan; the custom code results simply lose that wiring.
  let hookError = null;
  const hooksPromise = client.listServiceHooks().catch((error) => { hookError = error; return []; });
  // Field expressions follow relationship paths (e.g. AttributeValue.X) through the same tenant schemas.
  const schemaPromise = loadAllSchemas(client, objectName);
  const [schemaScan, workflowScan, fieldExpressionScan, customCodeScan, hooks] = await Promise.all([
    schemaPromise,
    scanWorkflows(client, objectName, fieldName).catch((error) => ({ error })),
    scanFieldExpressions(client, objectName, fieldName, { schemas: schemaPromise.then((scan) => scan.schemas) }).catch((error) => ({ error })),
    hooksPromise.then((list) => scanCustomCode(client, objectName, fieldName, { hooks: list })).catch((error) => ({ error })),
    hooksPromise
  ]);
  const fields = schemaScan.schemas.get(objectName.toLowerCase()) ?? [];
  const selected = fields.find((field) => field.name === fieldName);
  if (!selected) throw new CongaApiError('Selected field was not found in the object schema', 404);

  const formulaResults = findFormulaReferences(schemaScan.schemas, objectName, fieldName)
    .sort((left, right) => Number(right.direction === 'depends-on') - Number(left.direction === 'depends-on') ||
      left.objectName.localeCompare(right.objectName) || left.name.localeCompare(right.name))
    .map((field) => ({
      id: `formula:${field.objectName}.${field.name}`,
      recordId: field.id ?? null,
      direction: field.direction,
      objectName: field.objectName,
      fieldName: field.name,
      fieldLabel: field.label,
      dataType: field.type,
      expression: field.expression,
      dependencies: field.expressionDependencies,
      confidence: 'Exact',
      source: 'Object schema'
    }));
  const fieldsScanned = [...schemaScan.schemas.values()].reduce((sum, list) => sum + list.length, 0);

  for (const item of formulaResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.field, { platformUrl, id: item.recordId, objectName: item.objectName, fieldName: item.fieldName, name: item.fieldName });
  }

  const workflowResults = workflowScan.error ? [] : workflowScan.results;
  for (const item of workflowResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.workflow, { platformUrl, id: item.recordId, objectName: item.objectName, name: item.workflowName });
  }
  const workflowStatus = workflowScan.error ? 'failed' : workflowScan.failures.length ? 'partial' : 'complete';
  const fieldExpressionResults = fieldExpressionScan.error ? [] : fieldExpressionScan.results;
  for (const item of fieldExpressionResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.fieldExpression, { platformUrl, id: item.recordId, objectName, fieldName, name: item.expressionName });
  }
  const fieldExpressionStatus = fieldExpressionScan.error ? 'failed' : fieldExpressionScan.failures.length ? 'partial' : 'complete';
  const customCodeResults = [...hookConditionResults(hooks, objectName, fieldName), ...(customCodeScan.error ? [] : customCodeScan.results)];
  for (const item of customCodeResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.customCode, { platformUrl, id: item.projectName, objectName, fieldName, name: item.projectName });
  }
  const customCodeStatus = customCodeScan.error ? 'failed' : customCodeScan.failures.length ? 'partial' : 'complete';
  const limitations = [];
  if (schemaScan.failures.length) limitations.push(`${schemaScan.failures.length} object schema(s) could not be read, so their formulas were not checked: ${schemaScan.failures.slice(0, 5).join(', ')}${schemaScan.failures.length > 5 ? ', …' : ''}.`);
  if (workflowScan.error) limitations.push(`Workflow scan failed: ${workflowScan.error.message}. The other results are still complete.`);
  else if (workflowScan.failures.length) limitations.push(`${workflowScan.failures.length} workflow definition(s) could not be read and were skipped: ${workflowScan.failures.slice(0, 5).join(', ')}${workflowScan.failures.length > 5 ? ', …' : ''}.`);
  if (fieldExpressionScan.error) limitations.push(`Field expression scan failed: ${fieldExpressionScan.error.message}. The other results are still complete.`);
  else if (fieldExpressionScan.failures.length) limitations.push(`${fieldExpressionScan.failures.length} field expression(s) could not be read and were skipped: ${fieldExpressionScan.failures.slice(0, 5).join(', ')}${fieldExpressionScan.failures.length > 5 ? ', …' : ''}.`);
  if (hookError) limitations.push(`Service Hook rules could not be read (${hookError.message}); hook conditions were not checked and "Runs as" may omit Service Hooks.`);
  if (customCodeScan.error) limitations.push(`Custom code scan failed: ${customCodeScan.error.message}. The other results are still complete.`);
  else {
    if (customCodeScan.failures.length) limitations.push(`${customCodeScan.failures.length} custom code project(s) could not be read and were skipped: ${customCodeScan.failures.slice(0, 5).join(', ')}${customCodeScan.failures.length > 5 ? ', …' : ''}.`);
    limitations.push(...customCodeScan.notes);
    if (customCodeResults.length) limitations.push('Custom code is matched as text (string literals and identifiers), not compiled. Field names built at runtime, or read through generic loops over all fields, are not detected. Review Probable and Possible matches before acting on them.');
  }

  return {
    field: { objectName, fieldName, label: selected.label, dataType: selected.type },
    formulaDependencies: formulaResults,
    workflows: workflowResults,
    fieldExpressions: fieldExpressionResults,
    customCode: customCodeResults,
    coverage: {
      objectsScanned: schemaScan.objectsScanned,
      fieldsScanned,
      workflowsScanned: workflowScan.error ? 0 : workflowScan.workflowsScanned,
      fieldExpressionsScanned: fieldExpressionScan.error ? 0 : fieldExpressionScan.fieldExpressionsScanned,
      customCodeProjectsScanned: customCodeScan.error ? 0 : customCodeScan.projectsScanned,
      customCodeFilesScanned: customCodeScan.error ? 0 : customCodeScan.filesScanned,
      serviceHooksScanned: hooks.length,
      collectors: [
        { key: 'formulaDependencies', label: 'Formula dependencies (all objects)', status: schemaScan.failures.length ? 'partial' : 'complete', matches: formulaResults.length },
        { key: 'workflows', label: 'Workflow references', status: workflowStatus, matches: workflowResults.length },
        { key: 'fieldExpressions', label: 'Field expression references', status: fieldExpressionStatus, matches: fieldExpressionResults.length },
        { key: 'customCode', label: 'Custom code references', status: customCodeStatus, matches: customCodeResults.length }
      ]
    },
    limitations
  };
}