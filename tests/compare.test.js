import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareFileLists, contentMatches, normalizeContentForComparison, normalizePaths,
} from '../js/compare.js';

const paths = (files, isWheel = true) =>
  normalizePaths(files.map(filename => ({ filename })), isWheel).map(e => e.normalizedPath);
const entry = (normalizedPath, uncompressedSize, crc32) => ({ normalizedPath, uncompressedSize, crc32 });
const statuses = results => results.map(r => `${r.status} ${r.path}`);

test('wheel paths: dist-info and .data prefixes are stripped', () => {
  assert.deepEqual(
    paths(['pkg/mod.py', 'pkg-1.0.dist-info/METADATA', 'pkg-1.0.data/scripts/run']),
    ['mod.py', '.dist-info/METADATA', '.data/scripts/run']);
});

test('wheel paths: only the directory named after the distribution is stripped', () => {
  assert.deepEqual(
    paths(['setuptools/__init__.py', 'pkg_resources/__init__.py', '_distutils_hack/__init__.py',
      'setuptools-75.0.0.dist-info/METADATA']),
    ['__init__.py', 'pkg_resources/__init__.py', '_distutils_hack/__init__.py', '.dist-info/METADATA']);
});

test('wheel paths: with no name match the largest directory is stripped', () => {
  assert.deepEqual(
    paths(['requests/__init__.py', 'requests/api.py', 'evil/__init__.py', 'reqeusts-1.0.dist-info/RECORD', 'six.py']),
    ['__init__.py', 'api.py', 'evil/__init__.py', '.dist-info/RECORD', 'six.py']);
});

test('sdist paths: wrapping directory and egg-info name are stripped', () => {
  assert.deepEqual(
    paths(['pkg-1.0/setup.py', 'pkg-1.0/pkg.egg-info/SOURCES.txt', 'pkg-1.0/src/'], false),
    ['setup.py', '.egg-info/SOURCES.txt']);
});

test('duplicate archive entries each keep a row', () => {
  assert.deepEqual(
    paths(['pkg/__init__.py', 'pkg/__init__.py', 'pkg-1.0.dist-info/METADATA']),
    ['__init__.py', '__init__.py [duplicate entry 2]', '.dist-info/METADATA']);
});

test('a file named like a duplicate label cannot replace the real duplicate', () => {
  assert.deepEqual(
    paths(['pkg-1.0/setup.py', 'pkg-1.0/setup.py', 'pkg-1.0/setup.py [duplicate entry 2]'], false),
    ['setup.py', 'setup.py [duplicate entry 2]', 'setup.py [duplicate entry 2] [duplicate entry 2]']);
  assert.deepEqual(
    paths(['pkg-1.0/setup.py [duplicate entry 2]', 'pkg-1.0/setup.py', 'pkg-1.0/setup.py'], false),
    ['setup.py [duplicate entry 2]', 'setup.py', 'setup.py [duplicate entry 3]']);
});

test('wheel paths: top-level files keep their names', () => {
  assert.deepEqual(
    paths(['model.data', 'notes.dist-info', 'pkg/a.py', 'pkg-1.0.dist-info/METADATA']),
    ['model.data', 'notes.dist-info', 'a.py', '.dist-info/METADATA']);
});

test('wheel paths: a stripped path never lands on another file, in either order', () => {
  const expected = ['pkg/utils.py', 'utils.py'];
  assert.deepEqual(paths(['pkg/utils.py', 'utils.py', 'pkg/a.py', 'pkg-1.0.dist-info/METADATA']).filter(p => p.endsWith('utils.py')), expected);
  assert.deepEqual(paths(['utils.py', 'pkg/a.py', 'pkg/utils.py', 'pkg-1.0.dist-info/METADATA']).filter(p => p.endsWith('utils.py')).sort(), expected);
});

