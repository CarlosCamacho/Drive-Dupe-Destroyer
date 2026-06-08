#!/usr/bin/env python3
# Drive Dupe Destroyer (DDD) v14.0 — patch_decimator.py
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
patch_decimator.py — Drive Dupe Decimator namespace fix
Run from INSIDE your Decimator folder: python3 patch_decimator.py

Namespaces all IndexedDB, Cache, and settings keys so Destroyer and Decimator
don't collide when both run on http://localhost:8080.
"""
import os
import sys

replacements = [
    ("js/db.js",        '"ddd_db_v8"',                  '"drive_dupe_decimator_db_v1"'),
    ("js/db.js",        '"ddd_db_v9"',                  '"drive_dupe_decimator_db_v1"'),
    ("js/db.js",        '"drive_changes_token"',         '"decimator_drive_changes_token"'),
    ("js/auth.js",      '"oauth_client_id"',             '"decimator_oauth_client_id"'),
    ("js/settings.js",  '"scan_settings_v1"',            '"decimator_scan_settings_v1"'),
    ("js/app.js",       '"app_theme"',                   '"decimator_app_theme"'),
    ("js/app.js",       "'app_theme'",                   "'decimator_app_theme'"),
    ("js/resume.js",    '"scan_resume_v1"',              '"decimator_scan_resume_v1"'),
    ("js/rejection.js", '"rejected_pairs_v1"',           '"decimator_rejected_pairs_v1"'),
    ("js/security.js",  '"oauth_csrf_state"',            '"decimator_oauth_csrf_state"'),
    ("js/security.js",  "'oauth_csrf_state'",            "'decimator_oauth_csrf_state'"),
    # SW cache — try common version strings
    ("sw.js",           '"ddd-v2.0"',                   '"drive-dupe-decimator-v2.0"'),
    ("sw.js",           '"ddd-v2.0.0"',                 '"drive-dupe-decimator-v2.0"'),
    ("sw.js",           '"ddd-v2.1"',                   '"drive-dupe-decimator-v2.1"'),
    ("sw.js",           '"ddd-v2.2"',                   '"drive-dupe-decimator-v2.2"'),
]

def patch(root):
    changed = []
    skipped = []

    for rel_path, find, replace in replacements:
        path = os.path.join(root, rel_path)
        if not os.path.exists(path):
            skipped.append(rel_path)
            continue
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
        if find in src:
            patched = src.replace(find, replace)
            with open(path, "w", encoding="utf-8") as f:
                f.write(patched)
            changed.append(f"  ✓  {rel_path}: {find} → {replace}")
        # else: key not present, skip silently

    return changed, skipped

if __name__ == "__main__":
    root = os.path.dirname(os.path.abspath(__file__))
    print(f"\nPatching Decimator at: {root}\n")
    changed, skipped = patch(root)

    if changed:
        print("Changes applied:")
        for c in changed:
            print(c)
    else:
        print("Nothing patched — keys may already be namespaced.")

    missing = [s for s in set(r[0] for r in replacements) if not os.path.exists(os.path.join(root, s))]
    if missing:
        print(f"\nFiles not found (skipped): {', '.join(set(missing))}")

    print("\n✓ Done.")
    print("  ⚠  You will need to re-enter your Decimator Client ID once (it moved to a new key).")
    print("  ⚠  Clear the Decimator's cache once from inside the app after patching.")
    print()
