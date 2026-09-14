#!/usr/bin/env python3
# Drive Dupe Destroyer (DDD) — serve_secure.py
#
# Copyright (c) 2026 Carlos Camacho
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
#
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Noncommercial use only: you may use, copy, modify, and share this
# software for any noncommercial purpose. Commercial use — including
# selling it or hosting it as a paid product or service — is NOT permitted.
# Full terms: see the LICENSE file, or
# https://polyformproject.org/licenses/noncommercial/1.0.0/

"""
serve_secure.py — Drive Dupe Destroyer
Serves the app on localhost:8080 with all required security headers.

Usage: python3 serve_secure.py
Then open: http://localhost:8080

This enables:
  - SharedArrayBuffer (SAB) — zero-copy hash transfers
  - Full Content-Security-Policy
  - COOP/COEP headers required for SAB
"""
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8080

# Google script hosts. apis.google.com serves the Picker loader and is a
# DIFFERENT registrable domain from googleapis.com, so "*.googleapis.com" does
# not cover it -- the same reason accounts.google.com is listed separately.
SCRIPT_HOSTS = "https://accounts.google.com https://apis.google.com https://*.googleapis.com"

ROOT = os.path.dirname(os.path.abspath(__file__))


def app_version(default="unknown"):
    """Read APP_VERSION out of js/util.js, the single source of truth.

    Parsing the constant keeps this script from being one more place that has to
    be remembered on a release. If the format ever changes, we fall back to
    printing "unknown" rather than failing to start the dev server.
    """
    try:
        src = open(os.path.join(ROOT, "js", "util.js"), encoding="utf-8").read()
    except OSError:
        return default
    m = re.search(r'export\s+const\s+APP_VERSION\s*=\s*["\']([^"\']+)["\']', src)
    return m.group(1) if m else default

class SecureHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Cross-Origin-Opener-Policy: same-origin-allow-popups.
        #
        # This is the value Google documents for the Sign In With Google popup
        # flow, which returns the OAuth token to its opener. We use it because
        # it is the documented value and is strictly more permissive for popups,
        # so it cannot break sign-in on any browser.
        #
        # CORRECTION (v14.1.2): an earlier version of this comment claimed
        # "same-origin" BROKE sign-in and that this change fixed it. That was
        # asserted from Google's documentation, never observed. It was then
        # tested directly with "same-origin" restored, and sign-in worked fine.
        # So this setting is defensive, not a bug fix -- do not repeat the claim
        # that the old value was broken.
        #
        # Cross-Origin-Embedder-Policy is not sent. require-corp would enable
        # SharedArrayBuffer (it needs crossOriginIsolated, i.e. COOP same-origin
        # + COEP require-corp), but it also blocks any cross-origin subresource
        # that does not carry a Cross-Origin-Resource-Policy header. Whether
        # Drive's thumbnail CDN sends one has NOT been verified here -- treat
        # that as an open question, not established fact. Leaving COEP off only
        # removes a restriction, so it is safe either way; the app has never
        # needed SAB, and shared-worker-pool.js falls back to postMessage.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
        # Standard security headers
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        # CSP
        self.send_header("Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' " + SCRIPT_HOSTS + "; "
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.lineicons.com; "
            "font-src 'self' https://cdnjs.cloudflare.com https://cdn.lineicons.com data:; "
            "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com "
                "https://accounts.google.com https://content.googleapis.com; "
            "img-src 'self' blob: data: https://lh3.googleusercontent.com "
                "https://www.googleapis.com https://*.googleusercontent.com; "
            "frame-src https://accounts.google.com https://*.google.com; "
            "worker-src 'self' blob:; "
            "object-src 'none'; "
            "base-uri 'self';"
        )
        super().end_headers()

    def log_message(self, format, *args):
        # Quieter logging — only show non-asset requests.
        # args[0] is the raw request line; a malformed one may not have a path
        # field at all, so index defensively rather than raising inside the logger.
        parts = args[0].split(" ") if args else []
        path = parts[1] if len(parts) > 1 else ""
        if any(path.endswith(ext) for ext in [".js", ".css", ".png", ".ico", ".woff2"]):
            return
        super().log_message(format, *args)

if __name__ == "__main__":
    os.chdir(ROOT)
    version = app_version()
    server = HTTPServer(("localhost", PORT), SecureHandler)
    print(f"\n  Drive Dupe Destroyer v{version}")
    print(f"  ─────────────────────────────────────────")
    print(f"  Serving at:          http://localhost:{PORT}")
    print(f"  Security headers:    ✓ COOP (allow-popups) + CSP")
    print(f"  SharedArrayBuffer:   — disabled (cross-origin isolation not enabled)")
    print(f"")
    print(f"  ⚠  ISOLATION NOTE:")
    print(f"  If Drive Dupe Decimator also runs on port 8080,")
    print(f"  use different ports to prevent Service Worker conflicts:")
    print(f"    Destroyer → port 8080  (this server)")
    print(f"    Decimator → port 8081  (run its server with PORT=8081)")
    print(f"  Both apps store data under separate namespaced keys.")
    print(f"\n  Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        sys.exit(0)
