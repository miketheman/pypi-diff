import { compareFileLists, contentMatches, normalizeContent, normalizePaths } from './compare.js';
import { fetchPackageMeta, getVersions } from './net.js';
import { fetchAndParseTarGz } from './tar.js';
import { fmtSize, hiddenCharSegments, isBinary, textDecoder } from './util.js';
import { fetchZipDirectory, fetchZipFileContent } from './zip.js';

const $ = id => document.getElementById(id);

// ─── Status Messages ─────────────────────────────────────────
const $errorBox = $('errorBox');
const $progressArea = $('progressArea');

function showError(msg) {
  $errorBox.textContent = msg;
  $errorBox.classList.add('visible');
}

function hideError() { $errorBox.classList.remove('visible'); }

function setProgress(pct, label) {
  $progressArea.classList.add('visible');
  $('progressBar').style.width = `${pct}%`;
  $('progressLabel').textContent = label;
}

function hideProgress() { $progressArea.classList.remove('visible'); }

// ─── Equivalence Refinement ──────────────────────────────────
// `names` is { pkgA, verA, pkgB, verB } as captured when Compare was clicked
async function refineTarComparison(results, { pkgA, verA, pkgB, verB }) {
  const MAX_SIZE = 1024 * 1024;
  let lastYield = performance.now();
  for (const r of results) {
    if (!r.a?.content || !r.b?.content) continue;
    // Keep the tab responsive on sdists with thousands of files
    if (performance.now() - lastYield > 50) {
      await new Promise(resolve => setTimeout(resolve));
      lastYield = performance.now();
    }
    if (r.status !== 'modified' && !r.needsContentCheck) continue;

    const a = r.a.content, b = r.b.content;

    // Byte comparison (cheap for same-size files)
    if (a.length === b.length) {
      let same = true;
      for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { same = false; break; } }
      if (same) {
        r.status = 'identical';
        delete r.needsContentCheck;
        continue;
      }
    }

    // Normalized comparison — handles name/version/whitespace differences
    if (a.length < MAX_SIZE && b.length < MAX_SIZE && !isBinary(a) && !isBinary(b)) {
      if (contentMatches(textDecoder.decode(a), textDecoder.decode(b), r.path, pkgA, verA, pkgB, verB)) {
        r.status = 'equivalent';
        delete r.needsContentCheck;
        continue;
      }
    }

    r.status = 'modified';
    delete r.needsContentCheck;
  }
}

