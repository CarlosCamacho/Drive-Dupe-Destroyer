<!-- Drive Dupe Destroyer v12.8 — VERSION-12.0-CHANGELOG.md -->
# Drive Dupe Destroyer v12.2 Changelog

## v12.2 (patch)
- Fixed: `validateFolderId is not defined` — import was missing from scan.js, causing all scans to fail
- Fixed: Service Worker cache stale-lock — dev mode now bypasses cache on localhost; production SW claims all clients immediately on activation and triggers an auto-reload so users always get fresh files
- Bumped SW cache name to `drive-dupe-destroyer-v12.2`

## v12.1 (patch)
- Fixed CSP blocking Font Awesome fonts (missing `font-src` directive)
- Fixed Google OAuth popup being blocked by CSP on localhost
- Fixed folder name: zip now extracts to `Drive_Dupe_Destroyer_v12/`

## v12.0 (release)
## Release Date: March 2026

## Security Hardening (Google OAuth Verification Ready)

### New: security.js module
Centralised security policy enforcement added as `js/security.js`. Called as the very first operation in `app.js init()`. Provides:
- **Content-Security-Policy** injected via meta tag at runtime (defence-in-depth alongside SW headers)
- **Referrer-Policy: strict-origin-when-cross-origin** meta tag
- **Permissions-Policy** (blocks camera, microphone, geolocation, payment)
- **CSRF state token** — `generateCsrfState()` / `validateCsrfState()` for future PKCE flows
- **Origin whitelist** — `isAllowedOrigin()` / `safeMessageListener()` for postMessage guards
- **Token storage** — in-memory only; `storeToken()` / `getToken()` / `clearToken()`
- **DOM sanitiser** — `sanitizeText()` and `setTextContent()` safe helpers
- **Input validators** — `validateClientId()` (regex + length check) and `validateFolderId()`
- **Token-from-URL stripper** — removes `access_token`, `code`, `state` from URL bar on load

### auth.js hardened
- Client ID now validated through `validateClientId()` (regex, length, format) before use
- `applyAllSecurityPolicies()` called at auth wire-up
- Sign-out comment clarifies token revocation via `google.accounts.oauth2.revoke()`

### drive.js hardened
- API path sanity check before every request (rejects traversal / injection chars)
- Error messages sanitised via `sanitizeText()` before reaching UI (prevents reflected XSS)

### scan.js hardened
- All input folder IDs validated through `validateFolderId()` before API calls
- Invalid IDs silently rejected with console warning

### app.js hardened
- Theme preference moved from `localStorage` → IndexedDB `settingGet/settingSet`
- `localStorage.clear()` removed from cache-clear flow (no sensitive data in localStorage)
- `applyAllSecurityPolicies()` called as first statement in `init()`

### sw.js hardened
- Security headers injected on every served response:
  - `Content-Security-Policy` (mirrors security.js policy)
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy`
- `js/security.js` added to precache list

### index.html hardened
- Security meta tags added to `<head>` (X-Content-Type-Options, referrer)
- All external links get `rel="noopener noreferrer"`
- Client ID input gets `autocomplete="off" spellcheck="false"`
- All `<button>` elements get explicit `type="button"` (prevents accidental form submit)

### Bug fix: exporter.js
- CSV quote-escape function was malformed (heredoc mangled the `replace(/"/g, '""')` call)
- Fixed to use clean string concatenation: `'"' + s.replace(/"/g, '""') + '"'`
- This was blocking the entire module from loading, preventing Sign In from working

## New Files
- `js/security.js` — centralised security module
- `privacy.html` — Privacy Policy (required for OAuth verification)
- `terms.html` — Terms of Service (required for OAuth verification)
- `serve_secure.py` — local server with full security headers (enables SAB)
- `OAUTH_VERIFICATION_GUIDE.md` — step-by-step OAuth verification walkthrough

## Security Audit Results

| Check | Result |
|---|---|
| No eval() calls | ✅ Clean |
| No localStorage for tokens | ✅ In-memory only |
| escapeHtml on all innerHTML user data | ✅ Verified in render.js, ui.js, queue.js, folderPicker.js |
| CSP policy applied | ✅ security.js + sw.js |
| Token revoked on sign-out | ✅ auth.js |
| No document.write | ✅ Clean |
| External links: noopener noreferrer | ✅ index.html |
| button type="button" | ✅ All buttons |
| Folder ID validation before API | ✅ scan.js |
| API path injection guard | ✅ drive.js |
| Error message sanitisation | ✅ drive.js |

## Folder Name
Per naming convention, the app folder is `Drive_Dupe_Destroyer_v10_1` (not `ddd-*`).
The version inside the app is v12.0.

## Storage Namespace Isolation (v12.0 patch)

Both Drive Dupe Destroyer and Drive Dupe Decimator share the same localhost origin
(`http://localhost:8080`). Without namespacing they collide on every browser storage API.

### What collided and how it is now fixed

| Storage | Old (colliding) key | New (namespaced) key |
|---|---|---|
| **IndexedDB database** | `ddd_db_v8` | `drive_dupe_destroyer_db_v1` |
| **OAuth Client ID** | `oauth_client_id` | `destroyer_oauth_client_id` |
| **App theme** | `app_theme` | `destroyer_app_theme` |
| **Scan settings** | `scan_settings_v1` | `destroyer_scan_settings_v1` |
| **Rejection pairs** | `rejected_pairs_v1` | `destroyer_rejected_pairs_v1` |
| **Scan resume state** | `scan_resume_v1` | `destroyer_scan_resume_v1` |
| **Drive changes token** | `drive_changes_token` | `destroyer_drive_changes_token` |
| **CSRF state** | `oauth_csrf_state` (sessionStorage) | `destroyer_oauth_csrf_state` |
| **SW cache** | `ddd-v11.0` / generic names | `drive-dupe-destroyer-v12.0` |
| **SW asset scope** | Intercepts all localhost requests | Only intercepts known Destroyer assets |

### Recommended development setup

Run each app on its own port so Service Workers never overlap:
```
# Drive Dupe Destroyer
cd Drive_Dupe_Destroyer_v12
python3 serve_secure.py          # → http://localhost:8080

# Drive Dupe Decimator  
cd Drive_Dupe_Decimator_v2
python3 serve_secure.py 8081     # → http://localhost:8081
```
