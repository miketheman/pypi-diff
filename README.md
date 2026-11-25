# pypi-diff

Compare two PyPI packages, or two versions of one package, in the browser. It shows which files were added, removed, moved or changed, and opens a line diff for any file.

Live at <https://miketheman.github.io/pypi-diff/>.

It was built for looking into reports that one package copies another. Files that differ only by the package name, version or whitespace are marked "equivalent", so a renamed copy stands out from a real fork.

## Using it

Type a package name on each side, pick a version and a file, then compare. Both sides must be wheels (`.whl`) or both sdists (`.tar.gz`).

For a project that PyPI has quarantined, the name lookup returns 404. Paste a `files.pythonhosted.org` file URL in place of the name.

The address bar updates as you go, so any comparison can be shared as a link:

```
https://miketheman.github.io/pypi-diff/?a=requests&va=2.31.0&b=requests&vb=2.32.0
```

## How it works

Everything runs in your browser. Package data comes from `pypi.org` and `files.pythonhosted.org`. The only other request is for the fonts, from Google Fonts.

Wheels are ZIP files, so the page reads only the file listing at the end of the archive with HTTP range requests, and fetches a file's content when you open its diff. A 100 MB wheel lists as fast as a small one. Sdists are downloaded in full.

Packages are never installed, imported or executed. Their contents are treated as untrusted: hidden Unicode control characters are shown as markers, duplicate archive entries are listed separately, and decompression has a size limit. Archives built in ways the parsers do not handle are rejected with an error.

For wheels, "identical" means the size and CRC-32 in the archive's directory match. The content is not downloaded, and a CRC-32 can be forged, so open a file to see its real content.

## Running locally

There is no build step and nothing to install.

```bash
python -m http.server
```

Then open <http://127.0.0.1:8000>. Opening `index.html` as a `file://` URL does not work, because browsers block its requests to PyPI.

`python serve.py` does the same and adds a local proxy for `files.pythonhosted.org`, in case PyPI's CORS headers ever change.

## Tests

```bash
node --test
```

## Security

See [SECURITY.md](SECURITY.md). Reports about packages on PyPI do not belong here.

## License

[MIT](LICENSE). The bundled [jsdiff](https://github.com/kpdecker/jsdiff) is BSD-3-Clause, see `vendor/diff.LICENSE`.
