export class CongaApiError extends Error {
  constructor(message, status = 502, details) {
    super(message);
    this.name = 'CongaApiError';
    this.status = status;
    this.details = details;
  }
}

function pick(object, ...names) {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new CongaApiError('Conga Platform returned a non-JSON response', 502); }
}

function upstreamMessage(payload, fallback) {
  return pick(payload, 'error_description', 'ErrorDescription', 'message', 'Message', 'error', 'Error') ||
    pick(payload?.Errors?.[0], 'Message', 'message') || fallback;
}

export function normalizeBearerToken(value) {
  if (typeof value !== 'string') throw new CongaApiError('Bearer token is required', 400);
  const token = value.trim().replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new CongaApiError('Bearer token is required', 400);
  if (/\s/.test(token)) throw new CongaApiError('Bearer token must not contain whitespace', 400);
  if (token.length > 16_384) throw new CongaApiError('Bearer token is too large', 400);
  return token;
}

export class CongaClient {
  constructor({ platformUrl, accessToken, userId }, fetchImpl = fetch) {
    this.platformUrl = platformUrl;
    this.accessToken = accessToken;
    this.userId = userId;
    this.fetchImpl = fetchImpl;
  }

  async request(path, query = {}, { method = 'GET', body } = {}) {
    const url = new URL(path, `${this.platformUrl}/`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers = { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` };
    if (this.userId) headers['user-id'] = this.userId;
    const init = { method, headers, redirect: 'error', cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await this.fetchImpl(url, init);
    const payload = await parseResponse(response);
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? response.status : 502;
      throw new CongaApiError(upstreamMessage(payload, `Conga Platform request failed (${response.status})`), status);
    }
    const success = pick(payload, 'Success', 'success');
    if (success === false) throw new CongaApiError(upstreamMessage(payload, 'Conga Platform reported an unsuccessful response'), 502);
    return payload;
  }

  async validateConnection() {
    await this.request('/api/metadata/v1/objects', { pageSize: 1, pageNumber: 1 });
  }

  // Org display name from /api/user-management/v1/organization/info. The response shape is not
  // documented here, so common envelope/key spellings are tried; null when none is present.
  async getOrganizationName() {
    const payload = await this.request('/api/user-management/v1/organization/info');
    const data = pick(payload, 'Data', 'data') ?? payload;
    const org = pick(data, 'Organization', 'organization') ?? data;
    for (const source of [org, data, payload]) {
      const name = pick(source, 'OrganizationName', 'organizationName', 'OrgName', 'orgName', 'DisplayName', 'displayName', 'Name', 'name');
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
    return null;
  }

  async listObjects() {
    const all = [];
    const pageSize = 200;
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const payload = await this.request('/api/metadata/v1/objects', { pageSize, pageNumber, sortField: 'Name', sortDirection: 'Ascending' });
      const data = pick(payload, 'Data', 'data') ?? [];
      if (!Array.isArray(data)) throw new CongaApiError('Unexpected object metadata response shape', 502);
      all.push(...data.map((item) => ({
        name: pick(item, 'Name', 'name') ?? '',
        label: pick(item, 'DisplayName', 'displayName') || pick(item, 'Name', 'name') || '',
        description: pick(item, 'Description', 'description') ?? '',
        category: pick(item, 'Category', 'category') ?? '',
        objectType: pick(item, 'ObjectType', 'objectType') ?? '',
        protected: Boolean(pick(item, 'IsProtected', 'isProtected')),
        deprecated: Boolean(pick(item, 'IsDeprecated', 'isDeprecated'))
      })).filter((item) => item.name));
      // Some environments omit HasMoreRecords; a full page then means there may be more.
      const explicitHasMore = pick(payload, 'HasMoreRecords', 'hasMoreRecords');
      const hasMore = explicitHasMore === undefined ? data.length >= pageSize : Boolean(explicitHasMore);
      if (!hasMore || data.length === 0) break;
      if (pageNumber === 100) throw new CongaApiError('Object metadata exceeded the 100-page safety limit', 502);
    }
    return all;
  }

  async searchObjects(query = '', limit = 50) {
    const normalizedQuery = query.trim().toLowerCase();
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const objects = await this.listObjects();
    const matches = objects.filter((item) => !normalizedQuery ||
      item.name.toLowerCase().includes(normalizedQuery) ||
      item.label.toLowerCase().includes(normalizedQuery));
    matches.sort((left, right) => {
      const leftStarts = left.label.toLowerCase().startsWith(normalizedQuery) || left.name.toLowerCase().startsWith(normalizedQuery);
      const rightStarts = right.label.toLowerCase().startsWith(normalizedQuery) || right.name.toLowerCase().startsWith(normalizedQuery);
      return Number(rightStarts) - Number(leftStarts) || left.label.localeCompare(right.label) || left.name.localeCompare(right.name);
    });
    return { items: matches.slice(0, safeLimit), totalMatches: matches.length, totalScanned: objects.length };
  }

  async getObjectFields(objectName) {
    if (typeof objectName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(objectName)) throw new CongaApiError('Object name is invalid', 400);
    const payload = await this.request(`/api/schema/v1/objects/${encodeURIComponent(objectName)}`);
    const object = pick(payload, 'Data', 'data');
    if (!object || typeof object !== 'object') throw new CongaApiError('Unexpected object schema response shape', 502);
    const metadata = pick(object, 'FieldMetadata', 'fieldMetadata') ?? [];
    if (!Array.isArray(metadata)) throw new CongaApiError('Unexpected field metadata response shape', 502);
    return metadata.map((field) => ({
      id: pick(field, 'Id', 'id') ?? null,
      name: pick(field, 'FieldName', 'fieldName') ?? '',
      label: pick(field, 'DisplayName', 'displayName') || pick(field, 'FieldName', 'fieldName') || '',
      description: pick(field, 'Description', 'description') ?? '',
      type: pick(field, 'DataType', 'dataType') ?? 'Unknown',
      required: Boolean(pick(field, 'IsRequired', 'isRequired')),
      protected: Boolean(pick(field, 'IsProtected', 'isProtected')),
      deprecated: Boolean(pick(field, 'IsDeprecated', 'isDeprecated')),
      calculated: Boolean(pick(field, 'IsCalculated', 'isCalculated')),
      internal: Boolean(pick(field, 'IsInternalField', 'isInternalField')),
      readAccess: pick(field, 'ReadAccess', 'readAccess') ?? null,
      writeAccess: pick(field, 'WriteAccess', 'writeAccess') ?? null,
      lookupObjectName: pick(field, 'LookupObjectName', 'lookupObjectName') ?? null,
      expression: pick(field, 'Expression', 'expression') ?? null,
      expressionDependencies: pick(field, 'ExpressionDependency', 'expressionDependency') ?? []
    })).filter((field) => field.name);
  }

  async searchFields(objectName, query = '', limit = 50) {
    const normalizedQuery = query.trim().toLowerCase();
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const fields = await this.getObjectFields(objectName);
    const matches = fields.filter((item) => !normalizedQuery ||
      item.name.toLowerCase().includes(normalizedQuery) ||
      item.label.toLowerCase().includes(normalizedQuery) ||
      item.type.toLowerCase().includes(normalizedQuery));
    matches.sort((left, right) => {
      const leftStarts = left.label.toLowerCase().startsWith(normalizedQuery) || left.name.toLowerCase().startsWith(normalizedQuery);
      const rightStarts = right.label.toLowerCase().startsWith(normalizedQuery) || right.name.toLowerCase().startsWith(normalizedQuery);
      return Number(rightStarts) - Number(leftStarts) || left.label.localeCompare(right.label) || left.name.localeCompare(right.name);
    });
    return { items: matches.slice(0, safeLimit), totalMatches: matches.length, totalScanned: fields.length };
  }

  async getFieldDependencies(objectName, fieldName) {
    if (typeof objectName !== 'string' || typeof fieldName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(objectName) || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(fieldName)) {
      throw new CongaApiError('Object or field name is invalid', 400);
    }
    const payload = await this.request(`/api/metadata/v1/objects/${encodeURIComponent(objectName)}/fields/${encodeURIComponent(fieldName)}/dependency-fields`);
    return pick(payload, 'Data', 'data') ?? [];
  }

  async listWorkflowDefinitions() {
    const all = [];
    const limit = 200;
    for (let page = 0; page < 100; page += 1) {
      const payload = await this.request('/api/workflow/v1/query/WorkflowDefinition', { IncludeTotalCount: true }, {
        method: 'POST',
        body: {
          ObjectName: 'WorkflowDefinition',
          Criteria: 'IsLatest=true',
          Skip: page * limit,
          Limit: limit,
          Select: ['Id', 'DefinitionId', 'Name', 'DisplayName', 'Version', 'TriggerType', 'IsPublished', 'IsLatest', 'ObjectName', 'WorkflowType', 'IsOOTB', 'ModifiedDate'],
          Sort: { FieldName: 'Name', OrderBy: 'Ascending' }
        }
      });
      const data = Array.isArray(payload) ? payload : pick(payload, 'Data', 'data', 'Records', 'records', 'Items', 'items') ?? [];
      if (!Array.isArray(data)) throw new CongaApiError('Unexpected workflow query response shape', 502);
      all.push(...data);
      const total = Array.isArray(payload) ? undefined : pick(payload, 'TotalCount', 'totalCount');
      if (data.length < limit || (typeof total === 'number' && all.length >= total)) break;
      if (page === 99) throw new CongaApiError('Workflow definitions exceeded the 100-page safety limit', 502);
    }
    return all;
  }

  async getWorkflowDefinition(definitionId) {
    if (typeof definitionId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(definitionId)) throw new CongaApiError('Workflow definition id is invalid', 400);
    const payload = await this.request(`/api/workflow/v1/workflow-definitions/${encodeURIComponent(definitionId)}/Latest`);
    const definition = pick(payload, 'Data', 'data') ?? payload;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new CongaApiError('Unexpected workflow definition response shape', 502);
    return definition;
  }

  async listServiceHooks() {
    const all = [];
    const pageSize = 200;
    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      const payload = await this.request('/api/extensibility/v1/servicehooks/rules', {
        pageSize, pageNumber, sortField: 'Name', sortDirection: 'Ascending'
      });
      const data = pick(payload, 'Data', 'data') ?? [];
      if (!Array.isArray(data)) throw new CongaApiError('Unexpected Service Hooks response shape', 502);
      all.push(...data);
      const explicitHasMore = pick(payload, 'HasMoreRecords', 'hasMoreRecords');
      if (explicitHasMore === false || data.length < pageSize || data.length === 0) break;
      if (pageNumber === 100) throw new CongaApiError('Service Hooks exceeded the 100-page safety limit', 502);
    }
    return all;
  }

  // Raw (non-JSON) GET, used for custom code project ZIP downloads. Same headers and redirect policy as request().
  async requestBinary(path) {
    const url = new URL(path, `${this.platformUrl}/`);
    const headers = { Accept: 'application/octet-stream, application/zip, application/json' };
    headers.Authorization = ['Bearer', this.accessToken].join(' ');
    if (this.userId) headers['user-id'] = this.userId;
    const response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', cache: 'no-store' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      let payload = {};
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* not JSON */ }
      const status = response.status === 401 || response.status === 403 ? response.status : 502;
      throw new CongaApiError(upstreamMessage(payload, `Conga Platform request failed (${response.status})`), status);
    }
    return bytes;
  }

  // GET /api/extensibility/v1/customcode — every custom code project (CSharpProjectInfo). Documents may be omitted here.
  async listCustomCodeProjects() {
    const payload = await this.request('/api/extensibility/v1/customcode');
    const data = Array.isArray(payload) ? payload : pick(payload, 'Data', 'data') ?? [];
    if (!Array.isArray(data)) throw new CongaApiError('Unexpected custom code list response shape', 502);
    return data;
  }

  static assertProjectName(projectName) {
    if (typeof projectName !== 'string' || !/^[A-Za-z0-9_.\- ]{1,200}$/.test(projectName)) throw new CongaApiError('Custom code project name is invalid', 400);
  }

  // GET /api/extensibility/v1/customcode/{name} — one project including Documents[{ Name, FilePath, SourceCode }].
  async getCustomCodeProject(projectName) {
    CongaClient.assertProjectName(projectName);
    const payload = await this.request(`/api/extensibility/v1/customcode/${encodeURIComponent(projectName)}`);
    const data = pick(payload, 'Data', 'data') ?? payload;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CongaApiError('Unexpected custom code project response shape', 502);
    return data;
  }

  // GET /api/extensibility/v1/customcode/{projectName}/download — the project as a ZIP (fallback when Documents is empty).
  async downloadCustomCodeProject(projectName) {
    CongaClient.assertProjectName(projectName);
    return this.requestBinary(`/api/extensibility/v1/customcode/${encodeURIComponent(projectName)}/download`);
  }

  // GET /api/extensibility/v1/callbacks — callback contracts and the project/class mapped to each.
  async listCallbackContracts() {
    const payload = await this.request('/api/extensibility/v1/callbacks');
    const data = Array.isArray(payload) ? payload : pick(payload, 'Data', 'data') ?? [];
    if (!Array.isArray(data)) throw new CongaApiError('Unexpected callback response shape', 502);
    return data;
  }

  // GET /api/extensibility/v1/customcode/api-resource and .../{name}/uri-entries — Custom API routes mapped to project methods.
  async listCustomApiRoutes() {
    const payload = await this.request('/api/extensibility/v1/customcode/api-resource');
    const resources = Array.isArray(payload) ? payload : pick(payload, 'Data', 'data') ?? [];
    if (!Array.isArray(resources)) throw new CongaApiError('Unexpected API resource response shape', 502);
    const routes = [];
    for (const resource of resources) {
      const name = pick(resource, 'Name', 'name', 'ResourceName');
      if (typeof name !== 'string' || !name) continue;
      const entriesPayload = await this.request(`/api/extensibility/v1/customcode/api-resource/${encodeURIComponent(name)}/uri-entries`);
      const data = pick(entriesPayload, 'Data', 'data') ?? {};
      const entries = Array.isArray(data) ? data : pick(data, 'RouteEntries', 'routeEntries') ?? [];
      for (const entry of Array.isArray(entries) ? entries : []) routes.push({ resourceName: name, defaultVerb: pick(data, 'HttpVerb', 'httpVerb') ?? null, ...entry });
    }
    return routes;
  }
}
