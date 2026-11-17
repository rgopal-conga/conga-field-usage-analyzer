import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createAppServer } from '../server/index.js';
import { normalizePlatformUrl } from '../server/platformUrl.js';
import { buildReferenceUrl, referenceLinkTemplates } from '../server/referenceLinks.js';
import { findFieldInWorkflow } from '../server/workflowScanner.js';

let upstream; let app; let upstreamUrl; let baseUrl;
const observed = { apiHeaders: [], requests: [] };
let omitObjectHasMore = false;
const objects = Array.from({ length: 251 }, (_, index) => ({
  Name: index === 250 ? 'Object250' : `Object${String(index).padStart(3, '0')}`,
  DisplayName: index === 250 ? 'Late Object' : `Object Label ${String(index).padStart(3, '0')}`,
  Category: index % 2 ? 'CPQ' : 'CLM', ObjectType: 'Default', IsProtected: true, IsDeprecated: false
}));
const fields = Array.from({ length: 251 }, (_, index) => ({
  Id: `field-id-${index}`,
  FieldName: index === 250 ? 'TargetField' : `Field${String(index).padStart(3, '0')}`,
  DisplayName: index === 250 ? 'Late Field' : `Field Label ${String(index).padStart(3, '0')}`,
  DataType: index % 3 === 0 ? 'Currency' : 'String', IsRequired: false, IsProtected: true,
  IsCalculated: index === 249, Expression: index === 249 ? 'TargetField * 2' : null,
  ExpressionDependency: index === 249 ? ['TargetField'] : [], ReadAccess: true, WriteAccess: index !== 249
}));
const hooks = Array.from({ length: 202 }, (_, index) => index < 200 ? ({
  Name: `FillerHook${index}`, ObjectName: 'OtherObject', IsActive: true, Condition: 'Status == "Ready"', EventTypes: ['Update'], RuleType: 'DataChange'
}) : index === 200 ? ({
  Id: 'hook-200', Name: 'TargetFieldHook', ObjectName: 'Object250', IsActive: true,
  Condition: 'Object250.TargetField == true', EventTypes: ['Create', 'Update'], RuleType: 'DataChange',
  CustomCodeDetails: { ProjectName: 'UsageProject', ClassName: 'HookHandler', MethodName: 'Run' }
}) : ({
  Name: 'ObjectScopeOnlyHook', ObjectName: 'Object250', IsActive: true,
  Condition: 'Status == "Ready"', EventTypes: ['Update'], RuleType: 'DataChange',
  CustomCodeDetails: { ProjectName: 'UsageProject', ClassName: 'OtherHandler', MethodName: 'Run' }
}));

