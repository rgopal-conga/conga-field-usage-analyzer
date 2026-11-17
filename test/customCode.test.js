import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { createAppServer } from '../server/index.js';
import { findFieldInSource, lexCSharp } from '../server/customCodeScanner.js';
import { readZipTextEntries } from '../server/zipReader.js';

// --- helpers -------------------------------------------------------------------------------
function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}
function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8'); const compressed = deflateRawSync(data); const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed); centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

// --- mock tenant ---------------------------------------------------------------------------
const hookSource = `using Conga.Platform.Extensibility.CustomCode.Library;
namespace AgreementHooks
{
    // Status handling for agreements. ext_RenewalTerm is mentioned only in this comment.
    public class AgreementStatusHook : CodeExtensibility, IDataChangeServiceHooks
    {
        public async Task OnDataChangeAsync(DataChangeEvent dataChangeEvent, CancellationToken cancellationToken)
        {
            var dbHelper = GetDataHelper();
            var term = dataChangeEvent.NewValue["ext_RenewalTerm"];
            await dbHelper.UpdateAsync("Agreement", new Dictionary<string, object>()
            {
                { "Id", dataChangeEvent.RecordId },
                { "ext_RenewalTerm", 12 }
            });
        }
    }
}`;
const callbackSource = `namespace PricingCallbacks
{
    public class AfterPricing : CodeExtensibility
    {
        public void Run(LineItem item, CancellationToken token)
        {
            var criteria = "Agreement.ext_RenewalTerm > 6";
            item.Set("ext_RenewalTerm", 24);
        }
    }
}`;
const zippedSource = `namespace ApiProject
{
    public class RenewalController : CodeExtensibility
    {
        public Agreement GetRenewal(string id, CancellationToken token)
        {
            var agreement = Load("Agreement", id);
            var value = agreement.GetValue<int>("ext_RenewalTerm");
            agreement.ext_RenewalTerm = value + 1;
            return agreement;
        }
    }
}`;
const unrelatedSource = `namespace Other { public class Noise { public void Run() { var name = "Status"; } } }`;

const projects = {
  AgreementHooks: { Name: 'AgreementHooks', Status: 'Published', Version: 3, Documents: [{ Name: 'AgreementStatusHook.cs', FilePath: 'AgreementHooks/AgreementStatusHook.cs', SourceCode: hookSource }] },
  PricingCallbacks: { Name: 'PricingCallbacks', Status: 'Published', Version: 1, Documents: [{ Name: 'AfterPricing.cs', FilePath: 'AfterPricing.cs', SourceCode: callbackSource }] },
  ApiProject: { Name: 'ApiProject', Status: 'Published', Version: 2, Documents: null, DocumentsBlobReference: 'blob://api' },
  Unrelated: { Name: 'Unrelated', Status: 'Draft', Version: 1, Documents: [{ Name: 'Noise.cs', FilePath: 'Noise.cs', SourceCode: unrelatedSource }] },
  Broken: { Name: 'Broken' }
};
const hooks = [
  { Id: 'hook-1', Name: 'AgreementStatusHook', ObjectName: 'Agreement', IsActive: true, Condition: 'Status == "Activated"', EventTypes: ['Update'], RuleType: 'DataChange',
    CustomCodeDetails: { ProjectName: 'AgreementHooks', ClassName: 'AgreementStatusHook' } }
];
const agreementFields = [
  { Id: 'f1', FieldName: 'Status', DisplayName: 'Status', DataType: 'Picklist' },
  { Id: 'f2', FieldName: 'ext_RenewalTerm', DisplayName: 'Renewal Term', DataType: 'Integer' }
];

let upstream; let app; let upstreamUrl; let baseUrl; let customCodeMode = 'ok'; let hooksMode = 'ok';
const requests = [];
function json(response, status, payload) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); }

