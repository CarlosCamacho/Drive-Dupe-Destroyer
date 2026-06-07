<!-- Drive Dupe Destroyer v12.8 — NAMESPACE_PATCH_FOR_DECIMATOR.md -->
# Namespace Patch — Drive Dupe Decimator

## The Problem

Both Drive Dupe Destroyer and Drive Dupe Decimator run on `http://localhost:8080`.
Because they share the same browser origin, they also share:

| Storage | Issue |
|---|---|
| IndexedDB database `ddd_db_v8` | Both apps open the same DB — hash caches, settings, and OAuth tokens bleed between them |
| Service Worker | Whichever app you opened last controls `localhost:8080/*` for BOTH apps |
| Settings key `oauth_client_id` | Both apps read/write the same Client ID entry |
| Settings key `scan_settings_v1` | Scan settings from one app overwrite the other's |
| Settings key `app_theme` | Theme changes in one affect the other |
| Settings key `drive_changes_token` | Delta scan token from one app corrupts the other's |

## Destroyer v12 is Already Fixed

Drive Dupe Destroyer v12 uses fully namespaced storage:
- **IndexedDB:** `drive_dupe_destroyer_db_v1`
- **Service Worker cache:** `drive-dupe-destroyer-v12.0`
- **All settings keys prefixed:** `destroyer_*`

## Fixing the Decimator

Apply this search-and-replace in the Decimator's source files:

### 1. js/db.js — Change the database name

Find:
```javascript
const DB_NAME = "ddd_db_v8";
```
Replace with:
```javascript
const DB_NAME = "drive_dupe_decimator_db_v1";
```

### 2. js/auth.js — Namespace the OAuth Client ID key

Find:
```javascript
const CLIENT_ID_KEY = "oauth_client_id";
```
Replace with:
```javascript
const CLIENT_ID_KEY = "decimator_oauth_client_id";
```

**Important:** After this change, the Decimator won't find the previously stored Client ID.
You'll need to re-enter it once. It will then be stored under the new key and won't conflict.

### 3. js/settings.js — Namespace scan settings

Find all occurrences of:
```javascript
"scan_settings_v1"
```
Replace with:
```javascript
"decimator_scan_settings_v1"
```

### 4. js/app.js — Namespace the theme key

Find:
```javascript
settingGet("app_theme"
settingSet("app_theme"
```
Replace with:
```javascript
settingGet("decimator_app_theme"
settingSet("decimator_app_theme"
```

### 5. js/db.js — Namespace the changes token (if present)

Find:
```javascript
settingGet("drive_changes_token"
settingSet("drive_changes_token"
settingDel("drive_changes_token"
```
Replace with:
```javascript
settingGet("decimator_drive_changes_token"
settingSet("decimator_drive_changes_token"
settingDel("decimator_drive_changes_token"
```

### 6. sw.js — Namespace the cache name

Find:
```javascript
const CACHE_NAME = "ddd-v2.0";  // or whatever version string is there
```
Replace with:
```javascript
const CACHE_NAME = "drive-dupe-decimator-v2.0";
```

### 7. js/resume.js and js/rejection.js (if present)

Any keys like `"scan_resume_v1"` or `"rejected_pairs_v1"` should be prefixed:
- `"decimator_scan_resume_v1"`
- `"decimator_rejected_pairs_v1"`

### 8. js/security.js — sessionStorage key (if present)

Find:
```javascript
sessionStorage.setItem("oauth_csrf_state"
sessionStorage.getItem("oauth_csrf_state"
sessionStorage.removeItem("oauth_csrf_state"
```
Replace with:
```javascript
sessionStorage.setItem("decimator_oauth_csrf_state"
sessionStorage.getItem("decimator_oauth_csrf_state"
sessionStorage.removeItem("decimator_oauth_csrf_state"
```

## After Patching Both Apps

Run the automatic patch script below instead of doing it manually.

## Automatic Python Patch Script

Save this as `patch_decimator.py` and run it from inside your Decimator folder:

```python
#!/usr/bin/env python3
"""
patch_decimator.py
Run from your Decimator root: python3 patch_decimator.py
Namespaces all storage keys so Decimator and Destroyer don't clash on localhost:8080.
"""
import os, re

replacements = [
    # (filename_pattern, find, replace)
    ("js/db.js",       '"ddd_db_v8"',                 '"drive_dupe_decimator_db_v1"'),
    ("js/db.js",       '"ddd_db_v9"',                 '"drive_dupe_decimator_db_v1"'),
    ("js/auth.js",     '"oauth_client_id"',            '"decimator_oauth_client_id"'),
    ("js/settings.js", '"scan_settings_v1"',           '"decimator_scan_settings_v1"'),
    ("js/app.js",      '"app_theme"',                  '"decimator_app_theme"'),
    ("js/db.js",       '"drive_changes_token"',        '"decimator_drive_changes_token"'),
    ("js/resume.js",   '"scan_resume_v1"',             '"decimator_scan_resume_v1"'),
    ("js/rejection.js",'"rejected_pairs_v1"',          '"decimator_rejected_pairs_v1"'),
    ("js/security.js", '"oauth_csrf_state"',           '"decimator_oauth_csrf_state"'),
    ("sw.js",          '"ddd-v2.0"',                   '"drive-dupe-decimator-v2.0"'),
    ("sw.js",          '"ddd-v2.0.0"',                 '"drive-dupe-decimator-v2.0"'),
    ("sw.js",          '"ddd-v2.1"',                   '"drive-dupe-decimator-v2.1"'),
]

changed = []
for filename, find, replace in replacements:
    path = os.path.join(os.path.dirname(__file__), filename)
    if not os.path.exists(path):
        continue
    with open(path, "r") as f:
        src = f.read()
    if find in src:
        src = src.replace(find, replace)
        with open(path, "w") as f:
            f.write(src)
        changed.append(f"{filename}: {find!r} → {replace!r}")

if changed:
    print("Patched:")
    for c in changed: print(f"  {c}")
    print("\nDone. Re-enter your Decimator Client ID once after this change.")
else:
    print("Nothing to patch — keys may already be namespaced or files not found.")
```

## Running Both Apps on Different Ports (Alternative)

Instead of patching, you can serve each app on a different port so they have different origins:

- Destroyer: `python3 serve_secure.py` → `http://localhost:8080`
- Decimator: `python3 -m http.server 8081` → `http://localhost:8081`

Different ports = completely isolated storage. No patches needed. This is the simplest approach during development.
