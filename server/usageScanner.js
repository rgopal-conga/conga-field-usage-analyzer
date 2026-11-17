import { CongaApiError } from './congaClient.js';

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

function normalizeDependency(value) {
  return String(value ?? '').trim().toLowerCase();
}

function referencesSelectedField(dependencies, objectName, fieldName) {
  const wanted = new Set([
    normalizeDependency(fieldName),
    normalizeDependency(`${objectName}.${fieldName}`),
    normalizeDependency(`${objectName}::${fieldName}`)
  ]);
  return Array.isArray(dependencies) && dependencies.some((item) => wanted.has(normalizeDependency(item)));
}

function fieldTokenInCondition(condition, objectName, fieldName) {
  if (!condition) return false;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = (value) => new RegExp(`(^|[^A-Za-z0-9_])${escape(value)}($|[^A-Za-z0-9_])`, 'i').test(condition);
  return boundary(`${objectName}.${fieldName}`) || boundary(fieldName);
}

function extractDependencyItems(data) {
  const found = [];
  const seen = new Set();
  function visit(value, depth = 0) {
    if (depth > 6 || value === null || value === undefined) return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    if (typeof value !== 'object') return;
    const fieldName = pick(value, 'FieldName', 'fieldName', 'Name', 'name');
    if (typeof fieldName === 'string') {
      const objectName = pick(value, 'ObjectName', 'objectName') ?? '';
      const key = `${objectName}.${fieldName}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({
          objectName,
          fieldName,
          label: pick(value, 'DisplayName', 'displayName') || fieldName,
          dataType: pick(value, 'DataType', 'dataType') ?? '',
          expression: pick(value, 'Expression', 'expression') ?? null,
          expressionDependencies: pick(value, 'ExpressionDependency', 'expressionDependency') ?? []
        });
      }
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  }
  visit(data);
  return found;
}

export async function scanFieldUsage(client, objectName, fieldName) {
  if (typeof objectName !== 'string' || typeof fieldName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(objectName) || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(fieldName)) {
    throw new CongaApiError('Object or field name is invalid', 400);
  }

  const [fields, dependencyData, hooks] = await Promise.all([
    client.getObjectFields(objectName),
    client.getFieldDependencies(objectName, fieldName),
    client.listServiceHooks()
  ]);
  const selected = fields.find((field) => field.name === fieldName);
  if (!selected) throw new CongaApiError('Selected field was not found in the object schema', 404);

  const formulaResults = [];
  if (selected.expression || selected.expressionDependencies.length) {
    formulaResults.push({
      id: `formula-source:${objectName}.${fieldName}`,
      direction: 'depends-on',
      objectName,
      fieldName,
      fieldLabel: selected.label,
      dataType: selected.type,
      expression: selected.expression,
      dependencies: selected.expressionDependencies,
      confidence: 'Exact',
      source: 'Object schema'
    });
  }
  for (const field of fields) {
    if (field.name !== fieldName && referencesSelectedField(field.expressionDependencies, objectName, fieldName)) {
      formulaResults.push({
        id: `formula-dependent:${objectName}.${field.name}`,
        direction: 'used-by',
        objectName,
        fieldName: field.name,
        fieldLabel: field.label,
        dataType: field.type,
        expression: field.expression,
        dependencies: field.expressionDependencies,
        confidence: 'Exact',
        source: 'Object schema'
      });
    }
  }
  for (const dependent of extractDependencyItems(dependencyData)) {
    if (dependent.fieldName === fieldName && (!dependent.objectName || dependent.objectName === objectName)) continue;
    const id = `metadata-dependent:${dependent.objectName || objectName}.${dependent.fieldName}`;
    if (!formulaResults.some((item) => item.fieldName === dependent.fieldName && item.direction === 'used-by')) {
      formulaResults.push({ ...dependent, id, objectName: dependent.objectName || objectName, direction: 'used-by', confidence: 'Exact', source: 'Dependency metadata' });
    }
  }

  const objectHooks = hooks.filter((hook) => String(pick(hook, 'ObjectName', 'objectName') ?? '').toLowerCase() === objectName.toLowerCase());
  const serviceHookResults = objectHooks
    .filter((hook) => fieldTokenInCondition(pick(hook, 'Condition', 'condition'), objectName, fieldName))
    .map((hook) => {
      const customCode = pick(hook, 'CustomCodeDetails', 'customCodeDetails') ?? {};
      return {
        id: `service-hook:${pick(hook, 'Name', 'name')}`,
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

  return {
    field: { objectName, fieldName, label: selected.label, dataType: selected.type },
    formulaDependencies: formulaResults,
    serviceHooks: serviceHookResults,
    coverage: {
      fieldsScanned: fields.length,
      serviceHooksScanned: hooks.length,
      objectScopedHooks: objectHooks.length,
      conditionMatches: serviceHookResults.length,
      collectors: [
        { key: 'formulaDependencies', label: 'Formula dependencies', status: 'complete', matches: formulaResults.length },
        { key: 'serviceHooks', label: 'Service Hook conditions', status: 'complete', matches: serviceHookResults.length }
      ]
    },
    limitations: objectHooks.length > serviceHookResults.length ? [
      `${objectHooks.length - serviceHookResults.length} additional Service Hook(s) target this object but do not reference the field in their configured condition. Their custom code was not analyzed.`
    ] : []
  };
}