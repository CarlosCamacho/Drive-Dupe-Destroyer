#!/usr/bin/env python3
# Drive Dupe Destroyer (DDD) v14.0 — serve_secure.py
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
serve_secure.py — Drive Dupe Destroyer v14.0
Serves the app on localhost:8080 with all required security headers.

Usage: python3 serve_secure.py
Then open: http://localhost:8080

This enables:
  - SharedArrayBuffer (SAB) — zero-copy hash transfers
  - Full Content-Security-Policy
  - COOP/COEP headers required for SAB
"""
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8080

class SecureHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # COOP + COEP: required for SharedArrayBuffer
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # Standard security headers
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        # CSP
        self.send_header("Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' https://accounts.google.com https://*.googleapis.com; "
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
            "font-src 'self' https://cdnjs.cloudflare.com data:; "
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
        # Quieter logging — only show non-asset requests
        path = args[0].split(" ")[1] if args else ""
        if any(path.endswith(ext) for ext in [".js", ".css", ".png", ".ico", ".woff2"]):
            return
        super().log_message(format, *args)

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = HTTPServer(("localhost", PORT), SecureHandler)
    print(f"\n  Drive Dupe Destroyer v14.0")
    print(f"  ─────────────────────────────────────────")
    print(f"  Serving at:          http://localhost:{PORT}")
    print(f"  Security headers:    ✓ COOP/COEP/CSP")
    print(f"  SharedArrayBuffer:   ✓ Enabled")
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
