/*
 * Drive Dupe Destroyer (DDD) — auth.js
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
// Security-hardened for Google OAuth verification
// Authentication with better GIS loading detection and error handling

import { el, CONFIG } from "./util.js";
import { validateClientId, applyAllSecurityPolicies, sanitizeText } from "./security.js";
import { setSignedInUi, setStatus, showSpinner, showToast, lockBodyScroll } from "./ui.js";
import { settingGet, settingSet, settingDel } from "./db.js";

let accessToken = null;
let tokenClient = null;
let currentClientId = null;
let tokenExpiresAt = 0;
let refreshTimer = null;
let keepaliveTimer = null;
let gisReady = false;
let gisReadyPromise = null;

// Refresh token every 30 minutes to stay logged in
const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000;

export const SCOPES_DELETE = "https://www.googleapis.com/auth/drive"; // Minimal scope needed to list, read, and trash files
const CLIENT_ID_KEY = "destroyer_oauth_client_id";  // Namespaced: avoids Decimator collision

export async function getStoredClientId() {
  return settingGet(CLIENT_ID_KEY, null);
}

export async function storeClientId(clientId) {
  await settingSet(CLIENT_ID_KEY, clientId);
}

export async function clearStoredClientId() {
  await settingDel(CLIENT_ID_KEY);
}

/**
 * Wait for Google Identity Services to load
 */
function waitForGis(timeoutMs = 10000) {
  if (gisReadyPromise) return gisReadyPromise;
  
  gisReadyPromise = new Promise((resolve, reject) => {
    // Check if already loaded
    if (window.google?.accounts?.oauth2) {
      console.log("GIS already loaded");
      gisReady = true;
      resolve();
      return;
    }
    
    const startTime = Date.now();
    
    const checkInterval = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(checkInterval);
        console.log("GIS loaded successfully");
        gisReady = true;
        resolve();
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        reject(new Error("Google sign-in failed to load. Try refreshing the page."));
      }
    }, 100);
  });
  
  return gisReadyPromise;
}

function showClientIdModal() {
  return new Promise((resolve) => {
    const modal = el("authModal");
    const input = el("authClientIdInput");
    const btnSubmit = el("authModalSubmit");
    const btnCancel = el("authModalCancel");
    const errorEl = el("authModalError");
    
    console.log("Opening Client ID modal...");
    
    if (!modal || !input) {
      console.error("Auth modal elements not found!", { modal: !!modal, input: !!input });
      resolve(null);
      return;
    }
    
    input.value = currentClientId || '';
    if (errorEl) errorEl.textContent = '';
    
    modal.style.display = "flex";
    lockBodyScroll(true);
    
    // Focus after a short delay to ensure modal is visible
    setTimeout(() => input.focus(), 100);
    
    const cleanup = () => {
      console.log("Closing Client ID modal");
      modal.style.display = "none";
      lockBodyScroll(false);
      if (btnSubmit) btnSubmit.onclick = null;
      if (btnCancel) btnCancel.onclick = null;
      if (input) input.onkeydown = null;
      modal.onclick = null;
    };
    
    const submit = () => {
      const clientId = input.value.trim();
      console.log("Client ID submitted:", clientId ? "provided" : "empty");
      
      if (!clientId) {
        if (errorEl) errorEl.textContent = "Please enter a valid OAuth Client ID";
        input.focus();
        return;
      }
      
      if (!validateClientId(clientId)) {
        if (errorEl) errorEl.textContent = "Invalid Client ID format. Must end with .apps.googleusercontent.com and contain only safe characters.";
        input.focus();
        return;
      }
      
      cleanup();
      resolve(clientId);
    };
    
    const cancel = () => {
      console.log("Client ID modal cancelled");
      cleanup();
      resolve(null);
    };
    
    if (btnSubmit) btnSubmit.onclick = submit;
    if (btnCancel) btnCancel.onclick = cancel;
    
    if (input) {
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      };
    }
    
    modal.onclick = (e) => {
      if (e.target === modal) cancel();
    };
  });
}

function initTokenClient(clientId) {
  if (!clientId) throw new Error("No OAuth Client ID provided.");
  
  console.log("[Auth] Initializing token client");
  
  currentClientId = clientId;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES_DELETE,
    callback: () => {} // Will be set when requesting token
  });
  
  console.log("Token client initialized");
}