before(async () => {
  upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    requests.push(url.pathname);
    if (request.headers.authorization !== ['Bearer', 'valid-token'].join(' ')) return json(response, 401, { Message: 'Missing bearer token' });
    if (url.pathname === '/api/metadata/v1/objects') return json(response, 200, { Success: true, Data: [{ Name: 'Agreement', DisplayName: 'Agreement' }], HasMoreRecords: false });
    if (url.pathname === '/api/schema/v1/objects/Agreement') return json(response, 200, { Success: true, Data: { Name: 'Agreement', FieldMetadata: agreementFields } });
    if (url.pathname === '/api/workflow/v1/query/WorkflowDefinition') return json(response, 200, { Success: true, Data: [], TotalCount: 0 });
    if (url.pathname === '/api/extensibility/v1/servicehooks/rules') return hooksMode === 'fail' ? json(response, 500, { Message: 'Hooks unavailable' }) : json(response, 200, { Success: true, Data: hooks });
    if (url.pathname === '/api/extensibility/v1/customcode') {
      if (customCodeMode === 'fail') return json(response, 500, { Message: 'Extensibility unavailable' });
      return json(response, 200, { Success: true, Data: Object.values(projects).map(({ Name, Status, Version }) => ({ Name, Status, Version })) });
    }
    if (url.pathname === '/api/extensibility/v1/customcode/ApiProject/download') {
      response.writeHead(200, { 'Content-Type': 'application/zip' });
      return response.end(makeZip({ 'ApiProject/RenewalController.cs': zippedSource, 'ApiProject/bin/ApiProject.dll': 'MZ\u0000binary' }));
    }
    const projectMatch = url.pathname.match(/^\/api\/extensibility\/v1\/customcode\/([^/]+)$/);
    if (projectMatch) {
      const name = decodeURIComponent(projectMatch[1]);
      if (name === 'Broken') return json(response, 500, { Message: 'Project storage unavailable' });
      if (projects[name]) return json(response, 200, { Success: true, Data: projects[name] });
    }
    if (url.pathname === '/api/extensibility/v1/callbacks') return json(response, 200, { Success: true, Data: [
      { CallbackName: 'Conga.Cpq.Callbacks.IAfterPricingCallback', CallbackDisplayName: 'After Pricing', CallbackCategoryName: 'Pricing', CustomCodeMapping: { ProjectName: 'PricingCallbacks', ClassName: 'PricingCallbacks.AfterPricing' } },
      { CallbackName: 'Conga.Cpq.Callbacks.IValidationCallback', CallbackDisplayName: 'Validation', CustomCodeMapping: null }
    ] });
    if (url.pathname === '/api/extensibility/v1/customcode/api-resource') return json(response, 200, { Success: true, Data: [{ Name: 'renewals' }] });
    if (url.pathname === '/api/extensibility/v1/customcode/api-resource/renewals/uri-entries') return json(response, 200, { Success: true, Data: { ResourceName: 'renewals', HttpVerb: 'Get', RouteEntries: [
      { Route: '/{id}', HttpVerb: 'Get', CustomCodeName: 'ApiProject', FullyQualifiedClassName: 'ApiProject.RenewalController', MethodName: 'GetRenewal' }
    ] } });
    return json(response, 404, { Message: 'Not found' });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  app = createAppServer({ platformUrlOptions: { allowedHosts: ['127.0.0.1'], allowInsecureForTests: true, allowAnyPortForTests: true }, linkTemplates: { workflow: '{platformUrl}/workflow/{id}/', customCode: '{platformUrl}/admin/custom-code/{name}' } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((resolve) => app.close(resolve)); await new Promise((resolve) => upstream.close(resolve)); });

async function scan(fieldName) {
  const response = await fetch(`${baseUrl}/api/platform/usage-scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platformUrl: upstreamUrl, bearerToken: 'valid-token', objectName: 'Agreement', fieldName }) });
  assert.equal(response.status, 200);
  return response.json();
}

// --- tests ---------------------------------------------------------------------------------
test('custom code scan finds reads and writes across hooks, callbacks and Custom APIs', async () => {
  const result = await scan('ext_RenewalTerm');
  const rows = result.customCode.map((item) => [item.projectName, item.line, item.access, item.confidence]);
  assert.deepEqual(rows, [
    ['AgreementHooks', 10, 'Read', 'Exact'],
    ['AgreementHooks', 14, 'Write', 'Exact'],
    ['ApiProject', 8, 'Read', 'Exact'],
    ['PricingCallbacks', 7, 'Query / criteria', 'Exact'],
    ['PricingCallbacks', 8, 'Write', 'Exact'],
    ['ApiProject', 9, 'Write', 'Probable']
  ]);
  const hook = result.customCode.find((item) => item.projectName === 'AgreementHooks' && item.access === 'Write');
  assert.equal(hook.className, 'AgreementStatusHook'); assert.equal(hook.methodName, 'OnDataChangeAsync');
  assert.deepEqual(hook.runsAs.map((entry) => [entry.type, entry.name, entry.objectName]), [['Service Hook', 'AgreementStatusHook', 'Agreement']]);
  assert.equal(hook.viewUrl, `${upstreamUrl}/admin/custom-code/AgreementHooks`);
  const callback = result.customCode.find((item) => item.projectName === 'PricingCallbacks');
  assert.deepEqual(callback.runsAs.map((entry) => [entry.type, entry.name]), [['Callback', 'After Pricing']]);
  const api = result.customCode.find((item) => item.projectName === 'ApiProject');
  assert.equal(api.source, 'Project download'); assert.equal(api.filePath, 'ApiProject/RenewalController.cs');
  assert.deepEqual(api.runsAs.map((entry) => [entry.type, entry.name]), [['Custom API', 'GET /api/custom-api/v1/renewals/{id}']]);
});

test('custom code coverage reports projects, files and unreadable projects', async () => {
  const result = await scan('ext_RenewalTerm');
  assert.equal(result.coverage.customCodeProjectsScanned, 5);
  assert.equal(result.coverage.customCodeFilesScanned, 4);
  const collector = result.coverage.collectors.find((item) => item.key === 'customCode');
  assert.equal(collector.status, 'partial'); assert.equal(collector.matches, 6);
  assert.ok(result.limitations.some((text) => /1 custom code project\(s\) could not be read.*Broken/.test(text)));
  assert.ok(!result.limitations.some((text) => /custom code was not analyzed/i.test(text)));
});

test('comments and unrelated projects are not reported', async () => {
  const result = await scan('ext_RenewalTerm');
  assert.ok(!result.customCode.some((item) => item.line === 4 && item.projectName === 'AgreementHooks'));
  const status = await scan('Status');
  assert.ok(!status.customCode.some((item) => item.projectName === 'Unrelated' && item.confidence !== 'Possible'));
});

test('a failing custom code API does not break the other collectors', async () => {
  customCodeMode = 'fail';
  try {
    const result = await scan('ext_RenewalTerm');
    assert.deepEqual(result.customCode, []);
    assert.equal(result.coverage.collectors.find((item) => item.key === 'customCode').status, 'failed');
    assert.ok(result.limitations.some((text) => /Custom code scan failed/.test(text)));
    assert.equal(result.coverage.collectors.find((item) => item.key === 'workflows').status, 'complete');
  } finally { customCodeMode = 'ok'; }
});

test('an unreadable Service Hook list only drops the hook wiring', async () => {
  hooksMode = 'fail';
  try {
    const result = await scan('ext_RenewalTerm');
    assert.ok(result.customCode.length > 0);
    assert.ok(result.customCode.every((item) => !(item.runsAs ?? []).some((entry) => entry.type === 'Service Hook')));
    assert.ok(result.limitations.some((text) => /Service Hook rules could not be read/.test(text)));
    assert.equal(result.serviceHooks, undefined);
  } finally { hooksMode = 'ok'; }
});

test('a Service Hook condition naming the field is a Condition entry under Custom code', async () => {
  const result = await scan('Status');
  const condition = result.customCode.find((item) => item.access === 'Condition');
  assert.ok(condition);
  assert.equal(condition.snippet, 'Status == "Activated"'); assert.equal(condition.confidence, 'Exact');
  assert.equal(condition.projectName, 'AgreementHooks'); assert.equal(condition.className, 'AgreementStatusHook');
  assert.deepEqual(condition.runsAs.map((entry) => [entry.type, entry.name, entry.objectName]), [['Service Hook', 'AgreementStatusHook', 'Agreement']]);
  assert.equal(condition.viewUrl, `${upstreamUrl}/admin/custom-code/AgreementHooks`);
  const other = await scan('ext_RenewalTerm');
  assert.ok(!other.customCode.some((item) => item.access === 'Condition'));
});

test('lexer separates strings and comments, including verbatim strings', () => {
  const { code, strings } = lexCSharp('var a = @"x ""y"" z"; // "not a string"\nvar b = "q\\"r"; /* "c" */');
  assert.deepEqual(strings.map((item) => item.value), ['x "y" z', 'q\\"r']);
  assert.doesNotMatch(code, /not a string/); assert.equal(code.split('\n').length, 2);
});

test('source matcher classifies indexer, dictionary, setter and property access', () => {
  const source = [
    'class A {',
    '  void M() {',
    '    var x = rec["Discount"];',
    '    rec["Discount"] = 5;',
    '    item.SetValue("Discount", 1);',
    '    var y = item.GetValue<decimal>("Discount");',
    '    line.Discount = 3;',
    '    if (line.Discount == 3) {}',
    '    var q = "Select Id From LineItem Where Discount > 0";',
    '  }',
    '}'
  ].join('\n');
  const { matches } = findFieldInSource(source, 'LineItem', 'Discount');
  assert.deepEqual(matches.map((item) => [item.line, item.access]), [[3, 'Read'], [4, 'Write'], [5, 'Write'], [6, 'Read'], [7, 'Write'], [8, 'Read'], [9, 'Query / criteria']]);
  assert.ok(matches.every((item) => item.className === 'A' && item.methodName === 'M'));
});

test('zip reader extracts text entries and skips binaries', () => {
  const entries = readZipTextEntries(makeZip({ 'a/One.cs': 'class One {}', 'a/bin/x.dll': 'MZ\u0000' }));
  assert.deepEqual(entries, [{ path: 'a/One.cs', text: 'class One {}' }]);
});
