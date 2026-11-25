import { decompress, fetchRange, proxyUrl, MAX_FILE_BYTES } from './net.js';
import { fmtSize, textDecoder } from './util.js';

// The listing has to match what Python's zipfile reads, or a wheel could show
// one file set here and install another. Anything these parsers do not model
// throws.
const isSignature = (bytes, at, b2, b3) =>
  at >= 0 && bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === b2 && bytes[at + 3] === b3;
const zip64Error = () => new Error('ZIP64 archives not yet supported');

// Finds the central directory from the last bytes of the archive. `tailStart`
// is the offset of `tail` within the file.
export function locateCentralDirectory(tail, tailStart) {
  // End of Central Directory record, PK\x05\x06, last one wins
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (isSignature(tail, i, 0x05, 0x06)) { eocdPos = i; break; }
  }
  if (eocdPos === -1) throw new Error('ZIP EOCD not found');

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const totalEntries = view.getUint16(eocdPos + 10, true);
  const cdSize = view.getUint32(eocdPos + 12, true);
  const cdOffset = view.getUint32(eocdPos + 16, true);

  // zipfile follows a ZIP64 locator whenever one sits before the EOCD, whatever
  // the EOCD fields say
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || totalEntries === 0xFFFF ||
      isSignature(tail, eocdPos - 20, 0x06, 0x07)) {
    throw zip64Error();
  }
  // zipfile finds the directory by counting back from the EOCD and ignores the
  // stored offset. Require both to agree.
  if (cdOffset + cdSize !== tailStart + eocdPos) {
    throw new Error('ZIP central directory does not end at the end-of-directory record');
  }
  return { cdOffset, cdSize, totalEntries, eocdPos };
}

// zipfile reads records until the directory is used up and ignores the entry
// count, so the two must agree.
export function parseCentralDirectory(cdBuf, totalEntries) {
  const entries = [];
  const view = new DataView(cdBuf.buffer, cdBuf.byteOffset, cdBuf.byteLength);
  let pos = 0;
  while (pos + 46 <= cdBuf.length) {
    if (!isSignature(cdBuf, pos, 0x01, 0x02)) throw new Error('Invalid ZIP central directory record');

    const compressionMethod = view.getUint16(pos + 10, true);
    const crc32             = view.getUint32(pos + 16, true);
    const compressedSize    = view.getUint32(pos + 20, true);
    const uncompressedSize  = view.getUint32(pos + 24, true);
    const nameLen           = view.getUint16(pos + 28, true);
    const extraLen          = view.getUint16(pos + 30, true);
    const commentLen        = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > cdBuf.length) throw new Error('ZIP central directory truncated');
    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
      throw zip64Error();
    }

    // Extra fields can replace the sizes (ZIP64) or the name (Unicode path)
    const extraEnd = pos + 46 + nameLen + extraLen;
    for (let at = pos + 46 + nameLen; at + 4 <= extraEnd;) {
      const id = view.getUint16(at, true);
      if (id === 0x0001) throw zip64Error();
      if (id === 0x7075) throw new Error('ZIP entries renamed by a Unicode path extra field are not supported');
      at += 4 + view.getUint16(at + 2, true);
    }

    // zipfile ends a name at its first NUL byte
    let nameBytes = cdBuf.subarray(pos + 46, pos + 46 + nameLen);
    const nul = nameBytes.indexOf(0);
    if (nul >= 0) nameBytes = nameBytes.subarray(0, nul);

    entries.push({
      filename: textDecoder.decode(nameBytes),
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos = next;
  }

  if (pos !== cdBuf.length || entries.length !== totalEntries) {
    throw new Error(`ZIP central directory does not match its entry count (${entries.length} of ${totalEntries} entries)`);
  }
  return entries;
}

export async function fetchZipDirectory(url) {
  url = await proxyUrl(url);
  // Step 1: 1-byte range GET to get size from Content-Range. Not a HEAD:
  // files.pythonhosted.org sends no CORS headers on HEAD responses.
  const probe = await fetchRange(url, 0, 0);
  const size = parseInt((probe.headers.get('Content-Range') || '').split('/')[1], 10);
  if (!size) throw new Error('Cannot determine file size');

  // Step 2: Fetch last 64KB to find EOCD
  const tailSize = Math.min(65557 + 22, size); // max comment + EOCD size
  const tailStart = size - tailSize;
  const tailResp = await fetchRange(url, tailStart, size - 1);
  const tailBuf = new Uint8Array(await tailResp.arrayBuffer());
  const { cdOffset, cdSize, totalEntries, eocdPos } = locateCentralDirectory(tailBuf, tailStart);

  // Step 3: Fetch central directory if not already in our tail buffer
  let cdBuf;
  if (cdOffset >= tailStart) {
    cdBuf = tailBuf.subarray(cdOffset - tailStart, eocdPos);
  } else {
    const cdResp = await fetchRange(url, cdOffset, cdOffset + cdSize - 1);
    cdBuf = new Uint8Array(await cdResp.arrayBuffer());
    if (cdBuf.length !== cdSize) throw new Error('ZIP central directory truncated');
  }

  return { entries: parseCentralDirectory(cdBuf, totalEntries), fileSize: size, url };
}

export async function fetchZipFileContent(url, entry, signal) {
  // Sizes come from the archive, so bound the download before trusting them
  if (entry.compressedSize > MAX_FILE_BYTES || entry.uncompressedSize > MAX_FILE_BYTES) {
    throw new Error(`File exceeds the ${fmtSize(MAX_FILE_BYTES)} limit`);
  }
  url = await proxyUrl(url);
  const start = entry.localHeaderOffset;
  // Fetch local header + data in one request. Header is 30 bytes + name + extra.
  // Use filename length from central directory + 128 bytes padding for extra fields.
  const estimatedHeader = 30 + entry.filename.length + 128;
  const totalSize = estimatedHeader + entry.compressedSize;
  const resp = await fetchRange(url, start, start + totalSize - 1, signal);
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.length < 30 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error('Invalid ZIP local file header');
  }
  const view = new DataView(buf.buffer, buf.byteOffset);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const dataOffset = 30 + nameLen + extraLen;

  let raw;
  if (dataOffset + entry.compressedSize <= buf.length) {
    // Got everything in one fetch
    raw = buf.slice(dataOffset, dataOffset + entry.compressedSize);
  } else {
    // Extra fields were larger than expected — fetch the data portion
    console.warn(`Extra field overflow for ${entry.filename}, doing second fetch`);
    const dataStart = start + dataOffset;
    const dataResp = await fetchRange(url, dataStart, dataStart + entry.compressedSize - 1, signal);
    raw = new Uint8Array(await dataResp.arrayBuffer());
  }
  if (raw.length !== entry.compressedSize) throw new Error('ZIP entry data is truncated');

  if (entry.compressionMethod === 0) return raw;
  if (entry.compressionMethod === 8) return await decompress(raw, 'deflate-raw', MAX_FILE_BYTES);
  throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
}