const workflowSummaries = Array.from({ length: 203 }, (_, index) => ({ Id: `wf-${index}`, DefinitionId: `wf-${index}`, Name: `Workflow${index}`, DisplayName: `Workflow ${index}`, ObjectName: index === 201 ? 'Object250' : 'OtherObject', WorkflowType: 'Standalone', IsLatest: true }));
function workflowDefinition(definitionId) {
  const index = Number(definitionId.split('-')[1]);
  const condition = index === 201 ? '( Object250.TargetField != "Done" )' : '( OtherObject.Status == "Open" )';
  const updates = index === 201 ? '[{"Key":"TargetField","Value":"x"}]' : '[{"Key":"TargetField","Value":"x"}]';
  return { definitionId, displayName: `Workflow ${index}`, objectName: index === 201 ? 'Object250' : 'OtherObject', workflowType: 'Standalone', triggerType: 'DataChange', isPublished: true, version: 1,
    activities: [
      { activityId: 'trigger', type: 'DataChangeWorkflowTriggerActivity', displayName: 'Start Workflow', properties: [{ name: 'WorkflowCondition', expressions: { Liquid: condition } }] },
      { activityId: 'update', type: 'UpdateObjectsActivity', displayName: 'Update', properties: [{ name: 'UpdateType', expressions: { Literal: 'Context Object' } }, { name: 'FieldsToUpdate', expressions: { Json: updates } }] }
    ] };
}
const workflowQueries = [];
// Cross-object formulas: Object010 -> Object250 via lookup, Object011 -> Object010 -> Object250 (two hops),
// Object012 has a TargetField path that leads to a different object, Object013 names the object directly,
// Object014's only mention is inside a string literal, Object015's schema cannot be read.
const crossObjectSchemas = {
  Object010: [
    { FieldName: 'Object250Id', DataType: 'Lookup', LookupObjectName: 'Object250' },
    { FieldName: 'ViaLookup', DataType: 'Currency', IsCalculated: true, Expression: 'Object250Id.TargetField * 2', ExpressionDependency: ['Object250Id.TargetField'] }
  ],
  Object011: [
    { FieldName: 'ParentId', DataType: 'Lookup', LookupObjectName: 'Object010' },
    { FieldName: 'TwoHops', DataType: 'Currency', IsCalculated: true, Expression: 'ParentId.Object250Id.TargetField + 1' }
  ],
  Object012: [
    { FieldName: 'OtherId', DataType: 'Lookup', LookupObjectName: 'Object001' },
    { FieldName: 'WrongObject', DataType: 'Currency', IsCalculated: true, Expression: 'OtherId.TargetField + 1' }
  ],
  Object013: [{ FieldName: 'Named', DataType: 'Currency', IsCalculated: true, Expression: 'Object250.TargetField - 1' }],
  Object014: [{ FieldName: 'InString', DataType: 'String', IsCalculated: true, Expression: 'CONCAT("Object250.TargetField", Name)' }],
  Object015: 'fail'
};
function json(response, status, payload) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); }
async function post(path, payload) { return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
function credentials(extra = {}) { return { platformUrl: upstreamUrl, bearerToken: 'valid-token', userId: '', ...extra }; }

before(async () => {
  upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    observed.apiHeaders.push(request.headers); observed.requests.push(url.pathname + url.search);
    if (request.headers.authorization === 'Bearer invalid-token') return json(response, 401, { Message: 'Invalid or expired bearer token' });
    if (request.headers.authorization !== 'Bearer valid-token') return json(response, 401, { Message: 'Missing bearer token' });
    if (url.pathname === '/api/user-management/v1/organization/info') return json(response, 200, { Success: true, Data: { Id: 'org-1', Name: 'Conga Preview Org' } });
    if (url.pathname === '/api/metadata/v1/objects') {
      const page = Number(url.searchParams.get('pageNumber')); const pageSize = Number(url.searchParams.get('pageSize'));
      if (pageSize === 1) return json(response, 200, { Success: true, Data: [objects[0]], HasMoreRecords: false });
      const start = (page - 1) * pageSize; const data = objects.slice(start, start + pageSize);
      if (omitObjectHasMore) return json(response, 200, { Success: true, Data: data });
      return json(response, 200, { Success: true, Data: data, HasMoreRecords: start + pageSize < objects.length });
    }
    if (url.pathname === '/api/schema/v1/objects/Object250') return json(response, 200, { Success: true, Data: { Name: 'Object250', DisplayName: 'Late Object', FieldMetadata: fields } });
    const schemaMatch = url.pathname.match(/^\/api\/schema\/v1\/objects\/([^/]+)$/);
    if (schemaMatch && crossObjectSchemas[schemaMatch[1]] === 'fail') return json(response, 500, { Message: 'Schema unavailable' });
    if (schemaMatch) return json(response, 200, { Success: true, Data: { Name: schemaMatch[1], FieldMetadata: crossObjectSchemas[schemaMatch[1]] ?? [{ FieldName: 'Name', DataType: 'String' }] } });
    if (url.pathname === '/api/metadata/v1/objects/Object250/fields/Field000/dependency-fields') return json(response, 400, { Success: false, Message: 'Get Field Dependencies is only supported for Picklist/MultiPicklist datatype, please contact System Admin for more info.' });
    if (url.pathname === '/api/metadata/v1/objects/Object250/fields/Field001/dependency-fields') return json(response, 500, { Message: 'Dependency service unavailable' });
    if (url.pathname === '/api/workflow/v1/query/WorkflowDefinition' && request.method === 'POST') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); workflowQueries.push({ query: url.search, body });
      const data = workflowSummaries.slice(body.Skip, body.Skip + body.Limit);
      return json(response, 200, { Success: true, Data: data, TotalCount: workflowSummaries.length });
    }
    const workflowMatch = url.pathname.match(/^\/api\/workflow\/v1\/workflow-definitions\/([^/]+)\/Latest$/);
    if (workflowMatch) {
      if (workflowMatch[1] === 'wf-202') return json(response, 500, { Message: 'Definition unavailable' });
      return json(response, 200, workflowDefinition(workflowMatch[1]));
    }
    if (url.pathname === '/api/extensibility/v1/servicehooks/rules') {
      const page = Number(url.searchParams.get('pageNumber')); const pageSize = Number(url.searchParams.get('pageSize'));
      const start = (page - 1) * pageSize; const data = hooks.slice(start, start + pageSize);
      return json(response, 200, { Success: true, Data: data });
    }
    return json(response, 404, { Message: 'Not found' });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  app = createAppServer({ platformUrlOptions: { allowedHosts: ['127.0.0.1'], allowInsecureForTests: true, allowAnyPortForTests: true }, linkTemplates: { serviceHook: '{platformUrl}/admin/service-hooks/{id}', field: '{platformUrl}/admin/objects/{objectName}/fields/{id}', workflow: '{platformUrl}/admin/workflows/{id}' } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((resolve) => app.close(resolve)); await new Promise((resolve) => upstream.close(resolve)); });

test('serves searchable standalone UI without persistent storage APIs', async () => {
  const htmlResponse = await fetch(baseUrl); const html = await htmlResponse.text();
  assert.match(html, /id="object-search"/); assert.match(html, /id="field-search"/); assert.match(html, /Find usage/);
  assert.doesNotMatch(html, /<select id="object"|<select id="field"/);
  assert.match(htmlResponse.headers.get('cache-control'), /no-store/);
  const clientCode = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(clientCode, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./);
});

test('validates URL and token without creating a cookie or server session', async () => {
  const response = await post('/api/platform/validate', credentials({ bearerToken: 'Bearer valid-token' }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { valid: true, platformUrl: upstreamUrl, hasUserContext: false, organizationName: 'Conga Preview Org' });
});

test('object search scans beyond 200 and returns Label plus API name data', async () => {
  const response = await post('/api/platform/objects/search', credentials({ query: 'Late Object', limit: 50 }));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.totalScanned, 251); assert.equal(result.totalMatches, 1);
  assert.deepEqual(result.items[0], { name: 'Object250', label: 'Late Object', description: '', category: 'CLM', objectType: 'Default', protected: true, deprecated: false });
});

test('field search scans the complete schema beyond 200 and searches data type', async () => {
  const late = await post('/api/platform/fields/search', credentials({ objectName: 'Object250', query: 'Late Field', limit: 50 }));
  const lateResult = await late.json(); assert.equal(lateResult.totalScanned, 251); assert.equal(lateResult.items[0].name, 'TargetField'); assert.equal(lateResult.items[0].label, 'Late Field');
  const byType = await post('/api/platform/fields/search', credentials({ objectName: 'Object250', query: 'Currency', limit: 10 }));
  const typeResult = await byType.json(); assert.ok(typeResult.totalMatches > 10); assert.ok(typeResult.items.every((field) => field.type === 'Currency'));
});

test('usage scan returns formula dependencies and exact Service Hook condition matches', async () => {
  const response = await post('/api/platform/usage-scan', credentials({ objectName: 'Object250', fieldName: 'TargetField' }));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.coverage.objectsScanned, 251); assert.equal(result.coverage.serviceHooksScanned, 202); assert.equal(result.coverage.objectScopedHooks, 2);
  assert.ok(result.formulaDependencies.some((item) => item.fieldName === 'Field249' && item.direction === 'used-by'));
  assert.ok(!result.formulaDependencies.some((item) => item.source === 'Dependency metadata'));
  assert.equal(result.serviceHooks.length, 1); assert.equal(result.serviceHooks[0].name, 'TargetFieldHook'); assert.equal(result.serviceHooks[0].condition, 'Object250.TargetField == true');
  assert.ok(result.limitations.some((text) => /custom code was not analyzed/.test(text)));
});

