#!/usr/bin/env python3
"""
pypi-diff proxy server

Serves the app (index.html, favicon.svg, js/, css/, vendor/) and proxies files.pythonhosted.org requests. The proxy
is useful if PyPI's CORS headers regress, or for testing against the
pre-CORS-fix behavior.

Usage:
    python serve.py [--port 8000] [--bind 127.0.0.1]
"""

import argparse
import http.server
import os
import socket
import sys
import urllib.error
import urllib.request

PROXY_PREFIX = "/proxy/files.pythonhosted.org/"
ALLOWED_ORIGIN = "*"
ROOT = os.path.dirname(os.path.realpath(__file__))
STATIC_FILES = tuple(os.path.join(ROOT, f) for f in ("index.html", "favicon.svg"))
STATIC_DIRS = tuple(os.path.join(ROOT, d) + os.sep for d in ("js", "css", "vendor"))


CONTROL_CHARS = {c: f"\\x{c:02x}" for c in [*range(0x20), *range(0x7F, 0xA0)]}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """The proxy only ever talks to files.pythonhosted.org."""

    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


class PyPIDiffHandler(http.server.SimpleHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Accept-Encoding")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def _is_app_file(self):
        # Only the app's own files are served; the directory also holds .git.
        # Check the file the base class would open, not the URL, so the two
        # cannot disagree about "..", encodings, queries or fragments.
        if self.path.split("?", 1)[0].split("#", 1)[0] in ("/", ""):
            self.path = "/index.html"
        target = os.path.realpath(self.translate_path(self.path))
        if target in STATIC_FILES or target.startswith(STATIC_DIRS):
            return True
        self.send_error(404)
        return False

    def do_HEAD(self):
        if self.path.startswith(PROXY_PREFIX):
            self._proxy("HEAD")
        elif self._is_app_file():
            super().do_HEAD()

    def do_GET(self):
        if self.path.startswith(PROXY_PREFIX):
            self._proxy("GET")
        elif self._is_app_file():
            super().do_GET()

    def send_response(self, code, message=None):
        # Disable browser caching for static files served in dev.
        # self.path is unset when the request line is malformed.
        super().send_response(code, message)
        if not getattr(self, "path", "").startswith(PROXY_PREFIX):
            self.send_header("Cache-Control", "no-store, must-revalidate")

    def _proxy(self, method):
        remote_path = self.path[len(PROXY_PREFIX):]
        if not remote_path:
            # Availability probe from the frontend; answered without going upstream.
            self.send_response(204)
            self._send_cors_headers()
            self.end_headers()
            return
        remote_url = f"https://files.pythonhosted.org/{remote_path}"

        req = urllib.request.Request(remote_url, method=method)
        req.add_header("Accept-Encoding", "identity")

        range_hdr = self.headers.get("Range")
        if range_hdr:
            req.add_header("Range", range_hdr)

        # Once the response headers are out, an error can only be logged: writing
        # an error response would put a second status line inside the body.
        started = False
        try:
            with OPENER.open(req, timeout=30) as resp:
                started = True
                self.send_response(resp.status)
                self._send_cors_headers()
                for hdr in ("Content-Type", "Content-Length", "Content-Range",
                            "Accept-Ranges", "ETag", "Last-Modified"):
                    val = resp.headers.get(hdr)
                    if val:
                        self.send_header(hdr, val)
                self.end_headers()

                if method == "GET":
                    sent = 0
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        sent += len(chunk)
                    expected = resp.headers.get("Content-Length")
                    if expected and expected.isdigit() and sent != int(expected):
                        self.log_error("proxy stream ended early: %d of %s bytes", sent, expected)

        except urllib.error.HTTPError as e:
            self._send_error_response(e.code, f"Upstream error: {e.code} {e.reason}")
        except Exception as e:
            if started:
                self.log_error("proxy stream aborted: %r", e)
            else:
                self._send_error_response(502, f"Proxy error: {e}")

    def _send_error_response(self, code, message):
        self.send_response(code)
        self._send_cors_headers()
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(message.encode())

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("X-PyPI-Diff-Proxy", "1")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Length, Content-Range, Accept-Ranges")

    def log_message(self, format, *args):
        # The request line is client-controlled: escape control characters so
        # they cannot reach the terminal as escape sequences
        msg = (format % args).translate(CONTROL_CHARS)
        if PROXY_PREFIX in msg:
            sys.stderr.write(f"\033[36m[proxy]\033[0m  {msg}\n")
        else:
            sys.stderr.write(f"\033[90m[static]\033[0m {msg}\n")


def main():
    parser = argparse.ArgumentParser(description="pypi-diff local server with CORS proxy")
    parser.add_argument("--port", "-p", type=int, default=8000)
    parser.add_argument("--bind", "-b", default="127.0.0.1",
                        help="Address to bind (default: 127.0.0.1)")
    args = parser.parse_args()

    os.chdir(ROOT)

    class Server(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in args.bind else socket.AF_INET

    with Server((args.bind, args.port), PyPIDiffHandler) as httpd:
        host = f"[{args.bind}]" if ":" in args.bind else args.bind
        url = f"http://{host}:{args.port}"
        print(f"\033[1mpypi-diff\033[0m running at \033[4m{url}\033[0m")
        print("  Serving:  index.html, favicon.svg, js/, css/, vendor/")
        print(f"  Proxying: {PROXY_PREFIX}* → https://files.pythonhosted.org/*")
        print(f"  Press Ctrl+C to stop\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