async function refineWheelComparison(results, { pkgA, verA, pkgB, verB }) {
  if (pkgA === pkgB && verA === verB) return;

  const MAX_SIZE = 1024 * 1024;
  const MAX_FILES = 50;
  // Only refine files where the size difference is plausibly from name/version substitution.
  // Each occurrence of the name/version changes by at most |len(nameA)-len(nameB)| + |len(verA)-len(verB)| bytes.
  // Cap at a generous multiple to allow for many occurrences.
  const nameDelta = Math.abs(pkgA.length - pkgB.length);
  const verDelta = Math.abs(verA.length - verB.length);
  // The extra 64 bytes cover whitespace-only changes when the names are the same length
  const maxExpectedDelta = (nameDelta + verDelta) * 200 + 64; // up to 200 occurrences
  const candidates = results.filter(r => {
    if (r.status !== 'modified' || !r.a || !r.b) return false;
    // Both sizes come from the archive; the compressed one is what gets downloaded
    if ([r.a, r.b].some(e => e.uncompressedSize >= MAX_SIZE || e.compressedSize >= MAX_SIZE)) return false;
    const sizeDelta = Math.abs(r.a.uncompressedSize - r.b.uncompressedSize);
    return sizeDelta <= maxExpectedDelta;
  });
  const suspicious = candidates.slice(0, MAX_FILES);
  state.refineSkipped = candidates.length - suspicious.length;
  const allModified = results.filter(r => r.status === 'modified').length;
  if (suspicious.length === 0) {
    if (allModified > 0) console.log(`[pypi-diff] Skipped refinement: ${allModified} modified file(s) have size deltas too large for name/version substitution (max expected: ${maxExpectedDelta} bytes)`);
    return;
  }

  console.log(`[pypi-diff] Refining ${suspicious.length}/${allModified} modified file(s) via content fetch (name delta: ${nameDelta}, ver delta: ${verDelta})...`);
  setProgress(80, `Checking ${suspicious.length} file(s) for name/version-only differences...`);
  let refined = 0;

  // Process in batches of 4 to avoid overwhelming browser connection limits
  const BATCH = 4;
  for (let i = 0; i < suspicious.length; i += BATCH) {
    const batch = suspicious.slice(i, i + BATCH);
    await Promise.all(batch.map(async r => {
      try {
        const [bufA, bufB] = await Promise.all([
          fetchZipFileContent(state.urlA, r.a),
          fetchZipFileContent(state.urlB, r.b)
        ]);
        if (isBinary(bufA) || isBinary(bufB)) return;
        const textA = textDecoder.decode(bufA);
        const textB = textDecoder.decode(bufB);
        if (contentMatches(textA, textB, r.path, pkgA, verA, pkgB, verB)) {
          r.status = 'equivalent';
          refined++;
        }
      } catch (e) {
        console.warn(`[pypi-diff] Failed to refine ${r.path}:`, e.message);
      }
    }));
  }

  console.log(`[pypi-diff] Refinement complete: ${refined}/${suspicious.length} files marked equivalent`);
}

// ─── App State ───────────────────────────────────────────────
const state = {
  metaA: null, metaB: null,
  archiveA: null, archiveB: null,
  normalizedA: null, normalizedB: null,
  comparison: null,
  urlA: null, urlB: null,
  isWheelA: false, isWheelB: false,
  openFile: null,
  refineSkipped: 0, // modified files past the wheel refinement cap
};

// ─── Wiring ──────────────────────────────────────────────────
const $pkgA = $('pkgA');
const $pkgB = $('pkgB');
const $verA = $('verA');
const $verB = $('verB');
const $fileA = $('fileA');
const $fileB = $('fileB');
const $sizeA = $('sizeA');
const $sizeB = $('sizeB');
const $compareBtn = $('compareBtn');
const $selectors = document.querySelector('.selectors');

function updatePkgLink(side, name) {
  const link = $(side === 'A' ? 'pkgLinkA' : 'pkgLinkB');
  if (name) {
    link.href = `https://pypi.org/project/${encodeURIComponent(name)}/`;
    link.textContent = 'pypi.org';
    link.classList.add('visible');
  } else {
    link.classList.remove('visible');
  }
}

function setupPackageInput(inputEl, verEl, fileEl, sizeEl, side) {
  let timer, pending;
  const lookup = async () => {
    const name = inputEl.value.trim();
    if (!name) return;
    hideError();
    // Cancel the previous lookup so a slower, older response cannot overwrite this one
    pending?.abort();
    const { signal } = pending = new AbortController();
    try {
      const meta = await fetchPackageMeta(name, signal);
      if (side === 'A') state.metaA = meta; else state.metaB = meta;
      populateVersions(meta, verEl);
      verEl.disabled = false;
      verEl.dispatchEvent(new Event('change'));
      updatePkgLink(side, meta.info.name);
    } catch (e) {
      if (signal.aborted) return;
      showError(e.message);
      if (side === 'A') state.metaA = null; else state.metaB = null;
      verEl.disabled = true;
      fileEl.disabled = true;
      sizeEl.textContent = '';
      updatePkgLink(side, null);
      checkReady();
    }
  };

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(lookup, 500);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      lookup();
    }
  });

  verEl.addEventListener('change', () => {
    const meta = side === 'A' ? state.metaA : state.metaB;
    if (!meta) return;
    const ver = verEl.value;
    const files = meta.releases[ver] || [];
    populateFiles(files, fileEl, sizeEl);
    fileEl.disabled = files.length === 0;
    fileEl.dispatchEvent(new Event('change'));
  });

  fileEl.addEventListener('change', () => {
    if (!metaOf(side)) return;
    showSelectedFile(side);
    autoMatchFileType(side);
    checkReady();
  });
}