function clearAllTimers() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function startKeepalive() {
  clearAllTimers();
  
  // Refresh every 30 minutes to stay logged in
  keepaliveTimer = setInterval(async () => {
    if (!accessToken || !tokenClient) return;
    
    console.log("Keepalive: refreshing token...");
    try {
      await silentRefreshToken();
      console.log("Keepalive: token refreshed successfully");
    } catch (e) {
      console.warn("Keepalive: token refresh failed:", e.message);
    }
  }, KEEPALIVE_INTERVAL_MS);
  
  // Also schedule a refresh 5 minutes before expiry
  const timeUntilExpiry = tokenExpiresAt - Date.now() - 5 * 60 * 1000;
  if (timeUntilExpiry > 0 && timeUntilExpiry < KEEPALIVE_INTERVAL_MS) {
    refreshTimer = setTimeout(async () => {
      console.log("Pre-expiry refresh...");
      try {
        await silentRefreshToken();
      } catch (e) {
        console.warn("Pre-expiry refresh failed:", e.message);
      }
    }, timeUntilExpiry);
  }
}

// GIS errors that mean "the user or the browser declined this attempt", as
// opposed to "your Client ID is wrong". The distinction matters because the
// stored Client ID used to be deleted on ANY failure: closing the popup once
// meant re-fetching it from Google Cloud Console, the most tedious step in the
// whole setup.
const RECOVERABLE_AUTH_ERRORS = new Set([
  "popup_closed_by_user",
  "popup_failed_to_open",
  "access_denied",
  "user_cancel",
  "immediate_failed",
  "interaction_required",
  "consent_required",
  "login_required",
]);

/** Seconds the token is good for, from GIS if it says, with a safety floor. */
function expiryFromResponse(resp) {
  // expires_in is what GIS actually returns. This was hardcoded to 55 minutes,
  // so a shorter-lived token left isSignedIn() and the ensureValidToken fast
  // path both believing a dead token was fine; only the 401 retry caught it,
  // one wasted round-trip per request.
  const seconds = Number(resp?.expires_in);
  const usable = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  // Refresh a little early, but never compute a negative lifetime for a
  // short-lived token.
  const buffer = Math.min(300, Math.floor(usable * 0.1));
  return Date.now() + (usable - buffer) * 1000;
}

// ---------------------------------------------------------------------------
// Single-flight token acquisition
// ---------------------------------------------------------------------------
//
// tokenClient.callback is a single mutable slot, and both ensureToken and
// silentRefreshToken assigned to it before calling requestAccessToken. Hashing
// runs at HASH_CONCURRENCY (6) and path building at PATH_CONCURRENCY (10), so
// when the token went stale mid-scan up to 16 in-flight requests could each
// install their own callback. GIS fires only the last one; every earlier caller
// waited out its timeout and then rejected. This funnels all of them onto one
// in-flight promise.
let _tokenRequest = null;

// Which sign-in session a request belongs to. signOut() bumps this, so a GIS
// callback that lands after the user has signed out can tell that its token
// belongs to a session that no longer exists. Without it, sign-out did not
// stick: revoke ran against the old token, the UI went to "Sign In", and then
// the in-flight callback wrote a brand new live token back into accessToken.
// The window is up to the 10s silent-refresh timeout, on every keepalive and
// every visibilitychange refresh (#82).
let _tokenGeneration = 0;

// Identifies the request that owns the _tokenRequest slot. The `.finally` used
// to clear the slot unconditionally, so a request cancelled by signOut() would
// later clear the slot belonging to whichever request had started since --
// quietly dropping the single-flight guard for every caller after that.
let _tokenRequestId = 0;

