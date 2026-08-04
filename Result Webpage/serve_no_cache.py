"""
serve_no_cache.py — static file server for this folder that tells every
browser (including embedded webviews like VS Code's Simple Browser, which
don't always honor a manual hard-refresh) to never cache anything.

Plain `python -m http.server` sends no explicit Cache-Control header, so
browsers are free to reuse a stale copy of a JS/CSS file after it's been
edited on disk -- this happened during development (election map controls/
tooltip kept showing old code after edits). This script exists solely to
close that gap; it's still just a static file server, same directory
layout requirements as before (run from `Result Webpage/`, not
`election-site/` -- see election-site/BUILD_NOTES.md).
"""

import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    # ThreadingHTTPServer, not HTTPServer: a page load here fires ~25-30
    # concurrent requests (a dozen-plus small ES module files, several CSVs).
    # Plain HTTPServer handles one at a time, so the browser's parallel
    # requests just queue behind each other -- that queuing, not payload
    # size, dominates the "Time" column on a page load. Doesn't affect
    # production at all (Render's CDN already serves concurrently); this is
    # purely so local testing reflects real load time instead of an
    # artificial single-threaded bottleneck.
    server = ThreadingHTTPServer(("localhost", port), NoCacheHandler)
    print(f"Serving (no-cache) on http://localhost:{port}/ ...")
    print(f"Open: http://localhost:{port}/election-site/index.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