const SIDES = {
  A: { input: $pkgA, ver: $verA, file: $fileA, size: $sizeA },
  B: { input: $pkgB, ver: $verB, file: $fileB, size: $sizeB },
};
const metaOf = side => side === 'A' ? state.metaA : state.metaB;

// The file selected on a side, or undefined when the side has none
function selectedFile(side) {
  const { ver, file } = SIDES[side];
  const meta = metaOf(side);
  if (!meta || file.disabled) return undefined;
  return (meta.releases[ver.value] || [])[file.selectedIndex];
}

function showSelectedFile(side) {
  const sel = selectedFile(side);
  if (!sel) return;
  const { size } = SIDES[side];
  const warn = sel.size > 50 * 1024 * 1024 && !sel.filename.endsWith('.whl');
  size.textContent = `${fmtSize(sel.size)}${warn ? ' ⚠ Large file – full download required for sdist' : ''}`;
  size.className = `size-note${warn ? ' warn' : ''}`;
}

function populateVersions(meta, selectEl) {
  const versions = getVersions(meta);
  selectEl.innerHTML = '';
  for (const v of versions) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  }
  if (meta.releases[meta.info.version]?.length) selectEl.value = meta.info.version;
}

function populateFiles(files, selectEl, sizeEl) {
  selectEl.innerHTML = '';
  if (files.length === 0) {
    selectEl.innerHTML = '<option>No files</option>';
    sizeEl.textContent = '';
    return;
  }
  for (const f of files) {
    const opt = document.createElement('option');
    opt.textContent = `${f.filename} (${fmtSize(f.size)})`;
    selectEl.appendChild(opt);
  }
  // Trigger size display for first item
  const sel = files[0];
  if (sel) {
    const warn = sel.size > 50 * 1024 * 1024;
    sizeEl.textContent = `${fmtSize(sel.size)}${warn ? ' ⚠ Large file' : ''}`;
    sizeEl.className = `size-note${warn ? ' warn' : ''}`;
  }
}

function fileTypeOf(filename) {
  if (filename.endsWith('.whl')) return '.whl';
  if (filename.endsWith('.tar.gz')) return '.tar.gz';
  if (filename.endsWith('.zip')) return '.zip';
  return null;
}

const selectedType = side => { const sel = selectedFile(side); return sel && fileTypeOf(sel.filename); };

// Selects the first file of `type` on a side. Returns false when it has none.
function selectFileType(side, type) {
  const { ver, file } = SIDES[side];
  const idx = (metaOf(side)?.releases[ver.value] || []).findIndex(f => fileTypeOf(f.filename) === type);
  if (idx < 0) return false;
  file.selectedIndex = idx;
  showSelectedFile(side);
  return true;
}

// Keeps both sides on one archive type: the other side follows the side that
// changed, and when it has no such file the changed side follows it instead.
function autoMatchFileType(fromSide) {
  const other = fromSide === 'A' ? 'B' : 'A';
  const type = selectedType(fromSide), otherType = selectedType(other);
  if (!type || !otherType || type === otherType) return;
  if (!selectFileType(other, type)) selectFileType(fromSide, otherType);
}

let comparing = false; // a comparison is running

function checkReady() {
  $compareBtn.disabled = comparing || !(selectedFile('A') && selectedFile('B'));
  updateUrl();
}

// ─── URL State ──────────────────────────────────────────────
function selectedFilename(meta, verEl, fileEl) {
  if (!meta || fileEl.disabled || fileEl.selectedIndex < 0) return null;
  const files = meta.releases[verEl.value] || [];
  const sel = files[fileEl.selectedIndex];
  return sel ? sel.filename : null;
}