function requestTokenOnce(options, { timeoutMs = CONFIG.AUTH_TIMEOUT_MS } = {}) {
  if (_tokenRequest) return _tokenRequest;
  if (!tokenClient) return Promise.reject(new Error("No token client"));

  const myGeneration = _tokenGeneration;
  const myId = ++_tokenRequestId;

  _tokenRequest = new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error("Sign-in timed out."), { code: "AUTH_TIMEOUT" }));
    }, timeoutMs);

    tokenClient.callback = (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (myGeneration !== _tokenGeneration) {
        // The user signed out while this was in flight. Adopting the token
        // would sign them back in behind a UI that says otherwise; leaving it
        // alone would leave a live grant behind a sign-out that revoked its
        // predecessor. So take neither option: hand it straight back.
        try {
          if (resp?.access_token) google.accounts.oauth2.revoke(resp.access_token, () => {});
        } catch (e) {
          console.warn("[Auth] Could not revoke a superseded token:", e?.message || e);
        }
        reject(Object.assign(new Error("Signed out before sign-in completed."), {
          code: "AUTH",
          authError: "superseded",
          recoverable: true,
        }));
      } else if (resp?.access_token) {
        accessToken = resp.access_token;
        tokenExpiresAt = expiryFromResponse(resp);
        resolve(resp);
      } else {
        const err = resp?.error || "unknown_error";
        reject(Object.assign(new Error(`Failed to obtain access token (${err})`), {
          code: "AUTH",
          authError: err,
          recoverable: RECOVERABLE_AUTH_ERRORS.has(err),
        }));
      }
    };

    try {
      tokenClient.requestAccessToken(options);
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  }).finally(() => {
    if (_tokenRequestId === myId) _tokenRequest = null;
  });

  return _tokenRequest;
}

async function silentRefreshToken() {
  if (!tokenClient) throw new Error("No token client");
  // prompt:'' asks GIS to complete without showing consent. It can still need to
  // open a popup, which the browser blocks when there is no user activation --
  // so this is best-effort and its failure must never be fatal.
  await requestTokenOnce({ prompt: "" }, { timeoutMs: 10000 });
}

export async function ensureToken({ forcePrompt = false } = {}) {
  // Check if token is still valid (with 5-minute buffer)
  if (accessToken && tokenExpiresAt > Date.now() + 5 * 60 * 1000) {
    return accessToken;
  }

  await waitForGis();

  if (!tokenClient) {
    let clientId = await getStoredClientId();
    if (!clientId) {
      clientId = await showClientIdModal();
      if (!clientId) throw Object.assign(new Error("Sign-in cancelled."), { code: "AUTH", recoverable: true });
    }
    initTokenClient(clientId);
  }

  try {
    // Single-flight: parallel callers share this one request rather than each
    // overwriting tokenClient.callback and then timing out.
    await requestTokenOnce(forcePrompt ? { prompt: "consent" } : {});
    await storeClientId(currentClientId);
    startKeepalive();
    return accessToken;
  } catch (e) {
    // Only discard the stored Client ID when the ID itself is the problem.
    // Previously ANY failure cleared it, so closing the popup or declining
    // consent once forced the user back to Google Cloud Console to re-copy it.
    if (e?.code === "AUTH" && !e.recoverable) {
      console.warn(`[Auth] Clearing stored Client ID after unrecoverable error: ${e.authError}`);
      await clearStoredClientId();
      tokenClient = null;
      currentClientId = null;
    }

    if (e?.code === "AUTH_TIMEOUT") {
      // Keep the code. Rewriting the message used to drop it, leaving callers
      // -- batchTrash among them -- unable to tell a timeout from any other
      // failure and so unable to stop retrying into it.
      throw Object.assign(
        new Error(
          "Sign-in timed out. If you see a Google popup, complete the sign-in there. " +
          "If not, check whether popups are blocked."
        ),
        { code: "AUTH_TIMEOUT" }
      );
    }
    throw e;
  }
}

export async function ensureValidToken() {
  if (accessToken && tokenExpiresAt > Date.now() + 60 * 1000) {
    return accessToken;
  }
  
  if (accessToken && tokenClient) {
    try {
      console.log("Token expired, attempting silent refresh...");
      await silentRefreshToken();
      startKeepalive();
      return accessToken;
    } catch (e) {
      console.warn("Silent refresh failed, need interactive sign-in:", e.message);
    }
  }
  
  return ensureToken();
}

export async function authedFetch(url, { method = "GET", headers = {}, body = null, signal = null } = {}) {
  await ensureValidToken();
  
  // Tag a genuine transport failure so callers can tell it apart from an
  // ordinary TypeError. fetch throws TypeError on a network error, but so does
  // every "x is not a function" bug in the codebase — scan.js used to report
  // both as "Network error. Check your internet connection."
  // Returns the response AND the token it was sent with, so a 401 can be
  // attributed to a specific token rather than to whatever happens to be in the
  // module variable by the time the response comes back.
  const doFetch = async () => {
    const sentWith = accessToken;
    try {
      const response = await fetch(url, {
        method,
        headers: { ...headers, Authorization: "Bearer " + sentWith },
        body,
        signal
      });
      return { response, sentWith };
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw Object.assign(new Error("Network request failed: " + (e?.message || e)), { code: "NETWORK" });
    }
  };

  let { response: res, sentWith } = await doFetch();

  if (res.status === 401) {
    // Invalidate only the token that actually failed. Clearing accessToken
    // unconditionally threw away a fresh token that a parallel request had just
    // obtained, sending every other in-flight request back through a refresh it
    // did not need.
    if (accessToken === sentWith) {
      accessToken = null;
      tokenExpiresAt = 0;
    }

    try {
      await ensureValidToken();
      ({ response: res } = await doFetch());
    } catch (e) {
      showToast("Session expired. Please sign in again.", "error");
      throw e;
    }
  }

  return res;
}

