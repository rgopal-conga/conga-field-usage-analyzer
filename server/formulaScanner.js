// Finds formula fields, on any object in the tenant, whose expression reaches the selected field.
// Same-object references look like `ApprovalStatus`; cross-object references follow lookup
// fields, e.g. `ProposalId.ApprovalStatus` or `ConfigurationId.ProposalId.ApprovalStatus`.

const identifierPath = /[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)*/g;
const lower = (value) => String(value ?? '').toLowerCase();

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function candidatePaths(field) {
  const paths = new Set();
  for (const dependency of Array.isArray(field.expressionDependencies) ? field.expressionDependencies : []) {
    if (typeof dependency === 'string') paths.add(dependency.trim());
  }
  if (typeof field.expression === 'string') {
    // Ignore quoted literals so text such as "Proposal.ApprovalStatus" inside a string is not a reference.
    const code = field.expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ');
    for (const match of code.matchAll(identifierPath)) paths.add(match[0]);
  }
  return [...paths].filter(Boolean).map((path) => path.split(/\.|::/));
}

// Follows one lookup hop from `fromObject` using segment `segment`; returns the target object name or null.
function followLookup(schemas, fromObject, segment) {
  const fields = schemas.get(lower(fromObject));
  if (!fields) return null;
  const wanted = lower(segment);
  const lookups = fields.filter((field) => field.lookupObjectName);
  const hit = lookups.find((field) => lower(field.name) === wanted) ||
    lookups.find((field) => lower(field.name) === `${wanted}id`) ||
    lookups.find((field) => lower(field.name).replace(/id$/, '') === wanted) ||
    lookups.find((field) => lower(field.lookupObjectName) === wanted);
  return hit ? hit.lookupObjectName : null;
}

export function pathReachesField(schemas, ownerObject, segments, objectName, fieldName) {
  if (!segments.length || lower(segments[segments.length - 1]) !== lower(fieldName)) return false;
  let current = ownerObject;
  let hops = segments.slice(0, -1);
  // A leading segment naming the owner object itself (e.g. `Proposal.ApprovalStatus` on Proposal) is not a hop.
  if (hops.length && lower(hops[0]) === lower(ownerObject)) hops = hops.slice(1);
  for (const hop of hops) {
    const next = followLookup(schemas, current, hop);
    if (!next) {
      // Unknown hop: accept only an explicit `Object.Field` naming the selected object.
      return hops.length === 1 && lower(hop) === lower(objectName);
    }
    current = next;
  }
  return lower(current) === lower(objectName);
}

export function findFormulaReferences(schemas, objectName, fieldName) {
  const results = [];
  for (const [, fields] of schemas) {
    for (const field of fields) {
      if (!field.expression && !(field.expressionDependencies?.length)) continue;
      const ownerObject = field.objectName;
      const isSelected = lower(ownerObject) === lower(objectName) && lower(field.name) === lower(fieldName);
      if (isSelected) {
        results.push({ ...field, direction: 'depends-on' });
        continue;
      }
      if (candidatePaths(field).some((segments) => pathReachesField(schemas, ownerObject, segments, objectName, fieldName))) {
        results.push({ ...field, direction: 'used-by' });
      }
    }
  }
  return results;
}

export async function loadAllSchemas(client, selectedObject) {
  const objects = await client.listObjects();
  const names = [...new Set([selectedObject, ...objects.map((item) => item.name)])];
  const schemas = new Map();
  const failures = [];
  await mapWithConcurrency(names, 8, async (name) => {
    try {
      const fields = await client.getObjectFields(name);
      schemas.set(lower(name), fields.map((field) => ({ ...field, objectName: name })));
    } catch (error) {
      if (lower(name) === lower(selectedObject)) throw error;
      failures.push(name);
    }
  });
  return { schemas, failures, objectsScanned: names.length };
}