let activeFilter = 'all';

function updateUrl() {
  const params = new URLSearchParams();
  if ($pkgA.value.trim()) params.set('a', $pkgA.value.trim());
  if ($verA.value && !$verA.disabled) params.set('va', $verA.value);
  const fnA = selectedFilename(state.metaA, $verA, $fileA);
  if (fnA) params.set('fa', fnA);
  if ($pkgB.value.trim()) params.set('b', $pkgB.value.trim());
  if ($verB.value && !$verB.disabled) params.set('vb', $verB.value);
  const fnB = selectedFilename(state.metaB, $verB, $fileB);
  if (fnB) params.set('fb', fnB);
  if (activeFilter !== 'all') params.set('tab', activeFilter);
  if (state.openFile) params.set('file', state.openFile);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function setActiveFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.filter === filter);
  });
  renderFileTable(filter);
  updateUrl();
}

async function loadSide(name, version, filename, side) {
  const { input, ver, file, size } = SIDES[side];
  input.value = name;
  const meta = await fetchPackageMeta(name);
  // Check the link before changing the form, so a bad link leaves the side empty
  if (version && !meta.releases[version]?.length) throw new Error(`Version ${version} of "${name}" not found`);
  if (side === 'A') state.metaA = meta; else state.metaB = meta;
  populateVersions(meta, ver);
  if (version) ver.value = version;
  const files = meta.releases[ver.value] || [];
  const idx = filename ? files.findIndex(f => f.filename === filename) : 0;
  if (idx < 0) {
    if (side === 'A') state.metaA = null; else state.metaB = null;
    throw new Error(`File ${filename} not found in "${name}" ${ver.value}`);
  }
  ver.disabled = false;
  updatePkgLink(side, meta.info.name);
  populateFiles(files, file, size);
  file.disabled = files.length === 0;
  file.selectedIndex = idx;
  showSelectedFile(side);
}

async function loadFromUrl() {
  const params = new URLSearchParams(location.search);
  const a = params.get('a'), va = params.get('va'), fa = params.get('fa');
  const b = params.get('b'), vb = params.get('vb'), fb = params.get('fb');
  const tab = params.get('tab'), file = params.get('file');
  if (tab && document.querySelector(`.filter-tab[data-filter="${CSS.escape(tab)}"]`)) activeFilter = tab;
  if (file) state.openFile = file;
  if (!a && !b) return;

  const results = await Promise.allSettled([
    a ? loadSide(a, va, fa, 'A') : null,
    b ? loadSide(b, vb, fb, 'B') : null,
  ]);
  const failed = results.find(r => r.status === 'rejected');
  if (failed) {
    showError(failed.reason.message);
    checkReady();
    // Keep the link that failed in the address bar
    history.replaceState(null, '', location.pathname + '?' + params);
    return;
  }
  // A side the link named no file for follows the other side's archive type
  if (selectedType('A') !== selectedType('B')) {
    if (!(!fb && selectFileType('B', selectedType('A'))) && !fa) selectFileType('A', selectedType('B'));
  }
  checkReady();
  if (!$compareBtn.disabled) $compareBtn.click();
}

setupPackageInput($pkgA, $verA, $fileA, $sizeA, 'A');
setupPackageInput($pkgB, $verB, $fileB, $sizeB, 'B');

