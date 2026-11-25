// ─── Path Normalization ──────────────────────────────────────
// The one top-level code directory of a wheel whose name gets stripped: the
// directory named after the distribution, else the one with the most files.
// Other top-level directories keep their full path.
export function primaryWheelDir(entries) {
  const counts = new Map();
  let distName = null;
  for (const e of entries) {
    const p = e.filename.replace(/\\/g, '/').replace(/^\.\//, '');
    const slash = p.indexOf('/');
    if (slash < 0) continue;
    const first = p.slice(0, slash);
    if (first.endsWith('.dist-info')) distName = first.slice(0, first.lastIndexOf('-'));
    else if (!first.endsWith('.data')) counts.set(first, (counts.get(first) || 0) + 1);
  }
  const canon = s => s.toLowerCase().replace(/[-_.]+/g, '_');
  let best = null;
  for (const [dir, n] of counts) {
    if (distName && canon(dir) === canon(distName)) return dir;
    if (best === null || n > counts.get(best)) best = dir;
  }
  return best;
}

export function normalizePaths(entries, isWheel) {
  const primaryDir = isWheel ? primaryWheelDir(entries) : null;
  const clean = filename => filename.replace(/\\/g, '/').replace(/^\.\//, '');
  // Paths outside the primary directory keep their full path. A primary-directory
  // file whose stripped path would land on one of them keeps its prefix too.
  const outside = new Set(entries.map(e => clean(e.filename))
    .filter(p => p.slice(0, Math.max(0, p.indexOf('/'))) !== primaryDir));
  const issued = new Set();
  return entries
    .filter(e => !e.filename.endsWith('/')) // skip directories
    .map(e => {
      const p = clean(e.filename);

      let normalized;
      if (isWheel) {
        // Wheels have no wrapping directory. Paths look like:
        //   packagename/module.py
        //   packagename-1.0.dist-info/METADATA
        //   packagename-1.0.data/scripts/foo
        // Normalize .dist-info and .data dirs to strip the name-version prefix,
        // and strip the primary package directory name.
        const firstSlash = p.indexOf('/');
        const firstComponent = firstSlash >= 0 ? p.slice(0, firstSlash) : p;

        if (firstSlash < 0) {
          normalized = p; // a top-level file, whatever its name ends in
        } else if (firstComponent.endsWith('.dist-info')) {
          normalized = `.dist-info${p.slice(firstSlash)}`;
        } else if (firstComponent.endsWith('.data')) {
          normalized = `.data${p.slice(firstSlash)}`;
        } else if (firstComponent === primaryDir && !outside.has(p.slice(firstSlash + 1))) {
          // Primary code directory — strip the package name prefix
          normalized = p.slice(firstSlash + 1);
        } else {
          normalized = p;
        }
      } else {
        // Sdists have a wrapping name-version/ directory — strip it
        const slash = p.indexOf('/');
        normalized = slash >= 0 ? p.slice(slash + 1) : p;
      }

      // Normalize .egg-info directories (strip the package name prefix).
      // Common in sdists (e.g. django_environ.egg-info/SOURCES.txt → .egg-info/SOURCES.txt)
      const innerSlash = normalized.indexOf('/');
      if (innerSlash > 0) {
        const innerComponent = normalized.slice(0, innerSlash);
        if (innerComponent.endsWith('.egg-info')) {
          normalized = `.egg-info${normalized.slice(innerSlash)}`;
        }
      }

      return { ...e, normalizedPath: normalized, originalPath: e.filename };
    })
    .filter(e => e.normalizedPath.length > 0)
    .map(e => {
      // An archive can hold several entries with one name, and tools disagree
      // on which wins. Keep every copy as its own row. Labels count up until
      // one is free, so a file literally named like a label cannot replace a row.
      let path = e.normalizedPath;
      for (let n = 2; issued.has(path); n++) path = `${e.normalizedPath} [duplicate entry ${n}]`;
      issued.add(path);
      return path === e.normalizedPath ? e : { ...e, normalizedPath: path };
    });
}

// ─── Comparison Logic ────────────────────────────────────────
export function pathSuffixLen(pathA, pathB) {
  const a = pathA.split('/'), b = pathB.split('/');
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

export function contentIdentical(entryA, entryB) {
  if (entryA.crc32 != null && entryB.crc32 != null && !entryA.content) {
    return entryA.crc32 === entryB.crc32 && entryA.uncompressedSize === entryB.uncompressedSize;
  }
  if (entryA.content && entryB.content) {
    if (entryA.content.length !== entryB.content.length) return false;
    for (let i = 0; i < entryA.content.length; i++) {
      if (entryA.content[i] !== entryB.content[i]) return false;
    }
    return true;
  }
  return false;
}

export function compareFileLists(entriesA, entriesB) {
  const mapA = new Map(entriesA.map(e => [e.normalizedPath, e]));
  const mapB = new Map(entriesB.map(e => [e.normalizedPath, e]));

  const allPaths = new Set([...mapA.keys(), ...mapB.keys()]);
  const results = [];

  for (const path of allPaths) {
    const a = mapA.get(path);
    const b = mapB.get(path);

    if (a && !b) {
      results.push({ path, status: 'removed', a, b: null });
    } else if (!a && b) {
      results.push({ path, status: 'added', a: null, b });
    } else {
      // Both exist – compare CRC32 and size
      const sameSize = a.uncompressedSize === b.uncompressedSize;
      const sameCrc = a.crc32 !== 0 && b.crc32 !== 0 && a.crc32 === b.crc32;
      if (sameSize && sameCrc) {
        results.push({ path, status: 'identical', a, b });
      } else if (sameSize && a.crc32 === 0 && b.crc32 === 0) {
        // Tar entries – no CRC; mark as "possibly identical" until content check
        results.push({ path, status: 'identical', a, b, needsContentCheck: true });
      } else {
        results.push({ path, status: 'modified', a, b });
      }
    }
  }

  // Detect moved files: match added/removed by content identity + path suffix similarity
  const added = results.filter(r => r.status === 'added');
  const removed = results.filter(r => r.status === 'removed');
  if (added.length > 0 && removed.length > 0) {
    // Index removed files by basename for quick lookup
    const removedByBase = new Map();
    for (const r of removed) {
      const base = r.path.split('/').pop();
      if (!removedByBase.has(base)) removedByBase.set(base, []);
      removedByBase.get(base).push(r);
    }

    const matched = new Set();
    for (const a of added) {
      const base = a.path.split('/').pop();
      const candidates = removedByBase.get(base);
      if (!candidates || a.b.uncompressedSize === 0) continue;
      // Find the best match: content must be identical, prefer longest common path suffix
      let best = null, bestSuffix = 0;
      for (const c of candidates) {
        if (matched.has(c)) continue;
        if (!contentIdentical(c.a, a.b)) continue;
        const suffix = pathSuffixLen(c.path, a.path);
        if (suffix > bestSuffix) { best = c; bestSuffix = suffix; }
      }
      if (best) {
        // One row per move: the added row carries both sides, the removed row goes
        a.status = 'moved';
        a.movedFrom = best.path;
        a.a = best.a;
        results.splice(results.indexOf(best), 1);
        matched.add(best);
      }
    }
  }

  // Sort alphabetically by path — status is shown via badges, not grouping
  results.sort((a, b) => a.path.localeCompare(b.path));

  return results;
}


export function normalizeContent(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function normalizeContentForComparison(text, pkgNames, versions) {
  // Replace package names and versions with placeholders so files that differ
  // only in the embedded name/version are treated as identical.
  // Accepts arrays so we can normalize BOTH sides' names on both texts — this
  // handles cases where a file references the other side's package (common
  // in typosquats that copy files wholesale).
  // Longest first, so a name or version that is a prefix of the other
  // (graphifyy / graphifyyy, 2.0 / 2.0.1) does not eat part of the longer one.
  // A name inside a URL is left alone: a squat named after an attacker's
  // hostname must not make a changed URL look equivalent.
  const byLength = (a, b) => (b || '').length - (a || '').length;
  const inUrl = (str, offset) =>
    /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*$/i.test(str.slice(Math.max(0, offset - 200), offset));
  // A name inside a longer name is a different name: `pkg-core` or `types-pkg`
  // is another distribution, and a squat can depend on a second squat.
  const inLongerName = (str, start, end) =>
    /[a-z0-9][-_]?$/i.test(str.slice(Math.max(0, start - 2), start)) ||
    /^(?:[a-z0-9]|[-_][a-z])/i.test(str.slice(end, end + 2));
  let result = text;
  for (const pkgName of [...pkgNames].sort(byLength)) {
    if (!pkgName) continue;
    // Match the name with any separator variant (-, _, .)
    const parts = pkgName.split(/[-_.]+/);
    const pattern = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-_.]');
    result = result.replace(new RegExp(pattern, 'gi'), (m, offset, str) =>
      inUrl(str, offset) || inLongerName(str, offset, offset + m.length) ? m : '{pkg}');
  }
  for (const version of [...versions].sort(byLength)) {
    if (!version) continue;
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Not inside a longer number: 0.1 must not match in 10.0.1.5
    result = result.replace(new RegExp(`(?<!\\d\\.?)${escaped}(?!\\.?\\d)`, 'g'), '{ver}');
  }
  return result;
}

export function normalizeWhitespace(text) {
  // The lookbehind keeps a long run of spaces mid-line from being retried at every position
  return text.replace(/(?<![ \t])[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeRecord(text, pkgNames, versions) {
  // RECORD: each line is "filepath,sha256=hash,size"
  // Compare only the normalized file paths, ignoring hashes/sizes
  // (they change when name length changes file content)
  return text.trim().split('\n')
    .map(line => {
      const comma = line.indexOf(',');
      const path = comma >= 0 ? line.slice(0, comma) : line;
      return normalizeContentForComparison(path, pkgNames, versions);
    })
    .sort()
    .join('\n');
}

export function isRecordFile(path) {
  return path === '.dist-info/RECORD' || path.endsWith('/RECORD');
}

export function contentMatches(textA, textB, path, pkgA, verA, pkgB, verB) {
  // Normalize both sides' package names and versions on both texts
  const pkgs = [pkgA, pkgB], vers = [verA, verB];
  textA = normalizeContent(textA);
  textB = normalizeContent(textB);

  // 1. Name/version normalized
  const normA = normalizeContentForComparison(textA, pkgs, vers);
  const normB = normalizeContentForComparison(textB, pkgs, vers);
  if (normA === normB) return true;

  // 2. Name/version + whitespace normalized
  if (normalizeWhitespace(normA) === normalizeWhitespace(normB)) return true;

  // 3. RECORD: compare only normalized file path list
  if (isRecordFile(path)) {
    return normalizeRecord(textA, pkgs, vers) === normalizeRecord(textB, pkgs, vers);
  }

  return false;
}
