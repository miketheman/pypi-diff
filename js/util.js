// ignoreBOM keeps a leading U+FEFF in the text, where it is shown as a hidden character
export const textDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

export function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function isBinary(buf) {
  const check = Math.min(buf.length, 8192);
  for (let i = 0; i < check; i++) { if (buf[i] === 0) return true; }
  return false;
}

// Bidi controls, zero-width, control and other invisible characters change how
// text reads without being visible. Splits text into plain strings and
// { hidden: 'U+202E' } markers so the UI can render the markers visibly.
// Control and format categories, line and paragraph separators, and the Hangul
// fillers, which render blank yet are valid in identifiers. Tab, LF and CR stay.
const HIDDEN = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]/gu;
export function hiddenCharSegments(text) {
  const segments = [];
  let last = 0;
  for (const m of text.matchAll(HIDDEN)) {
    if (m.index > last) segments.push(text.slice(last, m.index));
    segments.push({ hidden: `U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}
