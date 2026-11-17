import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CongaApiError, CongaClient, normalizeBearerToken } from './congaClient.js';
import { normalizePlatformUrl, publicUrlPolicy } from './platformUrl.js';
import { scanFieldUsage } from './usageScanner.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = normalize(join(here, '..', 'public'));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Expires: '0', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" };
}
function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), ...headers });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}
async function readJson(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 32_768) throw new CongaApiError('Request body too large', 413); }
  try { return text ? JSON.parse(text) : {}; } catch { throw new CongaApiError('Invalid JSON body', 400); }
}
async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = normalize(join(publicDir, relative));
  if (!target.startsWith(publicDir)) return send(response, 403, { error: 'Forbidden' });
  try { const content = await readFile(target); response.writeHead(200, securityHeaders(mime[extname(target)] ?? 'application/octet-stream')); response.end(content); }
  catch { send(response, 404, { error: 'Not found' }); }
}
function clientFromInput(input, fetchImpl, platformUrlOptions) {
  const platformUrl = normalizePlatformUrl(input.platformUrl, platformUrlOptions);
  const accessToken = normalizeBearerToken(input.bearerToken);
  const userId = typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : undefined;
  if (userId && !/^[A-Za-z0-9_-]{1,200}$/.test(userId)) throw new CongaApiError('Platform user ID is invalid', 400);
  return { client: new CongaClient({ platformUrl, accessToken, userId }, fetchImpl), platformUrl, hasUserContext: Boolean(userId) };
}

export function createAppServer({ fetchImpl = fetch, platformUrlOptions = {} } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/health' && request.method === 'GET') return send(response, 200, { status: 'ok', storage: 'stateless' });
      if (url.pathname === '/api/config' && request.method === 'GET') return send(response, 200, { authMode: 'bearer-token', storage: 'none', urlPolicy: publicUrlPolicy() });
      if (url.pathname === '/api/platform/validate' && request.method === 'POST') {
        const input = await readJson(request);
        const connection = clientFromInput(input, fetchImpl, platformUrlOptions);
        await connection.client.validateConnection();
        return send(response, 200, { valid: true, platformUrl: connection.platformUrl, hasUserContext: connection.hasUserContext });
      }
      if (url.pathname === '/api/platform/objects/search' && request.method === 'POST') {
        const input = await readJson(request);
        const { client } = clientFromInput(input, fetchImpl, platformUrlOptions);
        return send(response, 200, await client.searchObjects(String(input.query ?? ''), input.limit));
      }
      if (url.pathname === '/api/platform/fields/search' && request.method === 'POST') {
        const input = await readJson(request);
        const { client } = clientFromInput(input, fetchImpl, platformUrlOptions);
        return send(response, 200, await client.searchFields(input.objectName, String(input.query ?? ''), input.limit));
      }
      if (url.pathname === '/api/platform/usage-scan' && request.method === 'POST') {
        const input = await readJson(request);
        const { client } = clientFromInput(input, fetchImpl, platformUrlOptions);
        return send(response, 200, await scanFieldUsage(client, input.objectName, input.fieldName));
      }
      if (url.pathname.startsWith('/api/')) return send(response, 404, { error: 'API route not found' });
      return serveStatic(url.pathname, response);
    } catch (error) {
      console.error(error.name, error.message);
      const status = error instanceof CongaApiError ? error.status : 500;
      return send(response, status, { error: error instanceof Error ? error.message : 'Unexpected server error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4100);
  createAppServer().listen(port, () => console.log(`Conga Field Usage Analyzer running at http://localhost:${port}`));
}
