import { decompress, proxyUrl, MAX_SDIST_BYTES } from './net.js';
import { textDecoder } from './util.js';

export async function fetchAndParseTarGz(url, progressCb) {
  const resp = await fetch(await proxyUrl(url));
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const totalSize = parseInt(resp.headers.get('Content-Length'), 10) || 0;

  // Stream the download so we can report progress
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (progressCb && totalSize) progressCb(received / totalSize);
  }
  const compressed = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { compressed.set(c, offset); offset += c.length; }

  // Decompress gzip
  const tarData = await decompress(compressed, 'gzip', MAX_SDIST_BYTES);

  // Parse tar
  return parseTar(tarData);
}

// The listing has to match what Python's tarfile extracts, or a package could
// show one thing here and install another. Constructs this parser does not
// model throw, so a mismatch is an error and never a quiet difference.

const NO_DATA_TYPES = new Set(['1', '2', '3', '4', '5', '6']); // links, devices, directory, fifo
const blocks = size => Math.ceil(size / 512) * 512;

// A NUL-terminated header string
function cstr(bytes) {
  const end = bytes.indexOf(0);
  return textDecoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

// Octal header number. Base-256 and signed values are rejected.
function octal(bytes, what) {
  const digits = cstr(bytes).trim();
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) throw new Error(`Unsupported tar ${what} field`);
  return parseInt(digits, 8);
}

function checkChecksum(header) {
  let unsigned = 0, signed = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  const stored = octal(header.subarray(148, 156), 'checksum');
  if (stored !== unsigned && stored !== signed) throw new Error('Invalid tar header checksum');
}

// pax records are "<length> <key>=<value>\n", where length counts the whole
// record. Reading by length keeps a newline inside a value from starting a
// forged record. A later record for the same key wins.
function paxRecords(data) {
  const records = new Map();
  let pos = 0;
  while (pos < data.length && data[pos] !== 0) {
    const space = data.indexOf(0x20, pos);
    const digits = space < 0 ? '' : textDecoder.decode(data.subarray(pos, space));
    const length = /^\d+$/.test(digits) ? Number(digits) : 0;
    const end = pos + length;
    if (length <= digits.length + 1 || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error('Malformed pax header');
    }
    const record = data.subarray(space + 1, end - 1);
    const eq = record.indexOf(0x3d);
    if (eq < 0) throw new Error('Malformed pax header');
    records.set(textDecoder.decode(record.subarray(0, eq)), textDecoder.decode(record.subarray(eq + 1)));
    pos = end;
  }
  return records;
}

export function parseTar(buf) {
  const entries = [];
  const encoder = new TextEncoder();
  let pos = 0;
  let pending = {}; // name and size overrides for the next member: pax, longName, longLink

  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every(byte => byte === 0)) break; // end of archive
    checkChecksum(header);

    const name = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    let size = octal(header.subarray(124, 136), 'size');
    const typeFlag = String.fromCharCode(header[156]);
    pos += 512;
    if (pos + size > buf.length) throw new Error('Tar entry runs past the end of the archive');
    const data = buf.subarray(pos, pos + size);

    if (typeFlag === 'x' || typeFlag === 'X' || typeFlag === 'g') {
      const records = paxRecords(data);
      if ([...records.keys()].some(key => key.startsWith('GNU.sparse'))) {
        throw new Error('Sparse tar entries are not supported');
      }
      if (typeFlag === 'g') {
        if (['path', 'linkpath', 'size'].some(key => records.has(key))) {
          throw new Error('Global pax headers that rename or resize entries are not supported');
        }
      } else {
        if (pending.pax) throw new Error('Consecutive pax headers are not supported');
        pending.pax = records;
      }
      pos += blocks(size);
      continue;
    }
    if (typeFlag === 'L' || typeFlag === 'K') {
      pending[typeFlag === 'L' ? 'longName' : 'longLink'] = cstr(data);
      pos += blocks(size);
      continue;
    }
    if (typeFlag === 'S') throw new Error('Sparse tar entries are not supported');

    const { pax, longName, longLink } = pending;
    pending = {};
    if (pax?.has('path') && longName != null) {
      throw new Error('Tar entry named by both a pax header and a GNU long name');
    }
    let filename = pax?.get('path') ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    if (pax?.has('size')) {
      if (!/^\d+$/.test(pax.get('size'))) throw new Error('Malformed pax header');
      size = Number(pax.get('size'));
      if (pos + size > buf.length) throw new Error('Tar entry runs past the end of the archive');
    }

    // As in tarfile: an old-style file whose name ends in a slash is a directory
    const type = typeFlag === '\0' && filename.endsWith('/') ? '5' : typeFlag;
    filename = filename.replace(/\/+$/, '');
    let content = null;
    if (type === '1' || type === '2') {
      // Links carry no data. List them, since extraction creates the file.
      const target = pax?.get('linkpath') ?? longLink ?? cstr(header.subarray(157, 257));
      content = encoder.encode(`[${type === '1' ? 'hard link' : 'symbolic link'} to ${target}]\n`);
    } else if (!NO_DATA_TYPES.has(type)) {
      // Regular files ('0', NUL, '7'). tarfile extracts unknown types as files too.
      content = buf.subarray(pos, pos + size);
      pos += blocks(size);
    }
    if (content) {
      entries.push({
        filename,
        uncompressedSize: content.length,
        compressedSize: content.length,
        crc32: 0,
        content,
      });
    }
  }

  return { entries };
}
