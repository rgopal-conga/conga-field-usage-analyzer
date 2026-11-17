import { CongaApiError } from './congaClient.js';
import { buildReferenceUrl } from './referenceLinks.js';
import { scanWorkflows } from './workflowScanner.js';
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

export async function scanFieldUsage(client, objectName, fieldName, { platformUrl = null, linkTemplates = {} } = {}) {
  if (typeof objectName !== 'string' || typeof fieldName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(objectName) || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(fieldName)) {
    throw new CongaApiError('Object or field name is invalid', 400);
  }

  const hooksPromise = client.listServiceHooks();
  const [schemaScan, hooks, workflowScan, customCodeScan] = await Promise.all([
    loadAllSchemas(client, objectName),
    hooksPromise,
    scanWorkflows(client, objectName, fieldName).catch((error) => ({ error })),
    hooksPromise.then((list) => scanCustomCode(client, objectName, fieldName, { hooks: list })).catch((error) => ({ error }))
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

  const objectHooks = hooks.filter((hook) => String(pick(hook, 'ObjectName', 'objectName') ?? '').toLowerCase() === objectName.toLowerCase());
  const serviceHookResults = objectHooks
    .filter((hook) => fieldTokenInCondition(pick(hook, 'Condition', 'condition'), objectName, fieldName))
    .map((hook) => {
      const customCode = pick(hook, 'CustomCodeDetails', 'customCodeDetails') ?? {};
      return {
        id: `service-hook:${pick(hook, 'Name', 'name')}`,
        recordId: pick(hook, 'Id', 'id') ?? null,
        name: pick(hook, 'Name', 'name') ?? 'Unnamed service hook',
        objectName: pick(hook, 'ObjectName', 'objectName') ?? objectName,
        condition: pick(hook, 'Condition', 'condition') ?? '',
        active: Boolean(pick(hook, 'IsActive', 'isActive')),
        eventTypes: pick(hook, 'EventTypes', 'eventTypes') ?? [],
        ruleType: pick(hook, 'RuleType', 'ruleType') ?? '',
        projectName: pick(customCode, 'ProjectName', 'projectName') ?? null,
        className: pick(customCode, 'ClassName', 'className') ?? null,
        methodName: pick(customCode, 'MethodName', 'methodName') ?? null,
        confidence: 'Exact',
        usage: 'Condition'
      };
    });

  for (const item of formulaResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.field, { platformUrl, id: item.recordId, objectName: item.objectName, fieldName: item.fieldName, name: item.fieldName });
  }
  for (const item of serviceHookResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.serviceHook, { platformUrl, id: item.recordId, objectName: item.objectName, name: item.name });
  }

  const workflowResults = workflowScan.error ? [] : workflowScan.results;
  for (const item of workflowResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.workflow, { platformUrl, id: item.recordId, objectName: item.objectName, name: item.workflowName });
  }
  const workflowStatus = workflowScan.error ? 'failed' : workflowScan.failures.length ? 'partial' : 'complete';
  const customCodeResults = customCodeScan.error ? [] : customCodeScan.results;
  for (const item of customCodeResults) {
    item.viewUrl = buildReferenceUrl(linkTemplates.customCode, { platformUrl, id: item.projectName, objectName, fieldName, name: item.projectName });
  }
  const customCodeStatus = customCodeScan.error ? 'failed' : customCodeScan.failures.length ? 'partial' : 'complete';
  const limitations = [];
  if (objectHooks.length > serviceHookResults.length) {
    limitations.push(customCodeScan.error
      ? `${objectHooks.length - serviceHookResults.length} additional Service Hook(s) target this object but do not reference the field in their configured condition. Their custom code was not analyzed.`
      : `${objectHooks.length - serviceHookResults.length} additional Service Hook(s) target this object but do not reference the field in their configured condition. Their custom code is covered under Custom code.`);
  }
  if (schemaScan.failures.length) limitations.push(`${schemaScan.failures.length} object schema(s) could not be read, so their formulas were not checked: ${schemaScan.failures.slice(0, 5).join(', ')}${schemaScan.failures.length > 5 ? ', …' : ''}.`);
  if (workflowScan.error) limitations.push(`Workflow scan failed: ${workflowScan.error.message}. Formula and Service Hook results are still complete.`);
  else if (workflowScan.failures.length) limitations.push(`${workflowScan.failures.length} workflow definition(s) could not be read and were skipped: ${workflowScan.failures.slice(0, 5).join(', ')}${workflowScan.failures.length > 5 ? ', …' : ''}.`);
  if (customCodeScan.error) limitations.push(`Custom code scan failed: ${customCodeScan.error.message}. The other results are still complete.`);
  else {
    if (customCodeScan.failures.length) limitations.push(`${customCodeScan.failures.length} custom code project(s) could not be read and were skipped: ${customCodeScan.failures.slice(0, 5).join(', ')}${customCodeScan.failures.length > 5 ? ', …' : ''}.`);
    limitations.push(...customCodeScan.notes);
    if (customCodeResults.length) limitations.push('Custom code is matched as text (string literals and identifiers), not compiled. Field names built at runtime, or read through generic loops over all fields, are not detected. Review Probable and Possible matches before acting on them.');
  }

  return {
    field: { objectName, fieldName, label: selected.label, dataType: selected.type },
    formulaDependencies: formulaResults,
    serviceHooks: serviceHookResults,
    workflows: workflowResults,
    customCode: customCodeResults,
    coverage: {
      objectsScanned: schemaScan.objectsScanned,
      fieldsScanned,
      serviceHooksScanned: hooks.length,
      objectScopedHooks: objectHooks.length,
      conditionMatches: serviceHookResults.length,
      workflowsScanned: workflowScan.error ? 0 : workflowScan.workflowsScanned,
      customCodeProjectsScanned: customCodeScan.error ? 0 : customCodeScan.projectsScanned,
      customCodeFilesScanned: customCodeScan.error ? 0 : customCodeScan.filesScanned,
      collectors: [
        { key: 'formulaDependencies', label: 'Formula dependencies (all objects)', status: schemaScan.failures.length ? 'partial' : 'complete', matches: formulaResults.length },
        { key: 'serviceHooks', label: 'Service Hook conditions', status: 'complete', matches: serviceHookResults.length },
        { key: 'workflows', label: 'Workflow references', status: workflowStatus, matches: workflowResults.length },
        { key: 'customCode', label: 'Custom code references', status: customCodeStatus, matches: customCodeResults.length }
      ]
    },
    limitations
  };
}