test('every operation remains stateless and requires credentials', async () => {
  assert.equal((await post('/api/platform/objects/search', { query: 'Late' })).status, 400);
  assert.equal((await post('/api/platform/fields/search', { platformUrl: upstreamUrl, objectName: 'Object250', query: 'Late' })).status, 400);
  assert.equal((await post('/api/platform/usage-scan', { platformUrl: upstreamUrl, bearerToken: 'valid-token', fieldName: 'TargetField' })).status, 400);
});

test('forwards optional user-id only for the current request', async () => {
  const before = observed.apiHeaders.length;
  const withContext = await post('/api/platform/objects/search', credentials({ query: 'Late', userId: 'platform-user-123' }));
  assert.equal(withContext.status, 200); assert.ok(observed.apiHeaders.slice(before).every((headers) => headers['user-id'] === 'platform-user-123'));
  const next = observed.apiHeaders.length;
  const withoutContext = await post('/api/platform/fields/search', credentials({ objectName: 'Object250', query: 'Late' }));
  assert.equal(withoutContext.status, 200); assert.equal(observed.apiHeaders[next]['user-id'], undefined);
});

test('rejects unsafe Platform URLs before outbound calls', async () => {
  const unsafe = ['http://rls.congacloud.com','https://localhost','https://169.254.169.254','https://rls.congacloud.com.evil.example','https://evil.example','https://user:pass@rls.congacloud.com','https://rls.congacloud.com:8443','https://rls.congacloud.com/api/schema','https://rls.congacloud.com?x=1','https://rls.congacloud.com/#x'];
  const before = observed.requests.length;
  for (const platformUrl of unsafe) assert.equal((await post('/api/platform/validate', { platformUrl, bearerToken: 'valid-token' })).status, 400, platformUrl);
  assert.equal(observed.requests.length, before);
});

