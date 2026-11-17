// Transport-independent application API.
//
// Both runtimes call this one router:
//   - standalone site: server/index.js parses the HTTP request and passes it here;
//   - Chrome extension: public/app.js calls it in the page (no HTTP server).
// Keep this file, and every module it imports, browser-safe: no `node:` imports,
// no Buffer, no fs, and no unguarded `process` access. `npm run check` enforces this.
import { CongaApiError, CongaClient, normalizeBearerToken } from './congaClient.js';
import { normalizePlatformUrl, publicUrlPolicy } from './platformUrl.js';
import { scanFieldUsage } from './usageScanner.js';
import { referenceLinkTemplates } from './referenceLinks.js';

function clientFromInput(input, fetchImpl, platformUrlOptions) {
  const platformUrl = normalizePlatformUrl(input.platformUrl, platformUrlOptions);
  const accessToken = normalizeBearerToken(input.bearerToken);
  const userId = typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : undefined;
  if (userId && !/^[A-Za-z0-9_-]{1,200}$/.test(userId)) throw new CongaApiError('Platform user ID is invalid', 400);
  return { client: new CongaClient({ platformUrl, accessToken, userId }, fetchImpl), platformUrl, hasUserContext: Boolean(userId) };
}

// Returns { status, body } and never throws for expected errors.
// options: { fetchImpl, platformUrlOptions, linkTemplates, env, runtime }
export function createApi({ fetchImpl, platformUrlOptions = {}, linkTemplates, env, runtime = 'standalone' } = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const templates = linkTemplates ?? referenceLinkTemplates(env);
  const routes = {
    'GET /health': async () => ({ status: 'ok', storage: 'stateless', runtime }),
    'GET /api/config': async () => ({
      authMode: 'bearer-token', storage: 'none', runtime,
      urlPolicy: publicUrlPolicy(env, platformUrlOptions),
      referenceLinks: { field: Boolean(templates.field), workflow: Boolean(templates.workflow), customCode: Boolean(templates.customCode) }
    }),
    'POST /api/platform/validate': async (input) => {
      const connection = clientFromInput(input, doFetch, platformUrlOptions);
      await connection.client.validateConnection();
      // The org name is display-only: a failing org-info call must not block the connection.
      const organizationName = await connection.client.getOrganizationName().catch(() => null);
      return { valid: true, platformUrl: connection.platformUrl, hasUserContext: connection.hasUserContext, organizationName };
    },
    'POST /api/platform/objects/search': async (input) => {
      const { client } = clientFromInput(input, doFetch, platformUrlOptions);
      return client.searchObjects(String(input.query ?? ''), input.limit);
    },
    'POST /api/platform/fields/search': async (input) => {
      const { client } = clientFromInput(input, doFetch, platformUrlOptions);
      return client.searchFields(input.objectName, String(input.query ?? ''), input.limit);
    },
    'POST /api/platform/usage-scan': async (input) => {
      const { client, platformUrl } = clientFromInput(input, doFetch, platformUrlOptions);
      return scanFieldUsage(client, input.objectName, input.fieldName, { platformUrl, linkTemplates: templates });
    }
  };

  async function handle({ method = 'GET', pathname, body } = {}) {
    const route = routes[`${String(method).toUpperCase()} ${pathname}`];
    if (!route) return { status: 404, body: { error: 'API route not found' } };
    try {
      const input = body && typeof body === 'object' ? body : {};
      return { status: 200, body: await route(input) };
    } catch (error) {
      if (!(error instanceof CongaApiError)) console.error(error?.name, error?.message);
      const status = error instanceof CongaApiError ? error.status : 500;
      return { status, body: { error: error instanceof Error ? error.message : 'Unexpected error' } };
    }
  }

  return { handle, isApiPath: (pathname) => pathname === '/health' || pathname.startsWith('/api/') };
}
