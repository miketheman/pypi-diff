import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff, pairLines, wordSegments } from '../js/diff.js';

const changed = segments => segments.filter(s => s.changed).map(s => s.text);
const text = segments => segments.map(s => s.text).join('');

test('a changed word is marked on both sides', () => {
  const [a, b] = wordSegments('url = "https://pypi.org/x"', 'url = "https://evil.example/x"');
  assert.equal(text(a), 'url = "https://pypi.org/x"');
  assert.equal(text(b), 'url = "https://evil.example/x"');
  assert.ok(changed(a).join('').includes('pypi'));
  assert.ok(changed(b).join('').includes('evil'));
  assert.ok(!changed(a).join('').includes('url'));
});

test('re-indenting marks only the extra indent', () => {
  const [a, b] = wordSegments('    if not cert:', '        if not cert:');
  assert.deepEqual(a, [{ text: '    ', changed: false }, { text: 'if not cert:', changed: false }]);
  assert.deepEqual(b, [
    { text: '    ', changed: false }, { text: '    ', changed: true }, { text: 'if not cert:', changed: false }]);
});

test('lines pair by similarity, not position', () => {
  const removed = ['timeout = 10', 'return send(request, timeout)'];
  const added = ['timeout = 30', 'log("sending")', 'return send(request, timeout, verify)'];
  assert.deepEqual(pairLines(removed, added), [[0, 0], [1, 2]]);
});

test('unrelated lines are not paired', () => {
  assert.deepEqual(pairLines(['import os'], ['class Session(object):']), []);
});

test('lines over the length cap are not paired', () => {
  const long = 'x = ' + 'ab '.repeat(200);
  assert.deepEqual(pairLines([long + '1'], [long + '2']), []);
  assert.deepEqual(pairLines(['x = 1'], ['x = 2']), [[0, 0]]);
});

test('very large blocks are skipped', () => {
  const lines = n => Array.from({ length: 101 }, (_, i) => `value_${i} = ${n}`);
  assert.deepEqual(pairLines(lines(1), lines(2)), []);
});

test('computeDiff attaches word segments to paired lines only', () => {
  const parts = computeDiff('a = 1\nkeep\nimport os\n', 'a = 2\nkeep\nclass Foo:\n    pass\n');
  const [del1, add1, ctx, del2, add2] = parts;
  assert.deepEqual([del1.removed, add1.added, ctx.lines], [true, true, ['keep']]);
  assert.deepEqual(changed(del1.inline[0]), ['1']);
  assert.deepEqual(changed(add1.inline[0]), ['2']);
  assert.equal(del2.inline, undefined);
  assert.equal(add2.inline, undefined);
  assert.deepEqual(add2.lines, ['class Foo:', '    pass']);
});

test('a diff that times out falls back to one removal and one addition', () => {
  const lines = tag => Array.from({ length: 20000 }, (_, i) => `${tag} ${i} ${Math.sin(i)}`).join('\n') + '\n';
  const parts = computeDiff(lines('a'), lines('b'), 1);
  assert.deepEqual(parts.map(p => [p.removed, p.added, p.lines.length]), [[true, false, 20000], [false, true, 20000]]);
});

test('segments always reassemble into the original line', () => {
  const a = 'def get(url, params=None, **kwargs):\n    return request("get", url)\n';
  const b = 'def get(url, params=None, *, timeout=5, **kwargs):\n    return request("GET", url, timeout=timeout)\n';
  for (const part of computeDiff(a, b)) {
    for (const [i, segments] of (part.inline || []).entries()) {
      if (segments) assert.equal(text(segments), part.lines[i]);
    }
  }
});
