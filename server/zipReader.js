// Minimal in-memory ZIP reader for custom code project downloads
// (GET /api/extensibility/v1/customcode/{projectName}/download). Supports stored and
// deflated entries, which is what .NET's ZipArchive writes. Nothing is written to disk.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

function findEndOfCentralDirectory(buffer) {
  const stop = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

// Returns [{ path, text }] for every file entry that decodes as UTF-8 text.
export function readZipTextEntries(input, accept = () => true) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('Corrupt ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const path = buffer.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/') || size > MAX_ENTRY_BYTES || !accept(path)) continue;
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) continue;
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    else continue;
    if (data.includes(0)) continue; // binary
    entries.push({ path, text: data.toString('utf8').replace(/^\uFEFF/, '') });
  }
  return entries;
}