// ─── Compare Button ─────────────────────────────────────────
$compareBtn.addEventListener('click', async () => {
  hideError();
  const fileObjA = selectedFile('A'), fileObjB = selectedFile('B');
  if (comparing || !fileObjA || !fileObjB) return checkReady();
  $results.classList.remove('visible');
  // Names and versions as they are now; the form is locked until the run ends
  const names = {
    pkgA: state.metaA.info.name, verA: $verA.value,
    pkgB: state.metaB.info.name, verB: $verB.value,
  };

  const isWhlA = fileObjA.filename.endsWith('.whl');
  const isWhlB = fileObjB.filename.endsWith('.whl');
  const isTarA = fileObjA.filename.endsWith('.tar.gz');
  const isTarB = fileObjB.filename.endsWith('.tar.gz');

  if ((!isWhlA && !isTarA) || (!isWhlB && !isTarB)) {
    return showError('Only .whl and .tar.gz files are supported.');
  }

  if (isWhlA !== isWhlB || isTarA !== isTarB) {
    return showError('Cannot cross-compare wheel and sdist. Select the same archive type on both sides.');
  }

  state.refineSkipped = 0;
  state.urlA = fileObjA.url;
  state.urlB = fileObjB.url;
  state.isWheelA = isWhlA;
  state.isWheelB = isWhlB;

  comparing = true;
  $compareBtn.disabled = true;
  $selectors.inert = true;
  console.log(`[pypi-diff] Comparing ${fileObjA.filename} vs ${fileObjB.filename}`);

  try {
    if (isWhlA) {
      // Wheels: use range requests for file listing
      setProgress(10, 'Reading wheel A central directory...');
      state.archiveA = await fetchZipDirectory(fileObjA.url);
      setProgress(40, 'Reading wheel B central directory...');
      state.archiveB = await fetchZipDirectory(fileObjB.url);
      setProgress(70, 'Comparing file listings...');
    } else {
      // Sdists: full download
      setProgress(5, `Downloading ${fileObjA.filename} (${fmtSize(fileObjA.size)})...`);
      state.archiveA = await fetchAndParseTarGz(fileObjA.url, p => setProgress(5 + p * 30, `Downloading A... ${Math.round(p*100)}%`));

      setProgress(40, `Downloading ${fileObjB.filename} (${fmtSize(fileObjB.size)})...`);
      state.archiveB = await fetchAndParseTarGz(fileObjB.url, p => setProgress(40 + p * 30, `Downloading B... ${Math.round(p*100)}%`));

      setProgress(75, 'Comparing...');
    }

    state.normalizedA = normalizePaths(state.archiveA.entries, state.isWheelA);
    state.normalizedB = normalizePaths(state.archiveB.entries, state.isWheelB);
    console.log(`[pypi-diff] Files: ${state.normalizedA.length} in A, ${state.normalizedB.length} in B`);
    state.comparison = compareFileLists(state.normalizedA, state.normalizedB);

    if (isTarA) await refineTarComparison(state.comparison, names);

    if (isWhlA) await refineWheelComparison(state.comparison, names);

    const counts = {};
    for (const r of state.comparison) counts[r.status] = (counts[r.status] || 0) + 1;
    console.log('[pypi-diff] Results:', counts);

    setProgress(100, 'Done.');
    setTimeout(() => {
      hideProgress();
      renderResults();
      // Auto-open file diff if specified in URL
      if (state.openFile && state.comparison) {
        const row = state.comparison.find(r => r.path === state.openFile);
        if (row) openDiff(row);
        else { state.openFile = null; updateUrl(); }
      }
    }, 300);

  } catch (e) {
    console.error('[pypi-diff] Comparison failed:', e);
    hideProgress();
    showError(e.message);
  } finally {
    comparing = false;
    $selectors.inert = false;
    checkReady();
  }
});


// ─── Theme Toggle ───────────────────────────────────────────
// The stored choice lives in <meta name="color-scheme">; CSS maps it to the
// color-scheme property. An inline script in index.html applies it before
// first paint.
const THEME_KEY = 'pypi-diff-theme';
const THEME_NEXT = { 'light dark': 'light', light: 'dark', dark: 'light dark' };
const THEME_LABELS = { 'light dark': 'Theme: System', light: 'Theme: Light', dark: 'Theme: Dark' };
const $themeMeta = document.querySelector('meta[name="color-scheme"]');
const $themeToggle = $('themeToggle');

