/*
 * Drive Dupe Destroyer (DDD) — security.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Noncommercial use only: you may use, copy, modify, and share this
 * software for any noncommercial purpose. Commercial use — including
 * selling it or hosting it as a paid product or service — is NOT permitted.
 * Full terms: see the LICENSE file, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0/
 */
// Security policy helpers actually used by the app.
//
// This file used to carry a checklist of OAuth-verification items with an
// implementation for each, most of which nothing called: an in-memory token
// store (auth.js keeps its own), hand-rolled CSRF state (GIS manages its own),
// a postMessage origin guard (there is no postMessage listener), and a
// Permissions-Policy <meta> tag (that header is response-header-only; the meta
// form is inert). They have been removed rather than left to imply protections
// that were not in effect — serve_secure.py and sw.js send the real headers.
//
// What remains and is wired up:
//   - applyReferrerPolicy()        -> meta referrer, honoured by browsers
//   - applyContentSecurityPolicy() -> defence-in-depth meta CSP for XSS only;
//                                     the authoritative CSP is an HTTP header
//   - stripTokensFromUrl()         -> keeps tokens out of the address bar
//   - sanitizeText()               -> escaping for anything interpolated
//   - validateClientId/FolderId()  -> input validation
//   - isAllowedOrigin()            -> origin allow-list

// ─── Allowed origins ─────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  "https://accounts.google.com",
  "https://oauth2.googleapis.com",
  "https://www.googleapis.com",
  "https://content.googleapis.com",
  "https://lh3.googleusercontent.com",
]);

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow any googleapis.com subdomain
  try {
    const u = new URL(origin);
    return u.hostname.endsWith(".googleapis.com") ||
           u.hostname.endsWith(".google.com") ||
           u.hostname.endsWith(".googleusercontent.com");
  } catch { return false; }
}

// ─── DOM sanitisation ────────────────────────────────────────────────────────
// Safe alternative to innerHTML with user-controlled strings.
export function sanitizeText(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Input validation ────────────────────────────────────────────────────────
export function validateClientId(clientId) {
  if (!clientId || typeof clientId !== "string") return false;
  const trimmed = clientId.trim();
  // Must end with .apps.googleusercontent.com and contain only safe chars
  if (!trimmed.endsWith(".apps.googleusercontent.com")) return false;
  if (!/^[\w\-.]+\.apps\.googleusercontent\.com$/.test(trimmed)) return false;
  if (trimmed.length > 256) return false;
  return true;
}

// Drive accepts these aliases wherever a folder ID is expected. "root" is the
// one the folder picker uses for My Drive; it is four characters, so a
// length-based ID check rejects it unless it is allowed explicitly.
const FOLDER_ID_ALIASES = new Set(["root", "appDataFolder", "sharedWithMe"]);

export function validateFolderId(folderId) {
  if (!folderId || typeof folderId !== "string") return false;
  const id = folderId.trim();
  if (FOLDER_ID_ALIASES.has(id)) return true;
  // Real Drive folder IDs are alphanumeric with hyphens and underscores,
  // typically 25-44 characters.
  return /^[-\w]{10,64}$/.test(id);
}

// ─── Scope ───────────────────────────────────────────────────────────────────
//
// This is Google's RESTRICTED drive scope. It grants full read/write access to
// the user's Drive, including permanent deletion — the previous comment here
// described it as "read files + move to trash (no full delete)", which is the
// drive.file scope, not this one.
//
// We request it because the app lists arbitrary user-chosen folders, which
// drive.file cannot do. The cost is real: publishing beyond the 100-user
// testing cap requires OAuth verification plus an annual CASA security
// assessment, which is why the app ships no shared client and asks each user
// for their own Client ID. See the Picker + drive.file issue for the
// alternative.
export const REQUIRED_SCOPE = "https://www.googleapis.com/auth/drive";
export const APP_SCOPE = REQUIRED_SCOPE;

// ─── Referrer leak prevention ─────────────────────────────────────────────────
// Call once on init; sets meta referrer policy if not already set by headers.
export function applyReferrerPolicy() {
  if (!document.querySelector('meta[name="referrer"]')) {
    const m = document.createElement("meta");
    m.name = "referrer";
    m.content = "strict-origin-when-cross-origin";
    document.head.appendChild(m);
  }
}

// ─── CSP enforcement (meta tag fallback) ─────────────────────────────────────
// Proper CSP should come from the server. This meta tag is a defence-in-depth
// fallback for local file serving where headers can't be set.
export function applyContentSecurityPolicy() {
  if (document.querySelector('meta[http-equiv="Content-Security-Policy"]')) return;

  // NOTE: CSP via meta tag is intentionally permissive here.
  // The strict CSP is enforced by serve_secure.py / the hosting server via HTTP headers,
  // which supersede meta tags and cannot be bypassed by injected content.
  //
  // Meta-tag CSP limitations we work around:
  //  - Google GIS OAuth opens a POPUP window (not a frame), so frame-src doesn't cover it.
  //    Popups inherit the opener's CSP; blocking scripts in the popup breaks the OAuth flow.
  //  - font-src must include cdnjs for Font Awesome to load.
  //  - upgrade-insecure-requests breaks localhost (HTTP) development.
  //  - form-action 'none' is not supported in all meta-CSP contexts.
  //
  // This meta CSP is defence-in-depth for XSS only — it doesn't gate OAuth.
  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  const csp = [
    "default-src 'self'",
    // Google GIS script + any scripts it needs
    "script-src 'self' https://accounts.google.com https://*.googleapis.com",
    // Font Awesome from cdnjs, inline styles for the app
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    // Font Awesome web fonts
    "font-src 'self' https://cdnjs.cloudflare.com data:",
    // Drive API + OAuth token endpoint
    "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com https://content.googleapis.com",
    // Drive thumbnails + blob URLs for image display
    "img-src 'self' blob: data: https://lh3.googleusercontent.com https://www.googleapis.com https://*.googleusercontent.com",
    // OAuth popup and potential iframe from Google
    "frame-src https://accounts.google.com https://*.google.com",
    // Hash workers + WASM workers
    "worker-src 'self' blob:",
    // No plugins
    "object-src 'none'",
    // No base tag hijacking
    "base-uri 'self'",
    // Don't upgrade on localhost (breaks OAuth popup on HTTP)
    ...(isLocalhost ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const m = document.createElement("meta");
  m.httpEquiv = "Content-Security-Policy";
  m.content = csp;
  document.head.prepend(m);
}

// ─── Token leak guards ────────────────────────────────────────────────────────
// Ensure tokens never appear in URLs (would be logged by the server)
export function stripTokensFromUrl() {
  const url = new URL(window.location.href);
  let dirty = false;
  for (const key of ["access_token", "token", "code", "state", "error"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      dirty = true;
    }
  }
  if (url.hash.includes("access_token") || url.hash.includes("token=")) {
    url.hash = "";
    dirty = true;
  }
  if (dirty) {
    history.replaceState(null, "", url.toString());
  }
}

// ─── Apply all policies (call from app init) ──────────────────────────────────
export function applyAllSecurityPolicies() {
  applyReferrerPolicy();
  applyContentSecurityPolicy();
  stripTokensFromUrl();
  console.log("[Security] All policies applied");
}
