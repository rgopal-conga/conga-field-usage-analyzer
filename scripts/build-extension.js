// Builds the Chrome extension (Manifest V3) from the same source the standalone site uses.
//
//   npm run build:extension            -> dist/extension  (load it with "Load unpacked")
//   node scripts/build-extension.js <outDir>
//
// Layout of the build:
//   public/*                    -> <out>/            (the UI, unchanged)
//   server/*.js except index.js -> <out>/core/       (API router + scanners, run in the page)
//   extension/background.js     -> <out>/background.js
//   generated                   -> manifest.json, extension-config.js, icons/*.png
//
// The build fails if a shared module uses a Node-only API, so a change that would break
// the extension is caught by `npm run check` before it is committed.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { configuredAllowedHosts } from '../server/platformUrl.js';
import { referenceLinkTemplates } from '../server/referenceLinks.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Conga brand kit, Purple 300 (also the app's --accent colour in public/styles.css).
export const ICON_COLOR = [0x80, 0x6c, 0xf0];
export const ICON_SIZES = [16, 32, 48, 128];
const SERVER_ONLY = new Set(['index.js']);

// ---- browser-safety guard -------------------------------------------------------------
const forbidden = [
  [/\bfrom\s+['"]node:|\bimport\(\s*['"]node:|\brequire\(/, 'imports a Node.js module'],
  [/\bBuffer\s*[.(]/, 'uses Buffer (use Uint8Array / TextDecoder)'],
  [/(?<![\w.?])process\s*[.[]/, 'uses process directly (use globalThis.process?.env ?? {} or pass options)'],
  [/\b(localStorage|sessionStorage|indexedDB|chrome\.storage)\b|document\.cookie/, 'uses persistent storage']
];
export function browserSafetyProblems(fileName, source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return forbidden.filter(([pattern]) => pattern.test(code)).map(([, message]) => `${fileName} ${message}`);
}

// ---- PNG icon (solid circle, anti-aliased, transparent background) --------------------
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function circleIconPng(size, [r, g, b] = ICON_COLOR) {
  const samples = 4; const center = size / 2; const radius = size / 2 - Math.max(0.5, size / 64);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      for (let sy = 0; sy < samples; sy += 1) for (let sx = 0; sx < samples; sx += 1) {
        const dx = x + (sx + 0.5) / samples - center; const dy = y + (sy + 0.5) / samples - center;
        if (dx * dx + dy * dy <= radius * radius) inside += 1;
      }
      const at = y * (size * 4 + 1) + 1 + x * 4;
      rows[at] = r; rows[at + 1] = g; rows[at + 2] = b; rows[at + 3] = Math.round((inside / (samples * samples)) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- build ------------------------------------------------------------------------------
export async function buildExtension({ outDir = join(root, 'dist', 'extension'), env = process.env } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const base = JSON.parse(await readFile(join(root, 'extension', 'manifest.base.json'), 'utf8'));

  const shared = (await readdir(join(root, 'server'))).filter((name) => name.endsWith('.js') && !SERVER_ONLY.has(name));
  const problems = [];
  for (const name of shared) problems.push(...browserSafetyProblems(`server/${name}`, await readFile(join(root, 'server', name), 'utf8')));
  problems.push(...browserSafetyProblems('public/app.js', await readFile(join(root, 'public', 'app.js'), 'utf8')));
  if (problems.length) throw new Error(`Extension build failed; shared code must stay browser-safe:\n - ${problems.join('\n - ')}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'core'), { recursive: true });
  await mkdir(join(outDir, 'icons'), { recursive: true });
  await cp(join(root, 'public'), outDir, { recursive: true });
  for (const name of shared) await cp(join(root, 'server', name), join(outDir, 'core', name));
  await cp(join(root, 'extension', 'background.js'), join(outDir, 'background.js'));

  const extraHosts = configuredAllowedHosts(env);
  const config = { allowedHosts: extraHosts, linkTemplates: referenceLinkTemplates(env) };
  await writeFile(join(outDir, 'extension-config.js'), `// Generated by scripts/build-extension.js from .env / environment at build time. Do not edit.\nexport default ${JSON.stringify(config, null, 2)};\n`);

  const icons = {};
  for (const size of ICON_SIZES) { await writeFile(join(outDir, 'icons', `icon-${size}.png`), circleIconPng(size)); icons[size] = `icons/icon-${size}.png`; }

  const hostPermissions = [...base.host_permissions, ...extraHosts.map((host) => `https://${host}/*`)];
  const connectSrc = [...new Set(hostPermissions.map((pattern) => pattern.replace(/\/\*$/, '')))].join(' ');
  const manifest = {
    ...base,
    version: pkg.version,
    icons,
    action: { ...base.action, default_icon: icons },
    host_permissions: hostPermissions,
    content_security_policy: { extension_pages: base.content_security_policy.extension_pages.replace(/connect-src [^;]*/, `connect-src ${connectSrc}`) }
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, manifest, sharedModules: shared };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile?.(); } catch { /* .env is optional */ }
  const outDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
  buildExtension({ outDir }).then(({ outDir: dir, manifest }) => {
    console.log(`Built ${manifest.name} ${manifest.version} -> ${dir}`);
    console.log('Load it in Chrome: chrome://extensions > Developer mode > Load unpacked > select that folder.');
  }).catch((error) => { console.error(error.message); process.exit(1); });
}
