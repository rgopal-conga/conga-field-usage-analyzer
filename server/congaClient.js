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

  async request(path, query = {}) {
    const url = new URL(path, `${this.platformUrl}/`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers = { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` };
    if (this.userId) headers['user-id'] = this.userId;
    const response = await this.fetchImpl(url, { headers, redirect: 'error', cache: 'no-store' });
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
}