function applyTheme(value) {
  $themeMeta.content = value in THEME_LABELS ? value : 'light dark';
  $themeToggle.title = THEME_LABELS[$themeMeta.content];
  $themeToggle.setAttribute('aria-label', THEME_LABELS[$themeMeta.content]);
}
applyTheme($themeMeta.content);

$themeToggle.addEventListener('click', () => {
  const next = THEME_NEXT[$themeMeta.content];
  // Storage access can throw (blocked storage, sandboxed iframe); the theme still applies
  try {
    if (next === 'light dark') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch { /* not persisted */ }
  applyTheme(next);
});

window.addEventListener('storage', e => {
  if (e.key === THEME_KEY) applyTheme(e.newValue ?? 'light dark');
});

// ─── Render Results ──────────────────────────────────────────
const STATUSES = ['modified', 'added', 'removed', 'moved', 'equivalent', 'identical'];
const RING_CIRCUMFERENCE = 2 * Math.PI * 24;
const $results = $('results');
const $fileTableBody = $('fileTableBody');
const $fileRowTemplate = $('fileRowTemplate');
const rowData = new WeakMap(); // <tr> -> comparison row

// Appends text with hidden characters shown as visible markers
function appendVisible(el, text) {
  for (const seg of hiddenCharSegments(text)) {
    if (typeof seg === 'string') {
      el.append(seg);
    } else {
      const mark = document.createElement('span');
      mark.className = 'hidden-char';
      mark.textContent = seg.hidden;
      el.append(mark);
    }
  }
}

function renderResults() {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of state.comparison) counts[r.status]++;
  for (const s of STATUSES) $(`count-${s}`).textContent = counts[s];

  const total = state.comparison.length;
  const similar = counts.identical + counts.equivalent + counts.moved;
  // Only a full match reads 100%: one differing file in 200 must not round up
  const similarity = similar === total ? 100 : Math.min(99, Math.floor((similar / total) * 100));
  $('similarityRing').dataset.level = similarity < 50 ? 'low' : similarity < 80 ? 'mid' : 'high';
  $('similarityArc').setAttribute('stroke-dasharray', `${(similarity / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`);
  $('similarityPct').textContent = `${similarity}%`;

  $('refineNote').textContent = state.refineSkipped
    ? `${state.refineSkipped} modified file(s) were not checked for name/version-only differences (limit of 50 per comparison) and may be equivalent.`
    : '';

  setActiveFilter(activeFilter);
  $results.classList.add('visible');
}

function similarityCell(cell, r) {
  if (r.status === 'identical') {
    cell.textContent = '100%';
    cell.classList.add('sim-identical');
  } else if (r.status === 'equivalent') {
    cell.textContent = '~100%';
    cell.classList.add('sim-equivalent');
    cell.title = 'Differs only in package name, version, or whitespace';
  } else if (r.status === 'modified' && r.a && r.b) {
    // A modified file is never shown as 100%: the figure is a size ratio, and the content differs
    const maxSize = Math.max(r.a.uncompressedSize, r.b.uncompressedSize);
    const pct = maxSize > 0 ? Math.min(99, Math.round(Math.min(r.a.uncompressedSize, r.b.uncompressedSize) / maxSize * 100)) : 99;
    cell.textContent = `${pct}%`;
    cell.classList.add(pct >= 80 ? 'sim-high' : 'sim-low');
  } else {
    cell.textContent = '—';
  }
}

function renderFileTable(filter) {
  const items = filter === 'all' ? state.comparison : state.comparison.filter(r => r.status === filter);
  const frag = document.createDocumentFragment();

  for (const r of items) {
    const tr = $fileRowTemplate.content.firstElementChild.cloneNode(true);
    const [path, sizeA, sizeB, status, similarity] = tr.children;
    appendVisible(path, r.path);
    if (r.status === 'moved') {
      const from = document.createElement('span');
      from.className = 'moved-from';
      appendVisible(from, `from ${r.movedFrom}`);
      path.append(from);
    }
    sizeA.textContent = r.a ? fmtSize(r.a.uncompressedSize) : '—';
    sizeB.textContent = r.b ? fmtSize(r.b.uncompressedSize) : '—';
    status.firstElementChild.textContent = r.status;
    status.firstElementChild.classList.add(r.status);
    similarityCell(similarity, r);
    rowData.set(tr, r);
    frag.append(tr);
  }
  $fileTableBody.replaceChildren(frag);
}

