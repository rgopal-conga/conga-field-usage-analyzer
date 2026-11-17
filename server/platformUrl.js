import { CongaApiError } from './congaClient.js';

const officialExactHosts = new Set([
  'rls.congacloud.com',
  'rls.congacloud.eu',
  'rls.congacloud.au',
  'rls-preview.congacloud.eu',
  'rls-preview.congacloud.au'
]);
const officialHostPatterns = [
  /^prod-rls\d+\.congacloud\.com$/,
  /^preview-rls\d+\.congacloud\.com$/
];

export function configuredAllowedHosts(env = process.env) {
  return (env.CONGA_ALLOWED_PLATFORM_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

function isAllowedHost(hostname, additionalHosts) {
  return officialExactHosts.has(hostname) ||
    officialHostPatterns.some((pattern) => pattern.test(hostname)) ||
    additionalHosts.includes(hostname);
}

export function normalizePlatformUrl(value, options = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new CongaApiError('Platform URL is required', 400);
  if (value.length > 2048) throw new CongaApiError('Platform URL is too large', 400);
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new CongaApiError('Platform URL is invalid', 400); }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const additionalHosts = [...configuredAllowedHosts(), ...(options.allowedHosts ?? [])]
    .map((host) => host.toLowerCase().replace(/\.$/, ''));
  const allowInsecureForTests = options.allowInsecureForTests === true && additionalHosts.includes(hostname);
  if (url.protocol !== 'https:' && !(allowInsecureForTests && url.protocol === 'http:')) {
    throw new CongaApiError('Platform URL must use HTTPS', 400);
  }
  if (url.username || url.password) throw new CongaApiError('Platform URL must not contain credentials', 400);
  if (url.search || url.hash) throw new CongaApiError('Platform URL must not contain a query or fragment', 400);
  if (url.pathname !== '/' && url.pathname !== '') throw new CongaApiError('Platform URL must be an origin without a path', 400);
  if (url.port && url.port !== '443' && !(allowInsecureForTests && options.allowAnyPortForTests === true)) {
    throw new CongaApiError('Platform URL must use the standard HTTPS port', 400);
  }

  if (!isAllowedHost(hostname, additionalHosts)) {
    throw new CongaApiError('Platform URL host is not in the approved Conga allowlist', 400);
  }

  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${hostname}${port}`;
}

export function publicUrlPolicy(env = process.env) {
  return {
    suggestedUrls: [
      'https://rls.congacloud.com',
      'https://rls.congacloud.eu',
      'https://rls.congacloud.au'
    ],
    additionalHostsConfigured: configuredAllowedHosts(env).length
  };
}
