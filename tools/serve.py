"""Local static server for dist/ with explicit UTF-8 charsets (Windows browsers otherwise guess GBK).
Usage: python tools/serve.py [port] [--log]"""
import http.server, socketserver, sys, functools
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / "dist"
LOG = "--log" in sys.argv


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if LOG:
            sys.stderr.write("%s\n" % (fmt % args))


def main():
    port = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8090)
    handler = functools.partial(Handler, directory=str(DIST))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"LifeLine 2090: http://127.0.0.1:{port}/", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