function openRowDiff(e) {
  const tr = e.target.closest('tr');
  if (tr) openDiff(rowData.get(tr));
}
$fileTableBody.addEventListener('click', openRowDiff);
$fileTableBody.addEventListener('keydown', e => { if (e.key === 'Enter') openRowDiff(e); });

$('filterTabs').addEventListener('click', e => {
  if (!e.target.matches('.filter-tab')) return;
  setActiveFilter(e.target.dataset.filter);
});

// ─── Diff Dialog ─────────────────────────────────────────────
const $dialog = $('diffDialog');
const $diffContent = $('diffContent');
const $diffFilepath = $('diffFilepath');
const $diffMinimap = $('diffMinimap');
let diffAbort = null; // cancels the fetches and the worker of the diff being loaded

$('diffClose').addEventListener('click', () => $dialog.close());
$dialog.addEventListener('close', () => {
  diffAbort?.abort();
  state.openFile = null;
  updateUrl();
});

// Click-outside for browsers without <dialog closedby>. Tests the pointer
// position, and needs press and release outside so a text selection that ends
// on the backdrop does not dismiss.
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = e => {
    const r = $dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  $dialog.addEventListener('pointerdown', e => { pressedOutside = outside(e); });
  $dialog.addEventListener('pointerup', e => { if (pressedOutside && outside(e)) $dialog.close(); });
}

// jsdiff runs in a worker so a large file does not freeze the page
function diffInWorker(textA, textB, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./diff-worker.js', import.meta.url), { type: 'module' });
    const finish = settle => value => { worker.terminate(); settle(value); };
    worker.onmessage = e => finish(resolve)(e.data);
    worker.onerror = e => finish(reject)(new Error(e.message || 'Diff failed'));
    signal.addEventListener('abort', () => finish(reject)(signal.reason), { once: true });
    worker.postMessage({ textA, textB });
  });
}

function diffMessage(text) {
  const el = document.createElement('div');
  el.className = 'diff-binary';
  el.textContent = text;
  return el;
}

// Builds the diff DOM from computeDiff() parts. Returns the hunks for the minimap.
function buildDiff(parts) {
  const frag = document.createDocumentFragment();
  const hunks = []; // { startLine, endLine, type }
  let lineA = 1, lineB = 1;
  let lineIdx = 0; // total rendered lines (for minimap positioning)
  let inHunk = false;

  for (const part of parts) {
    const isChange = part.added || part.removed;
    if (isChange && !inHunk) {
      hunks.push({ startLine: lineIdx, endLine: lineIdx, type: part.added ? 'add' : 'del' });
      inHunk = true;
    } else if (isChange) {
      // Extend hunk; upgrade type to 'mixed' if both add and del
      const h = hunks.at(-1);
      if ((part.added && h.type === 'del') || (part.removed && h.type === 'add')) h.type = 'mixed';
    } else {
      inHunk = false;
    }

    for (const [i, text] of part.lines.entries()) {
      const line = document.createElement('span');
      const ln = document.createElement('span');
      ln.className = 'ln';
      if (part.added) {
        line.className = 'diff-line add';
        ln.textContent = lineB++;
      } else if (part.removed) {
        line.className = 'diff-line del';
        ln.textContent = lineA++;
      } else {
        line.className = 'diff-line ctx';
        ln.textContent = lineA++;
        lineB++;
      }
      line.append(ln, part.added ? '+' : part.removed ? '-' : ' ');
      const segments = part.inline?.[i];
      if (segments) {
        // Words changed inside the line get a stronger highlight
        for (const seg of segments) {
          if (!seg.changed) { appendVisible(line, seg.text); continue; }
          const mark = document.createElement('span');
          mark.className = 'chg';
          appendVisible(mark, seg.text);
          line.append(mark);
        }
      } else {
        appendVisible(line, text);
      }
      if (isChange) {
        line.dataset.hunk = hunks.length - 1;
        hunks.at(-1).endLine = lineIdx;
      }
      frag.append(line);
      lineIdx++;
    }
  }

  return { frag, hunks, totalLines: lineIdx };
}