test('comparison: identical, modified, added and removed', () => {
  const results = compareFileLists(
    [entry('same.py', 5, 1), entry('changed.py', 5, 2), entry('gone.py', 9, 3)],
    [entry('same.py', 5, 1), entry('changed.py', 6, 4), entry('new.py', 7, 5)]);
  assert.deepEqual(statuses(results),
    ['modified changed.py', 'removed gone.py', 'added new.py', 'identical same.py']);
});

test('a move is one row at the new path', () => {
  const results = compareFileLists([entry('a/x.py', 5, 7)], [entry('b/x.py', 5, 7)]);
  assert.deepEqual(statuses(results), ['moved b/x.py']);
  assert.equal(results[0].movedFrom, 'a/x.py');
});

test('empty files are never paired as moved', () => {
  const results = compareFileLists([entry('legit/__init__.py', 0, 0)], [entry('evil/__init__.py', 0, 0)]);
  assert.deepEqual(statuses(results), ['added evil/__init__.py', 'removed legit/__init__.py']);
});

test('names and versions are replaced longest first', () => {
  const names = ['graphifyy', 'graphifyyy'];
  assert.equal(normalizeContentForComparison('import graphifyyy', names, []), 'import {pkg}');
  assert.equal(normalizeContentForComparison('import graphifyy', names, []), 'import {pkg}');
  assert.equal(normalizeContentForComparison('v 2.0.1', [], ['2.0', '2.0.1']), 'v {ver}');
});

test('a version does not match inside a longer number', () => {
  assert.equal(normalizeContentForComparison('HOST = "10.0.1.5"', [], ['0.1', '0.2']), 'HOST = "10.0.1.5"');
  assert.equal(normalizeContentForComparison('Version 0.1. Done', [], ['0.1']), 'Version {ver}. Done');
});

test('a name inside a URL is not replaced', () => {
  const names = ['requests', 'evilhost'];
  const url = 'u = "https://evilhost.example.com/x"';
  assert.equal(normalizeContentForComparison(url, names, []), url);
  assert.equal(contentMatches(
    'u = "https://requests.example.com/x"\n', url + '\n', 'a.py', 'requests', '1', 'evilhost', '1'), false);
});

test('a name inside a longer name is not replaced', () => {
  const names = ['pydantic', 'pydnatic'];
  for (const text of ['Requires-Dist: pydnatic-core', 'from pydnatic_core import x', 'import types_pydnatic', 'pydnatic2']) {
    assert.equal(normalizeContentForComparison(text, names, []), text);
  }
  assert.equal(normalizeContentForComparison('import pydnatic.main', names, []), 'import {pkg}.main');
  assert.equal(normalizeContentForComparison('pydnatic-1.0.dist-info/RECORD', names, []), '{pkg}-1.0.dist-info/RECORD');
  assert.equal(contentMatches(
    'Requires-Dist: pydantic-core\n', 'Requires-Dist: pydnatic-core\n', 'METADATA', 'pydantic', '1', 'pydnatic', '1'), false);
});

test('whitespace normalization stays fast on a long run of spaces', () => {
  const hostile = `x = 2${' '.repeat(200000)}#\n`;
  const start = performance.now();
  assert.equal(contentMatches('x = 1\n', hostile, 'a.py', 'p', '1', 'p', '1'), false);
  assert.ok(performance.now() - start < 2000);
});

test('equivalence: name swap, line endings, RECORD hashes', () => {
  assert.equal(contentMatches('import requests\n', 'import reqeusts\n', 'a.py', 'requests', '1.0', 'reqeusts', '1.0'), true);
  assert.equal(contentMatches('a\r\nb\r\n', 'a\nb\n', 'a.py', 'p', '1', 'p', '1'), true);
  assert.equal(contentMatches(
    'requests/a.py,sha256=AAA,10\n', 'reqeusts/a.py,sha256=BBB,12\n',
    '.dist-info/RECORD', 'requests', '1.0', 'reqeusts', '1.0'), true);
  assert.equal(contentMatches('x = 1\n', 'x = 2\n', 'a.py', 'p', '1', 'p', '1'), false);
});
