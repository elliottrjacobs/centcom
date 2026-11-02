#!/usr/bin/env python3
"""Serve an ad hoc iOS install page (manifest + IPA) on loopback, for a TLS front end to expose.

Only for installing your own development builds on your own registered devices; everyone else
installs through TestFlight or the App Store.
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class InstallHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".plist": "text/xml",
        ".ipa": "application/octet-stream",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        self.log_message('%s %s %s agent=%s', self.command, self.path, code,
                         self.headers.get("User-Agent", "unknown"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    handler = partial(InstallHandler, directory=args.directory)
    ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()
