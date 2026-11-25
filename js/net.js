import { fmtSize } from './util.js';

// ─── Proxy Detection ─────────────────────────────────────────
// serve.py exposes /proxy/files.pythonhosted.org/* as a fallback in case
// PyPI's CORS headers regress. It only ever runs locally, so a deployed
// static site (GitHub Pages) never probes for it.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
let proxyProbe;
function proxyAvailable() {
  if (!LOCAL_HOSTS.includes(location.hostname)) return false;
  proxyProbe ??= fetch('/proxy/files.pythonhosted.org/', { method: 'HEAD' })
    .then(r => r.headers.has('x-pypi-diff-proxy'), () => false);
  return proxyProbe;
}

export async function proxyUrl(url) {
  if (!(await proxyAvailable())) return url;
  const m = url.match(/^https?:\/\/files\.pythonhosted\.org\/(.*)$/);
  return m ? `/proxy/files.pythonhosted.org/${m[1]}` : url;
}

// ─── PyPI API ────────────────────────────────────────────────
// A files.pythonhosted.org URL stands in for a package name when the JSON API
// has no entry (quarantined projects return 404). Name and version come from
// the filename.
export function metaFromFileUrl(url) {
  const filename = decodeURIComponent(new URL(url).pathname.split('/').pop());
  let name, version;
  if (filename.endsWith('.whl')) {
    [name, version] = filename.split('-');
  } else {
    const stem = filename.replace(/\.(tar\.gz|zip)$/, '');
    const dash = stem.lastIndexOf('-');
    if (dash < 0) throw new Error(`Cannot parse name and version from "${filename}"`);
    name = stem.slice(0, dash);
    version = stem.slice(dash + 1);
  }
  if (!name || !version) throw new Error(`Cannot parse name and version from "${filename}"`);
  return { info: { name }, releases: { [version]: [{ filename, url }] } };
}

export async function fetchPackageMeta(name, signal) {
  if (name.startsWith('https://files.pythonhosted.org/')) return metaFromFileUrl(name);
  const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal });
  if (!r.ok) throw new Error(`Package "${name}" not found (HTTP ${r.status})`);
  return r.json();
}

export function getVersions(meta) {
  return Object.keys(meta.releases)
    .filter(v => meta.releases[v].length > 0)
    .sort((a, b) => {
      // crude PEP 440 sort – newest first
      const pa = a.split(/[.\-a-z]/i).map(Number);
      const pb = b.split(/[.\-a-z]/i).map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0, db = pb[i] || 0;
        if (da !== db) return db - da;
      }
      return b.localeCompare(a);
    });
}

// ─── Decompression (native Compression Streams API) ─────────
// maxBytes bounds the output: archive contents are untrusted, and a small
// deflate/gzip bomb would otherwise expand until the tab dies.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_SDIST_BYTES = 500 * 1024 * 1024;
export async function decompress(data, format, maxBytes) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  // Feed the input in small awaited slices. Browsers inflate a whole chunk
  // before the reader below runs, so one large write would defeat the limit.
  (async () => {
    for (let i = 0; i < data.length; i += 16384) await writer.write(data.subarray(i, i + 16384));
    await writer.close();
  })().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (e) {
      // Stricter than Python, which accepts trailing bytes and multi-member gzip
      throw new Error(`Decompression failed (${e.message}). Python may still be able to read this archive.`);
    }
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error(`Decompressed size exceeds the ${fmtSize(maxBytes)} limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export async function fetchRange(url, start, end, signal) {
  const resp = await fetch(url, { headers: { 'Range': `bytes=${start}-${end}` }, signal });
  if (resp.status !== 206) throw new Error(`Range request failed (HTTP ${resp.status})`);
  return resp;
}
