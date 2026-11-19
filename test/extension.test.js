// Guards the "works in both runtimes" rule: the extension build must contain the same
// API and scanners as the standalone server, and they must run without Node.js APIs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { browserSafetyProblems, buildExtension, ICON_SIZES } from '../scripts/build-extension.js';

let outDir; let built;
before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'fua-extension-'));
  built = await buildExtension({ outDir, env: { CONGA_ALLOWED_PLATFORM_HOSTS: 'gateway.example.internal', CONGA_CUSTOM_CODE_URL_TEMPLATE: '{platformUrl}/cc/{name}' } });
});
after(async () => { await rm(outDir, { recursive: true, force: true }); });

test('builds a Manifest V3 extension with the UI, the shared core and purple circle icons', async () => {
  const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(!('permissions' in manifest), 'no storage or other permissions are requested');
  assert.ok(manifest.host_permissions.includes('https://*.congacloud.com/*'));
  assert.ok(manifest.host_permissions.includes('https://gateway.example.internal/*'), 'approved private gateway is added');
  assert.match(manifest.content_security_policy.extension_pages, /connect-src [^;]*https:\/\/gateway\.example\.internal/);
  for (const file of ['index.html', 'app.js', 'resultFilters.js', 'styles.css', 'icon.svg', 'background.js', 'extension-config.js', 'core/api.js']) await readFile(join(outDir, file));
  const serverModules = (await readdir(new URL('../server/', import.meta.url))).filter((name) => name.endsWith('.js') && name !== 'index.js').sort();
  assert.deepEqual((await readdir(join(outDir, 'core'))).sort(), serverModules, 'every shared server module ships in the extension');
  for (const size of ICON_SIZES) {
    const png = await readFile(join(outDir, 'icons', `icon-${size}.png`));
    assert.equal(png.toString('latin1', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    assert.equal(manifest.icons[size], `icons/icon-${size}.png`);
  }
  const config = (await import(pathToFileURL(join(outDir, 'extension-config.js')).href)).default;
  assert.deepEqual(config.allowedHosts, ['gateway.example.internal']);
  assert.equal(config.linkTemplates.customCode, '{platformUrl}/cc/{name}');
});

test('shared modules are browser-safe and the safety check catches Node-only code', async () => {
  for (const name of built.sharedModules) assert.deepEqual(browserSafetyProblems(name, await readFile(join(outDir, 'core', name), 'utf8')), []);
  assert.equal(browserSafetyProblems('x.js', "import { readFile } from 'node:fs/promises';").length, 1);
  assert.equal(browserSafetyProblems('x.js', 'const b = Buffer.from(x);').length, 1);
  assert.equal(browserSafetyProblems('x.js', 'const e = process.env.X;').length, 1);
  assert.equal(browserSafetyProblems('x.js', 'const e = globalThis.process?.env ?? {};').length, 0);
  assert.equal(browserSafetyProblems('x.js', 'localStorage.setItem("t", token);').length, 1);
});

test('UI sends every API call through request() and routes stay in the shared API', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.equal(app.match(/\bfetch\(/g).length, 1, 'only request() may call fetch');
  assert.match(app, /import\('\.\/core\/api\.js'\)/);
  const server = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /\/api\/platform\//, 'API routes belong in server/api.js, not the HTTP host');
});

// A tiny Conga tenant served through a fetch stub, the way the extension page calls it.
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content); const packed = deflateRawSync(data); const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes); offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function tenantFetch() {
  const seen = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const impl = async (url, init) => {
    const { pathname } = new URL(url); seen.push({ pathname, auth: init.headers.Authorization, redirect: init.redirect });
    if (pathname === '/api/metadata/v1/objects') return json({ Success: true, Data: [{ Name: 'Agreement', DisplayName: 'Agreement' }], HasMoreRecords: false });
    if (pathname === '/api/user-management/v1/organization/info') return json({ Data: { Name: 'Extension Test Org' } });
    if (pathname === '/api/schema/v1/objects/Agreement') return json({ Success: true, Data: { FieldMetadata: [
      { Id: 'f1', FieldName: 'Status', DisplayName: 'Status', DataType: 'String' },
      { Id: 'f2', FieldName: 'StatusLabel', DisplayName: 'Status label', DataType: 'String', IsCalculated: true, Expression: 'UPPER(Status)', ExpressionDependency: ['Status'] }
    ] } });
    if (pathname.endsWith('/dependency-fields')) return json({ Success: true, Data: [] });
    if (pathname === '/api/workflow/v1/query/WorkflowDefinition') return json({ Data: [], TotalCount: 0 });
    if (pathname === '/api/search/v1/objects/FieldExpression/query') return json([{ Id: 'fe-1', Name: 'Status filter' }, { Id: 'fe-2', Name: 'Speed' }]);
    if (pathname === '/api/search/v1/objects/ConstraintRule/query') return json({ Success: true, RecordCount: 1, Data: [{ Id: 'cr-1', Name: 'Status rule', Type: 'Validation', IsActive: true }], StatusCode: 'OK' });
    if (pathname === '/api/revenue-admin/v1/constraint-rules/cr-1/conditions') return json([{ Id: 'c1', Name: 'Status rule Condition 1', ConditionCriteria: JSON.stringify({ ObjectName: 'Agreement', filter: { predicates: [{ FieldName: 'Status', ObjectName: 'Agreement' }] }, exprStr: '(Status equal to Active)' }) }]);
    if (pathname === '/api/revenue-admin/v1/constraint-rules/cr-1/actions') return json([]);
    if (pathname === '/api/search/v1/objects/AttributeConstraintRule/query') return json({ Success: true, RecordCount: 1, Data: [{ Id: 'acr-1', Name: 'Ram Test', RuleType: 'Inclusion', IsActive: false }], StatusCode: 'OK', HasMoreRecords: false });
    if (pathname === '/api/revenue-admin/v1/attribute-constraint-rules/acr-1/entries') return json([{ Id: 'e1', Name: 'Ram Test Entry 1', ConditionAttributes: [{ Name: 'Internet_Speed_c', Operator: 'equal to', Type: 'Discrete', Value: '10 Mbps' }], ActionProduct: { Id: 'p', Name: 'Ram Standalone 2' }, ActionIntent: 'Auto Include', TargetFields: null, Sequence: 1 }]);
    if (pathname === '/api/search/v1/objects/Attribute/query') return json([{ Id: 'at-1', Name: 'Internet_Speed_c', DisplayName: 'Internet Speed', Type: 'Picklist' }]);
    if (pathname === '/api/revenue-admin/v1/field-expressions/fe-2') return json({ Id: 'fe-2', Name: 'Speed', IsActive: true, ExpressionType: 'Field Update', UpdateObject: 'LineItem', SourceObject: 'LineItem', UpdateField: 'Attribute.Internet_Speed_c', ConditionScope: 'Product', Product: { Id: 'p', Name: 'Internet Service' }, Expression: "'25 Mbps'" });
    if (pathname === '/api/revenue-admin/v1/field-expressions/fe-1') return json({ Id: 'fe-1', Name: 'Status filter', IsActive: true, ExpressionType: 'Field Update', EvaluationContext: 'Record Update', UpdateObject: 'Agreement', SourceObject: 'Agreement', UpdateField: 'Stage', ConditionExpression: '$.Status == "Active"', Expression: "'Open'" });
    if (pathname === '/api/extensibility/v1/servicehooks/rules') return json({ Success: true, Data: [] });
    if (pathname === '/api/extensibility/v1/callbacks/modules/Revenue') return json({ Success: true, Data: [], StatusCode: 'OK' });
    if (pathname === '/api/extensibility/v1/customcode/api-resource') return json([]);
    if (pathname === '/api/extensibility/v1/customcode') return json([{ Name: 'ZipProject' }]);
    if (pathname === '/api/extensibility/v1/customcode/ZipProject') return json({ Data: { Name: 'ZipProject', Documents: [] } });
    if (pathname === '/api/extensibility/v1/customcode/ZipProject/download') {
      return new Response(zip({ 'ZipProject/Renewals.cs': 'class Renewals {\n  void Run(dynamic rec) {\n    var s = rec["Agreement.Status"];\n  }\n}\n' }), { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }
    return json({ Message: 'Not found' }, 404);
  };
  return { impl, seen };
}

test('the built extension core runs the full flow in-page against the tenant', async () => {
  const { createApi } = await import(pathToFileURL(join(outDir, 'core', 'api.js')).href);
  const tenant = tenantFetch();
  const api = createApi({ runtime: 'extension', env: {}, fetchImpl: tenant.impl, linkTemplates: { workflow: '{platformUrl}/workflow/{id}/', customCode: '{platformUrl}/cc/{name}' } });
  const connection = { platformUrl: 'https://rls.congacloud.com', bearerToken: 'Bearer test-token' };

  const config = await api.handle({ method: 'GET', pathname: '/api/config' });
  assert.equal(config.status, 200); assert.equal(config.body.runtime, 'extension'); assert.equal(config.body.storage, 'none');

  const validation = await api.handle({ method: 'POST', pathname: '/api/platform/validate', body: connection });
  assert.deepEqual(validation, { status: 200, body: { valid: true, platformUrl: 'https://rls.congacloud.com', hasUserContext: false, organizationName: 'Extension Test Org' } });

  const fields = await api.handle({ method: 'POST', pathname: '/api/platform/fields/search', body: { ...connection, objectName: 'Agreement', query: 'stat' } });
  assert.equal(fields.body.totalMatches, 2);

  const scan = await api.handle({ method: 'POST', pathname: '/api/platform/usage-scan', body: { ...connection, objectName: 'Agreement', fieldName: 'Status' } });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body.formulaDependencies.map((item) => item.fieldName), ['StatusLabel']);
  assert.deepEqual(scan.body.fieldExpressions.map((item) => [item.expressionName, item.usage, item.viewUrl]), [['Status filter', 'Condition', 'https://rls.congacloud.com/cadmin/field-expression/fe-1']]);
  assert.equal(scan.body.customCode.length, 1, 'ZIP fallback is decompressed in-page');
  assert.deepEqual(scan.body.constraintRules.map((item) => [item.ruleName, item.usage, item.confidence, item.viewUrl]), [['Status rule', 'Condition', 'Exact', 'https://rls.congacloud.com/cadmin/constraint-rules/edit/cr-1']]);

  const attributes = await api.handle({ method: 'POST', pathname: '/api/platform/fields/search', body: { ...connection, objectName: 'Attribute', kind: 'attribute', query: 'speed' } });
  assert.deepEqual(attributes.body.items.map((item) => item.name), ['Internet_Speed_c']);
  const attributeScan = await api.handle({ method: 'POST', pathname: '/api/platform/usage-scan', body: { ...connection, objectName: 'Attribute', kind: 'attribute', fieldName: 'Internet_Speed_c' } });
  assert.deepEqual(attributeScan.body.fieldExpressions.map((item) => [item.expressionName, item.usage, item.confidence]), [['Speed', 'Field update', 'Exact']]);
  assert.deepEqual(attributeScan.body.attributeConstraintRules.map((item) => [item.ruleName, item.usage, item.confidence, item.viewUrl]), [['Ram Test', 'Condition', 'Exact', 'https://rls.congacloud.com/cadmin/attribute-based-constraint-rules/edit/acr-1']]);
  assert.equal(scan.body.customCode[0].confidence, 'Exact');
  assert.equal(scan.body.customCode[0].viewUrl, 'https://rls.congacloud.com/cc/ZipProject');
  assert.ok(tenant.seen.every((call) => call.auth === 'Bearer test-token' && call.redirect === 'error'));
});

test('the extension core keeps the host allowlist and reports errors like the server', async () => {
  const { createApi } = await import(pathToFileURL(join(outDir, 'core', 'api.js')).href);
  const api = createApi({ runtime: 'extension', env: {}, fetchImpl: tenantFetch().impl, platformUrlOptions: { allowedHosts: ['gateway.example.internal'] } });
  const blocked = await api.handle({ method: 'POST', pathname: '/api/platform/validate', body: { platformUrl: 'https://evil.example.com', bearerToken: 't' } });
  assert.equal(blocked.status, 400); assert.match(blocked.body.error, /allowlist/);
  const gateway = await api.handle({ method: 'POST', pathname: '/api/platform/validate', body: { platformUrl: 'https://gateway.example.internal', bearerToken: 't' } });
  assert.equal(gateway.status, 200);
  const missing = await api.handle({ method: 'GET', pathname: '/api/nope' });
  assert.equal(missing.status, 404);
});
