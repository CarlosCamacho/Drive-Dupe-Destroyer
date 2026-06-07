/*
 * Drive Dupe Destroyer (DDD) v14.0 — auth.js
 *
 * Copyright (c) 2025 Carlos Camacho
 * SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
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

async function silentRefreshToken() {
  if (!tokenClient) throw new Error("No token client");
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Silent refresh timeout"));
    }, 10000);
    
    tokenClient.callback = (resp) => {
      clearTimeout(timeout);
      if (resp?.access_token) {
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + 55 * 60 * 1000;
        resolve();
      } else {
        reject(new Error(resp?.error || "Silent refresh failed"));
      }
    };
    
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

export async function ensureToken({ forcePrompt = false } = {}) {
  console.log("ensureToken called, forcePrompt:", forcePrompt);
  
  // Check if token is still valid (with 5-minute buffer)
  if (accessToken && tokenExpiresAt > Date.now() + 5 * 60 * 1000) {
    console.log("Using existing valid token");
    return accessToken;
  }

  // Wait for GIS to load
  console.log("Waiting for GIS...");
  await waitForGis();
  console.log("GIS ready");
  
  if (!tokenClient) {
    console.log("No token client, need to initialize");
    let clientId = await getStoredClientId();
    console.log("Stored client ID:", clientId ? "found" : "not found");
    
    if (!clientId) {
      clientId = await showClientIdModal();
      if (!clientId) throw new Error("Sign-in cancelled.");
    }
    
    initTokenClient(clientId);
  }

  console.log("Requesting access token...");
  
  await new Promise((resolve, reject) => {
    let done = false;
    
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.error("Token request timed out");
      reject(new Error(
        "Sign-in timed out. If you see a Google popup, complete the sign-in there. " +
        "If not, check if popups are blocked."
      ));
    }, CONFIG.AUTH_TIMEOUT_MS);

    tokenClient.callback = async (resp) => {
      console.log("[Auth] Token callback received:", resp?.access_token ? "granted" : "denied");
      
      if (done) return;
      done = true;
      clearTimeout(timer);

      if (resp?.access_token) {
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + 55 * 60 * 1000;
        await storeClientId(currentClientId);
        startKeepalive();
        resolve();
      } else {
        const err = resp?.error ? ` (${resp.error})` : "";
        await clearStoredClientId();
        reject(new Error("Failed to obtain access token" + err));
      }
    };

    console.log("Calling requestAccessToken with prompt:", forcePrompt ? "consent" : "default");
    
    if (forcePrompt) {
      tokenClient.requestAccessToken({ prompt: "consent" });
    } else {
      tokenClient.requestAccessToken({});
    }
  });

  console.log("Token obtained successfully");
  return accessToken;
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
  
  let res = await fetch(url, {
    method,
    headers: { ...headers, Authorization: "Bearer " + accessToken },
    body,
    signal
  });
  
  if (res.status === 401) {
    console.warn("Got 401, attempting token refresh...");
    accessToken = null;
    tokenExpiresAt = 0;
    
    try {
      await ensureValidToken();
      res = await fetch(url, {
        method,
        headers: { ...headers, Authorization: "Bearer " + accessToken },
        body,
        signal
      });
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
  
  accessToken = null;
  tokenClient = null;
  tokenExpiresAt = 0;
  
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