function buildMinimap(hunks, totalLines) {
  if (!hunks.length || !totalLines) return;
  const mapHeight = $diffMinimap.clientHeight || 400;
  $diffMinimap.replaceChildren(...hunks.map((h, i) => {
    const el = document.createElement('div');
    el.className = `diff-minimap-hunk ${h.type}`;
    el.dataset.hunkIdx = i;
    el.style.top = `${(h.startLine / totalLines) * mapHeight}px`;
    el.style.height = `${Math.max(3, ((h.endLine - h.startLine + 1) / totalLines) * mapHeight)}px`;
    return el;
  }));
}

$diffMinimap.addEventListener('click', e => {
  const el = e.target.closest('.diff-minimap-hunk');
  if (!el) return;
  const target = $diffContent.querySelector(`[data-hunk="${el.dataset.hunkIdx}"]`);
  if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

async function openDiff(row, asText = false) {
  diffAbort?.abort();
  const { signal } = diffAbort = new AbortController();
  $diffFilepath.replaceChildren();
  appendVisible($diffFilepath, row.path);
  state.openFile = row.path;
  updateUrl();
  if (!$dialog.open) $dialog.showModal();
  $diffContent.replaceChildren($('diffLoadingTemplate').content.cloneNode(true));
  $diffMinimap.replaceChildren();

  const load = (entry, isWheel, url) => {
    if (!entry) return null;
    if (entry.content) return entry.content;
    return isWheel ? fetchZipFileContent(url, entry, signal) : null;
  };

  try {
    const bufA = await load(row.a, state.isWheelA, state.urlA);
    const bufB = await load(row.b, state.isWheelB, state.urlB);
    signal.throwIfAborted();

    if (!asText && ((bufA && isBinary(bufA)) || (bufB && isBinary(bufB)))) {
      const sizes = `Size A: ${bufA ? fmtSize(bufA.length) : 'absent'}, Size B: ${bufB ? fmtSize(bufB.length) : 'absent'}`;
      const notice = diffMessage(`Binary file — content diff not shown. ${sizes}`);
      const showText = document.createElement('button');
      showText.type = 'button';
      showText.className = 'btn';
      showText.textContent = 'Show as text anyway';
      showText.addEventListener('click', () => openDiff(row, true));
      notice.append(showText);
      $diffContent.replaceChildren(notice);
      return;
    }

    // An added or removed row diffs against nothing, whichever side holds the content
    const textA = bufA && row.status !== 'added' ? normalizeContent(textDecoder.decode(bufA)) : '';
    const textB = bufB && row.status !== 'removed' ? normalizeContent(textDecoder.decode(bufB)) : '';
    const { frag, hunks, totalLines } = buildDiff(await diffInWorker(textA, textB, signal));
    $diffContent.replaceChildren(totalLines ? frag : diffMessage('Empty file'));
    buildMinimap(hunks, totalLines);
    requestAnimationFrame(() => {
      $diffContent.querySelector('.diff-line.add, .diff-line.del')?.scrollIntoView({ block: 'center' });
    });
  } catch (e) {
    if (signal.aborted) return;
    $diffContent.replaceChildren(diffMessage(`Error loading content: ${e.message}`));
  }
}

// ─── Load from URL params on startup ────────────────────────
loadFromUrl();