test('accepts bounded Conga hosts and rejects unsafe identifiers and tokens', async () => {
  assert.equal(normalizePlatformUrl('https://rls.congacloud.com/'), 'https://rls.congacloud.com');
  assert.equal(normalizePlatformUrl('https://prod-rls10.congacloud.com'), 'https://prod-rls10.congacloud.com');
  assert.throws(() => normalizePlatformUrl('https://127.0.0.1'), /allowlist/);
  assert.equal((await post('/api/platform/validate', credentials({ bearerToken: 'invalid-token' }))).status, 401);
  assert.equal((await post('/api/platform/fields/search', credentials({ objectName: '../secret', query: '' }))).status, 400);
  assert.equal((await post('/api/platform/objects/search', credentials({ userId: 'bad user id' }))).status, 400);
});

test('keeps paging objects when the platform omits HasMoreRecords', async () => {
  omitObjectHasMore = true;
  try {
    const response = await post('/api/platform/objects/search', credentials({ query: 'Late Object', limit: 50 }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totalScanned, 251);
    assert.equal(body.items[0].name, 'Object250');
  } finally { omitObjectHasMore = false; }
});

test('usage scan returns record IDs and view links built from the templates', async () => {
  const response = await post('/api/platform/usage-scan', credentials({ objectName: 'Object250', fieldName: 'TargetField' }));
  const result = await response.json();
  const hook = result.serviceHooks[0];
  assert.equal(hook.recordId, 'hook-200');
  assert.equal(hook.viewUrl, `${upstreamUrl}/admin/service-hooks/hook-200`);
  const formula = result.formulaDependencies.find((item) => item.fieldName === 'Field249');
  assert.equal(formula.recordId, 'field-id-249');
  assert.equal(formula.viewUrl, `${upstreamUrl}/admin/objects/Object250/fields/field-id-249`);
  const crossObject = result.formulaDependencies.find((item) => item.fieldName === 'ViaLookup');
  assert.equal(crossObject.objectName, 'Object010');
  assert.equal(crossObject.viewUrl, null); // the mock schema returns no Id for this field, so no link is built
});

test('reference URLs encode values and skip links with missing or unsafe parts', () => {
  assert.equal(buildReferenceUrl('{platformUrl}/hooks/{id}', { platformUrl: 'https://rls.congacloud.com', id: 'a b/../c' }), 'https://rls.congacloud.com/hooks/a%20b%2F..%2Fc');
  assert.equal(buildReferenceUrl('{platformUrl}/hooks/{id}', { platformUrl: 'https://rls.congacloud.com', id: null }), null);
  assert.equal(buildReferenceUrl(null, { id: 'x' }), null);
  assert.equal(buildReferenceUrl('javascript:alert({id})', { id: '1' }), null);
});

test('workflow matcher finds the condition and the field update in a real definition', async () => {
  const definition = JSON.parse(await readFile(new URL('./fixtures/workflow-proposal-test-3.json', import.meta.url), 'utf8'));
  const matches = findFieldInWorkflow(definition, 'Proposal', 'ApprovalStatus');
  assert.deepEqual(matches.map((item) => [item.activityName, item.property, item.usage, item.confidence]), [
    ['Start Workflow', 'WorkflowCondition', 'Condition', 'Exact'],
    ['Update context/related Object(s)', 'FieldsToUpdate', 'Field update', 'Exact']
  ]);
  assert.match(matches[0].snippet, /Proposal\.ApprovalStatus/);
  assert.deepEqual(findFieldInWorkflow(definition, 'Proposal', 'Approval'), []);
  assert.deepEqual(findFieldInWorkflow(definition, 'Agreement', 'ApprovalStatus'), []);
});

test('usage scan pages all workflows, reports matches and tolerates an unreadable definition', async () => {
  const before = workflowQueries.length;
  const response = await post('/api/platform/usage-scan', credentials({ objectName: 'Object250', fieldName: 'TargetField' }));
  const result = await response.json();
  const queries = workflowQueries.slice(before);
  assert.equal(queries.length, 2); assert.equal(queries[0].query, '?IncludeTotalCount=true');
  assert.equal(queries[0].body.ObjectName, 'WorkflowDefinition'); assert.equal(queries[0].body.Criteria, 'IsLatest=true'); assert.equal(queries[1].body.Skip, 200);
  assert.equal(result.coverage.workflowsScanned, 203);
  assert.deepEqual(result.workflows.map((item) => [item.workflowName, item.usage]), [['Workflow 201', 'Condition'], ['Workflow 201', 'Field update']]);
  assert.equal(result.workflows[0].viewUrl, `${upstreamUrl}/admin/workflows/wf-201`);
  assert.equal(result.coverage.collectors.find((item) => item.key === 'workflows').status, 'partial');
  assert.ok(result.limitations.some((text) => /1 workflow definition\(s\) could not be read/.test(text)));
});

test('workflow links default to the Platform workflow page and the field section is gone', async () => {
  const templates = referenceLinkTemplates({});
  assert.equal(buildReferenceUrl(templates.workflow, { platformUrl: 'https://preview-rls09.congacloud.com', id: 'b67e291c-032a-4b50-ae35-b4c1b3b436e2' }), 'https://preview-rls09.congacloud.com/workflow/b67e291c-032a-4b50-ae35-b4c1b3b436e2/');
  assert.equal(templates.field, null);
  const html = await (await fetch(baseUrl)).text();
  assert.doesNotMatch(html, /id="field-details"/);
  assert.match(html, /<details id="usage-panel"/);
});

test('usage scan no longer calls the picklist-only dependency endpoint', async () => {
  const before = observed.requests.length;
  const response = await post('/api/platform/usage-scan', credentials({ objectName: 'Object250', fieldName: 'Field000' }));
  assert.equal(response.status, 200);
  assert.ok(!observed.requests.slice(before).some((path) => path.includes('dependency-fields')));
});

test('formula dependencies include formulas on other objects reached through lookups', async () => {
  const result = await (await post('/api/platform/usage-scan', credentials({ objectName: 'Object250', fieldName: 'TargetField' }))).json();
  const found = result.formulaDependencies.filter((item) => item.direction === 'used-by').map((item) => `${item.objectName}.${item.fieldName}`).sort();
  assert.deepEqual(found, ['Object010.ViaLookup', 'Object011.TwoHops', 'Object013.Named', 'Object250.Field249']);
  assert.ok(result.formulaDependencies.every((item) => item.expression || item.dependencies?.length));
  assert.equal(result.coverage.collectors.find((item) => item.key === 'formulaDependencies').status, 'partial');
  assert.ok(result.limitations.some((text) => /1 object schema\(s\) could not be read.*Object015/.test(text)));
});
