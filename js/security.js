/*
 * Drive Dupe Destroyer (DDD) v14.0 — security.js
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
// Centralised security policy enforcement for Google OAuth verification.
//
// Google's verification checklist requires:
//   1. Minimal scopes — request only what you need
//   2. Token storage — never in localStorage; use sessionStorage or in-memory
//   3. State parameter in OAuth flows (CSRF protection)
//   4. Origin validation on postMessage
//   5. No eval() / innerHTML with user data
//   6. Content-Security-Policy headers / meta tag
//   7. Referrer-Policy
//   8. Input sanitisation before any DOM insertion
//   9. Scopes clearly disclosed in Privacy Policy
//  10. Token revocation on sign-out

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

// ─── postMessage guard ───────────────────────────────────────────────────────
export function safeMessageListener(handler) {
  return function(ev) {
    if (!isAllowedOrigin(ev.origin)) {
      console.warn("[Security] Blocked postMessage from untrusted origin:", ev.origin);
      return;
    }
    handler(ev);
  };
}

// ─── CSRF state token ────────────────────────────────────────────────────────
let _csrfState = null;

export function generateCsrfState() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  _csrfState = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
  // Store only for the duration of the OAuth flow — never persisted
  sessionStorage.setItem("destroyer_oauth_csrf_state", _csrfState);
  return _csrfState;
}

export function validateCsrfState(returnedState) {
  const stored = sessionStorage.getItem("destroyer_oauth_csrf_state");
  sessionStorage.removeItem("destroyer_oauth_csrf_state");
  if (!stored || !returnedState) return false;
  // Constant-time comparison to avoid timing attacks
  if (stored.length !== returnedState.length) return false;
  let diff = 0;
  for (let i = 0; i < stored.length; i++) {
    diff |= stored.charCodeAt(i) ^ returnedState.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Token storage (in-memory only, never localStorage) ──────────────────────
// Tokens are kept in module-scope variables — they vanish on page close.
// Client ID is the ONLY thing persisted (to IndexedDB, not localStorage).
let _accessToken = null;
let _tokenExpiry = 0;

export function storeToken(token, expiresInSeconds = 3600) {
  _accessToken = token;
  _tokenExpiry = Date.now() + (expiresInSeconds - 300) * 1000; // 5-min buffer
}

export function getToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;
  return null;
}

export function clearToken() {
  _accessToken = null;
  _tokenExpiry = 0;
}

export function isTokenValid() {
  return _accessToken !== null && Date.now() < _tokenExpiry;
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

// Safe DOM text insertion — never use innerHTML with this output.
export function setTextContent(el, str) {
  if (el) el.textContent = String(str ?? "");
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

export function validateFolderId(folderId) {
  if (!folderId || typeof folderId !== "string") return false;
  // Drive folder IDs are alphanumeric with hyphens and underscores, 25-44 chars
  return /^[-\w]{10,64}$/.test(folderId.trim());
}

// ─── Scope enforcement ───────────────────────────────────────────────────────
// Minimal scope: read files + move to trash (no full delete, no Docs, no Gmail)
export const REQUIRED_SCOPE = "https://www.googleapis.com/auth/drive";
export const MINIMAL_SCOPE  = "https://www.googleapis.com/auth/drive.file";

// We use the full drive scope because we need to list arbitrary folders.
// This is disclosed in the Privacy Policy and OAuth consent screen.
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

// ─── Permissions-Policy ───────────────────────────────────────────────────────
export function applyPermissionsPolicy() {
  if (document.querySelector('meta[http-equiv="Permissions-Policy"]')) return;
  const m = document.createElement("meta");
  m.httpEquiv = "Permissions-Policy";
  m.content = "camera=(), microphone=(), geolocation=(), payment=()";
  document.head.appendChild(m);
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
  applyPermissionsPolicy();
  stripTokensFromUrl();
  console.log("[Security] All policies applied");
}
