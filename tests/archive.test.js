import test from 'node:test';
import assert from 'node:assert/strict';
import { decompress, getVersions, metaFromFileUrl } from '../js/net.js';
import { parseTar } from '../js/tar.js';
import { locateCentralDirectory, parseCentralDirectory } from '../js/zip.js';
import { hiddenCharSegments, isBinary } from '../js/util.js';

const enc = new TextEncoder();

// One 512-byte tar header followed by the body padded to 512 bytes
const FIELD_OFFSETS = { size: 124, linkname: 157 };
function tarEntry(name, body, typeFlag = '0', fields = {}) {
  const data = enc.encode(body);
  const header = new Uint8Array(512);
  header.set(enc.encode(name).subarray(0, 100), 0);
  header.set(enc.encode(data.length.toString(8).padStart(11, '0')), 124);
  header[156] = typeFlag.charCodeAt(0);
  for (const [field, value] of Object.entries(fields)) header.set(enc.encode(value), FIELD_OFFSETS[field]);
  header.fill(0x20, 148, 156);
  header.set(enc.encode(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 '), 148);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header, padded];
}

function tar(...entries) {
  const blocks = [...entries.flat(), new Uint8Array(1024)];
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of blocks) { out.set(b, offset); offset += b.length; }
  return out;
}

const paxPath = path => {
  const record = ` path=${path}\n`;
  let len = record.length + 1;
  while (String(len).length + record.length !== len) len = String(len).length + record.length;
  return `${len}${record}`;
};

test('tar: regular files are listed with their content', () => {
  const { entries } = parseTar(tar(tarEntry('pkg-1.0/a.py', 'x = 1\n'), tarEntry('pkg-1.0/dir/', '', '5')));
  assert.deepEqual(entries.map(e => e.filename), ['pkg-1.0/a.py']);
  assert.equal(new TextDecoder().decode(entries[0].content), 'x = 1\n');
});

test('tar: pax and GNU long names replace the truncated header name', () => {
  const long = n => `pkg-1.0/${'d'.repeat(120)}/module_${n}.py`;
  const { entries } = parseTar(tar(
    tarEntry('PaxHeader', paxPath(long('one')), 'x'), tarEntry(long('one'), 'a'),
    tarEntry('././@LongLink', long('two') + '\0', 'L'), tarEntry(long('two'), 'b'),
    tarEntry('pkg-1.0/short.py', 'c')));
  assert.deepEqual(entries.map(e => e.filename), [long('one'), long('two'), 'pkg-1.0/short.py']);
});

const names = bytes => parseTar(bytes).entries.map(e => e.filename);
const body = entry => new TextDecoder().decode(entry.content);

test('tar: files stored with other type flags or a trailing slash are listed', () => {
  assert.deepEqual(names(tar(
    tarEntry('pkg-1.0/a.py', 'a', '7'), tarEntry('pkg-1.0/b.py/', 'b'), tarEntry('pkg-1.0/dir/', '', '\0'))),
    ['pkg-1.0/a.py', 'pkg-1.0/b.py']);
});

test('tar: links are listed, and carry no data', () => {
  const { entries } = parseTar(tar(
    tarEntry('pkg-1.0/setup.py', 'real\n'),
    tarEntry('pkg-1.0/setup.py', '', '1', { linkname: 'pkg-1.0/docs/notes.txt' }),
    tarEntry('pkg-1.0/link.py', '', '2', { linkname: 'target.py' }),
    tarEntry('pkg-1.0/after.py', 'after\n')));
  assert.deepEqual(entries.map(e => e.filename),
    ['pkg-1.0/setup.py', 'pkg-1.0/setup.py', 'pkg-1.0/link.py', 'pkg-1.0/after.py']);
  assert.equal(body(entries[1]), '[hard link to pkg-1.0/docs/notes.txt]\n');
  assert.equal(body(entries[2]), '[symbolic link to target.py]\n');
});

test('tar: a directory header with a size does not swallow the next entry', () => {
  assert.deepEqual(names(tar(
    tarEntry('pkg-1.0/dir/', '', '5', { size: '00000002000' }), tarEntry('pkg-1.0/next.py', 'x'))),
    ['pkg-1.0/next.py']);
});

test('tar: pax records are read by length, last one wins, and size applies', () => {
  const twoPaths = paxPath('pkg-1.0/decoy.py') + paxPath('pkg-1.0/setup.py');
  assert.deepEqual(names(tar(tarEntry('PaxHeader', twoPaths, 'x'), tarEntry('pkg-1.0/x', 'a'))), ['pkg-1.0/setup.py']);

  const comment = 'x\n27 path=pkg-1.0/decoy.py\n';
  const embedded = `${comment.length + 12} comment=${comment}\n`;
  assert.deepEqual(names(tar(tarEntry('PaxHeader', embedded, 'x'), tarEntry('pkg-1.0/real.py', 'a'))), ['pkg-1.0/real.py']);

  const sized = parseTar(tar(tarEntry('PaxHeader', '9 size=3\n', 'x'), tarEntry('pkg-1.0/s.py', 'abcdef', '0', { size: '00000000000' })));
  assert.equal(body(sized.entries[0]), 'abc');
});

test('tar: constructs the parser does not model are errors', () => {
  const rejects = (bytes, pattern) => assert.throws(() => parseTar(bytes), pattern);
  rejects(tar(tarEntry('pkg-1.0/a.py', 'a', '0', { size: '-0000001000' })), /size field/);
  rejects(tar(tarEntry('pkg-1.0/a.py', 'a', '0', { size: '\x80\0\0\0\0\0\0\0\0\0\0\x01' })), /size field/);
  rejects(tar(tarEntry('PaxHeader', paxPath('a'), 'x'), tarEntry('PaxHeader', paxPath('b'), 'x'), tarEntry('c', '')), /Consecutive pax/);
  rejects(tar(tarEntry('PaxHeader', paxPath('pkg-1.0/setup.py'), 'g'), tarEntry('c', '')), /Global pax/);
  rejects(tar(tarEntry('PaxHeader', '28 GNU.sparse.name=setup.py\n', 'x'), tarEntry('c', '')), /Sparse/);
  rejects(tar(tarEntry('PaxHeader', paxPath('a'), 'x'), tarEntry('././@LongLink', 'b\0', 'L'), tarEntry('c', '')), /both a pax header/);
  rejects(tar(tarEntry('PaxHeader', '99 path=a\n', 'x'), tarEntry('c', '')), /Malformed pax/);
  const badChecksum = tar(tarEntry('pkg-1.0/a.py', 'a'));
  badChecksum[0] ^= 1;
  rejects(badChecksum, /checksum/);
});

test('tar: a name ends at its first NUL byte', () => {
  assert.deepEqual(names(tar(tarEntry('pkg-1.0/setup.py\0\n', 'a'))), ['pkg-1.0/setup.py']);
});

// Builds a ZIP central directory and its EOCD record; `tweak` edits the fields
function zipDirectory(files, tweak = {}) {
  const u16 = n => [n & 255, n >> 8], u32 = n => [...u16(n & 65535), ...u16(n >>> 16)];
  const records = files.map(({ name, extra = [], size = 1 }) => {
    const nameBytes = [...enc.encode(name)];
    return [0x50, 0x4b, 1, 2, ...Array(6).fill(0), ...u16(8), ...Array(4).fill(0), ...u32(0xabcd), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(extra.length), ...Array(10).fill(0), ...u32(0), ...nameBytes, ...extra];
  }).flat();
  const cdOffset = 100; // pretend 100 bytes of file data come first
  const eocd = [0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(tweak.count ?? files.length),
    ...u32(tweak.cdSize ?? records.length), ...u32(tweak.cdOffset ?? cdOffset), 0, 0];
  return { tail: new Uint8Array([...(tweak.before ?? []), ...records, ...eocd]),
    tailStart: cdOffset - (tweak.before?.length ?? 0), cd: new Uint8Array(records) };
}
const listZip = ({ tail, tailStart }) => {
  const { cdOffset, totalEntries, eocdPos } = locateCentralDirectory(tail, tailStart);
  return parseCentralDirectory(tail.subarray(cdOffset - tailStart, eocdPos), totalEntries).map(e => e.filename);
};

test('zip: a plain directory is listed, names cut at NUL', () => {
  assert.deepEqual(listZip(zipDirectory([{ name: 'pkg/a.py' }, { name: 'pkg/b.py\0.txt' }])), ['pkg/a.py', 'pkg/b.py']);
});

test('zip: directories Python would read differently are errors', () => {
  const two = [{ name: 'pkg/a.py' }, { name: 'pkg/b.py' }];
  assert.throws(() => listZip(zipDirectory(two, { count: 1 })), /entry count/);
  assert.throws(() => listZip(zipDirectory(two, { cdOffset: 60 })), /does not end at/);
  assert.throws(() => listZip(zipDirectory(two, { cdSize: 10 })), /does not end at/);
  const locator = [0x50, 0x4b, 6, 7, ...Array(16).fill(0)];
  const withLocator = zipDirectory(two);
  const tail = new Uint8Array([...withLocator.tail.subarray(0, withLocator.cd.length), ...locator, ...withLocator.tail.subarray(withLocator.cd.length)]);
  assert.throws(() => locateCentralDirectory(tail, withLocator.tailStart), /ZIP64/);
  assert.throws(() => listZip(zipDirectory([{ name: 'a', size: 0xFFFFFFFF }])), /ZIP64/);
  assert.throws(() => listZip(zipDirectory([{ name: 'a', extra: [1, 0, 0, 0] }])), /ZIP64/);
  assert.throws(() => listZip(zipDirectory([{ name: 'a', extra: [0x75, 0x70, 0, 0] }])), /Unicode path/);
});

test('file URL stands in for package metadata', () => {
  const whl = metaFromFileUrl('https://files.pythonhosted.org/packages/aa/bb/cc/my_pkg-1.2.3-py3-none-any.whl');
  assert.equal(whl.info.name, 'my_pkg');
  assert.deepEqual(Object.keys(whl.releases), ['1.2.3']);
  const sdist = metaFromFileUrl('https://files.pythonhosted.org/packages/aa/bb/cc/my-pkg-1.2.3.tar.gz');
  assert.equal(sdist.info.name, 'my-pkg');
  assert.equal(sdist.releases['1.2.3'][0].filename, 'my-pkg-1.2.3.tar.gz');
  assert.throws(() => metaFromFileUrl('https://files.pythonhosted.org/packages/aa/noversion.whl'));
  assert.throws(() => metaFromFileUrl('https://files.pythonhosted.org/packages/aa/noversion.tar.gz'), /Cannot parse/);
});

test('versions: newest first, releases without files dropped', () => {
  const meta = { releases: { '1.0': [{}], '2.10': [{}], '2.9': [{}], '3.0': [] } };
  assert.deepEqual(getVersions(meta), ['2.10', '2.9', '1.0']);
});

test('decompress stops at the size limit', async () => {
  const gz = new Uint8Array(await new Response(
    new Blob([new Uint8Array(1024 * 1024)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  assert.equal((await decompress(gz, 'gzip', 2 * 1024 * 1024)).length, 1024 * 1024);
  await assert.rejects(decompress(gz, 'gzip', 64 * 1024), /exceeds/);
});

test('hidden characters are split out as markers', () => {
  assert.deepEqual(hiddenCharSegments('plain'), ['plain']);
  assert.deepEqual(hiddenCharSegments('a\u202eb\u0000'), ['a', { hidden: 'U+202E' }, 'b', { hidden: 'U+0000' }]);
  for (const hidden of ['\u061c', '\u00ad', '\u180e', '\u0085', '\u2028', '\u3164', '\ufeff', '\u{e0041}']) {
    assert.equal(hiddenCharSegments(`a${hidden}b`).length, 3, `U+${hidden.codePointAt(0).toString(16)}`);
  }
  assert.deepEqual(hiddenCharSegments('a\tb\nc\r'), ['a\tb\nc\r']);
});

test('a null byte marks content as binary', () => {
  assert.equal(isBinary(enc.encode('text\n')), false);
  assert.equal(isBinary(enc.encode('\0import socket\n')), true);
});
