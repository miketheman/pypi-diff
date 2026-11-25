// Line diff with word-level changes inside modified lines. No DOM; runs in
// the worker and in the tests.
//
// The vendored jsdiff build is a UMD script: imported for its side effect, it
// defines globalThis.Diff.
import '../vendor/diff.min.js';

const { diffLines, diffWordsWithSpace } = globalThis.Diff;

const MAX_LINE_LENGTH = 500;   // longer lines (minified code, base64) get no word diff
const MAX_BLOCK_CELLS = 10000; // removed lines x added lines to consider for pairing
const MIN_SIMILARITY = 0.5;    // below this, two lines are different lines, not an edit
const DIFF_TIMEOUT_MS = 5000;  // files with little in common can take minutes to diff

const tokens = line => line.match(/\w+|[^\w\s]/g) || [];

// Dice coefficient over token multisets: 1 for identical tokens, 0 for none shared
function similarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const counts = new Map();
  for (const t of tokensA) counts.set(t, (counts.get(t) || 0) + 1);
  let shared = 0;
  for (const t of tokensB) {
    const n = counts.get(t);
    if (n) { shared++; counts.set(t, n - 1); }
  }
  return (2 * shared) / (tokensA.length + tokensB.length);
}

// Pairs each removed line with the added line it was most likely edited into.
// Pairs keep their order, so a line inserted mid-block shifts the pairing
// instead of breaking it. Returns [indexA, indexB] pairs.
export function pairLines(linesA, linesB) {
  const n = linesA.length, m = linesB.length;
  if (n * m > MAX_BLOCK_CELLS) return [];
  const tokA = linesA.map(l => l.length > MAX_LINE_LENGTH ? [] : tokens(l));
  const tokB = linesB.map(l => l.length > MAX_LINE_LENGTH ? [] : tokens(l));

  // best[i][j]: highest total similarity pairing linesA[i..] with linesB[j..]
  const sim = Array.from({ length: n }, () => new Float64Array(m));
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = similarity(tokA[i], tokB[j]);
      sim[i][j] = s;
      const paired = s >= MIN_SIMILARITY ? s + best[i + 1][j + 1] : 0;
      best[i][j] = Math.max(paired, best[i + 1][j], best[i][j + 1]);
    }
  }

  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (sim[i][j] >= MIN_SIMILARITY && best[i][j] === sim[i][j] + best[i + 1][j + 1]) {
      pairs.push([i++, j++]);
    } else if (best[i + 1][j] >= best[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

// Word diff of one line pair, as [{ text, changed }] segments for each side.
// Indentation is compared on its own, so re-indenting a line marks only the
// extra indent and not the whole run of leading whitespace.
export function wordSegments(lineA, lineB) {
  const indentA = lineA.match(/^\s*/)[0], indentB = lineB.match(/^\s*/)[0];
  let shared = 0;
  while (shared < indentA.length && indentA[shared] === indentB[shared]) shared++;
  const indent = full => [
    { text: full.slice(0, shared), changed: false },
    { text: full.slice(shared), changed: true },
  ].filter(seg => seg.text);

  const a = indent(indentA), b = indent(indentB);
  for (const part of diffWordsWithSpace(lineA.slice(indentA.length), lineB.slice(indentB.length))) {
    if (!part.added) a.push({ text: part.value, changed: !!part.removed });
    if (!part.removed) b.push({ text: part.value, changed: !!part.added });
  }
  return [a, b];
}

const splitLines = value => value.replace(/\n$/, '').split('\n');

// Returns [{ added, removed, lines, inline }]. `inline` is set on removed and
// added parts that have paired lines: inline[i] holds the segments of lines[i],
// or is empty when that line has no pair.
export function computeDiff(textA, textB, timeoutMs = DIFF_TIMEOUT_MS) {
  // On timeout jsdiff returns undefined: show the files as one removal and one addition
  const changes = diffLines(textA, textB, { ignoreWhitespace: false, stripTrailingCr: true, timeout: timeoutMs })
    ?? [{ value: textA, removed: true }, { value: textB, added: true }].filter(change => change.value);
  const parts = changes.map(p => ({ added: !!p.added, removed: !!p.removed, lines: splitLines(p.value) }));

  for (let k = 0; k + 1 < parts.length; k++) {
    const removed = parts[k], added = parts[k + 1];
    if (!removed.removed || !added.added) continue;
    const pairs = pairLines(removed.lines, added.lines);
    if (!pairs.length) continue;
    removed.inline = [];
    added.inline = [];
    for (const [i, j] of pairs) {
      [removed.inline[i], added.inline[j]] = wordSegments(removed.lines[i], added.lines[j]);
    }
  }
  return parts;
}