export function getAccessToken() {
  return accessToken;
}

export function getCurrentClientId() {
  return currentClientId;
}

export function isSignedIn() {
  return accessToken && tokenExpiresAt > Date.now();
}

// Security: revokes token with Google AND clears all in-memory state
export async function signOut() {
  console.log("Signing out...");
  
  try {
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
  } catch (e) {
    console.warn("Revoke error:", e);
  }
  
  clearAllTimers();

  // Bump BEFORE clearing, so a GIS callback that is already queued sees a
  // generation it does not match and declines to write anything back (#82).
  _tokenGeneration++;

  accessToken = null;
  tokenClient = null;
  tokenExpiresAt = 0;
  currentClientId = null;   // was left set, so the UI still showed a signed-in client
  _tokenRequest = null;     // drop any in-flight request; it belongs to the old session

  setSignedInUi(false);
  showToast("Signed out successfully", "info");
}

export function wireAuth({ onSignedIn }) {
  // Apply all security policies on auth init
  try { applyAllSecurityPolicies(); } catch(e) { console.warn('[Auth] Security policy apply failed:', e); }
  const btnAuth = el("btnAuth");
  
  if (!btnAuth) {
    console.error("btnAuth not found!");
    return;
  }
  
  console.log("Wiring auth button");
  
  // Disable button until GIS loads
  btnAuth.disabled = true;
  btnAuth.textContent = "Loading...";
  
  // Wait for GIS then enable button
  waitForGis()
    .then(() => {
      btnAuth.disabled = false;
      btnAuth.textContent = "Sign In";
      console.log("Auth button enabled");
    })
    .catch((e) => {
      btnAuth.disabled = true;
      btnAuth.textContent = "Error";
      console.error("GIS load failed:", e);
      showToast(e.message, "error", 5000);
    });
  
  btnAuth.onclick = async () => {
    console.log("Sign In button clicked");
    
    try {
      if (accessToken) {
        signOut();
        return;
      }
      
      // Double-check GIS is ready
      if (!window.google?.accounts?.oauth2) {
        showToast("Google sign-in still loading. Please wait...", "info");
        await waitForGis();
      }
      
      showSpinner(true);
      setStatus("Opening Google sign-in…");
      btnAuth.disabled = true;
      
      await ensureToken({ forcePrompt: true });
      
      setSignedInUi(true, currentClientId);
      setStatus("Ready.");
      showToast("Signed in successfully", "success");
      
      if (onSignedIn) await onSignedIn();
    } catch (e) {
      console.error("Sign-in error:", e);
      showSpinner(false);
      
      if (e.message !== "Sign-in cancelled.") {
        showToast(e.message || String(e), "error", 5000);
      }
      setStatus("Sign-in failed or cancelled.");
    } finally {
      showSpinner(false);
      btnAuth.disabled = false;
      btnAuth.textContent = accessToken ? "Sign Out" : "Sign In";
    }
  };
  
  // Listen for visibility changes to refresh token when user comes back
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && accessToken && tokenClient) {
      if (tokenExpiresAt < Date.now() + 10 * 60 * 1000) {
        console.log("Tab visible again, refreshing token...");
        try {
          await silentRefreshToken();
          startKeepalive();
        } catch (e) {
          console.warn("Visibility refresh failed:", e.message);
        }
      }
    }
  });
  
  // Try to prepare client if we have stored ID
  (async () => {
    try {
      await waitForGis();
      const storedId = await getStoredClientId();
      if (storedId) {
        console.log("Found stored client ID, initializing...");
        currentClientId = storedId;
        initTokenClient(storedId);
      }
    } catch (e) {
      console.warn("Auto-init failed:", e);
    }
  })();
}
