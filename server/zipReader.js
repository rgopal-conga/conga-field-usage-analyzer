// Minimal in-memory ZIP reader for custom code project downloads
// (GET /api/extensibility/v1/customcode/{projectName}/download). Supports stored and
// deflated entries, which is what .NET's ZipArchive writes. Nothing is written to disk.
// Browser-safe: uses Uint8Array/DataView and the web DecompressionStream, so the same
// code runs in Node.js 20+ and in the Chrome extension.
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

function toBytes(input) {
  if (input instanceof Uint8Array) return input; // includes Node Buffers
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('Not a ZIP archive');
}

function findEndOfCentralDirectory(view) {
  const stop = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= stop; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

// Inflates raw DEFLATE data, refusing output larger than MAX_ENTRY_BYTES.
async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ENTRY_BYTES) { await reader.cancel(); throw new Error('ZIP entry too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) { out.set(chunk, position); position += chunk.byteLength; }
  return out;
}

// Returns [{ path, text }] for every file entry that decodes as UTF-8 text.
export async function readZipTextEntries(input, accept = () => true) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder('utf-8');
  const eocd = view.byteLength >= 22 ? findEndOfCentralDirectory(view) : -1;
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new Error('Corrupt ZIP central directory');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/') || size > MAX_ENTRY_BYTES || !accept(path)) continue;
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) continue;
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else continue;
    if (data.includes(0)) continue; // binary
    entries.push({ path, text: utf8.decode(data).replace(/^\uFEFF/, '') });
  }
  return entries;
}
