// Standalone (local Node.js) host. Only this file may use Node APIs; the API itself
// lives in api.js so the Chrome extension runs exactly the same code in the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CongaApiError } from './congaClient.js';
import { createApi } from './api.js';

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

export function createAppServer({ fetchImpl = fetch, platformUrlOptions = {}, linkTemplates, env = process.env } = {}) {
  const api = createApi({ fetchImpl, platformUrlOptions, linkTemplates, env, runtime: 'standalone' });
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (api.isApiPath(url.pathname)) {
        const body = request.method === 'POST' ? await readJson(request) : undefined;
        const result = await api.handle({ method: request.method, pathname: url.pathname, body });
        return send(response, result.status, result.body);
      }
      return serveStatic(url.pathname, response);
    } catch (error) {
      console.error(error.name, error.message);
      const status = error instanceof CongaApiError ? error.status : 500;
      return send(response, status, { error: error instanceof Error ? error.message : 'Unexpected server error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile?.(); } catch { /* .env is optional */ }
  const port = Number(process.env.PORT ?? 4100);
  createAppServer().listen(port, () => console.log(`Conga Field Usage Analyzer running at http://localhost:${port}`));
}
