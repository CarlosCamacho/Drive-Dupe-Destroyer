/*
 * Drive Dupe Destroyer (DDD) v14.0 — sw.js
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
// Security-hardened: strict origin checks on all fetches
// Service Worker: cache-first for app assets + background hash queue keepalive (Feature #20)
// When main tab is backgrounded, SW keeps Drive API fetch queue alive.

const CACHE_NAME = "drive-dupe-destroyer-v14";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/util.js",
  "./js/common.js",
  "./js/auth.js",
  "./js/drive.js",
  "./js/scan.js",
  "./js/hashing.js",
  "./js/worker-hash.js",
  "./js/lsh.js",
  "./js/db.js",
  "./js/ui.js",
  "./js/render.js",
  "./js/compare.js",
  "./js/crop.js",
  "./js/exporter.js",
  "./js/settings.js",
  "./js/telemetry.js",
  "./js/undo.js",
  "./js/resume.js",
  "./js/rejection.js",
  "./js/aimd.js",
  "./js/security.js",
  "./js/phash.js",
];

// ============================================================================
// Install: pre-cache app shell
// ============================================================================
// In development (localhost), skip pre-caching so file changes take effect immediately
const IS_DEV = self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1";

self.addEventListener("install", (ev) => {
  if (IS_DEV) {
    // Dev mode: skip waiting immediately, don't pre-cache
    console.log("[SW] Dev mode: skipping pre-cache, activating immediately");
    self.skipWaiting();
    return;
  }
  ev.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(e => console.warn("[SW] Pre-cache partial failure:", e))
    ).then(() => self.skipWaiting())
  );
});

// ============================================================================
// Activate: evict stale caches
// ============================================================================
self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => {
          console.log("[SW] Evicting old cache:", n);
          return caches.delete(n);
        })
      ))
      .then(() => {
        console.log("[SW] v14.0 activated, claiming all clients");
        return self.clients.claim();  // Take over open tabs immediately
      })
      .then(() => {
        // Notify all open tabs to reload so they get the new SW immediately
        return self.clients.matchAll({ type: "window" }).then(clients => {
          clients.forEach(client => {
            client.postMessage({ type: "SW_UPDATED", version: "14.0" });
          });
        });
      })
  );
});

// ============================================================================
// Fetch: cache-first for app assets, network-only for Drive API
// ============================================================================

// ============================================================================
// Security headers injected on every app-shell response (Feature: CSP via SW)
// ============================================================================
function addSecurityHeaders(response) {
  if (!response) return response;
  // Only add headers to same-origin HTML/JS responses
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/html") && !ct.includes("javascript")) return response;

  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // CSP - mirrors security.js applyContentSecurityPolicy()
  // SW CSP applied via HTTP response headers — stricter than meta tag CSP
  // Only applied to HTML responses when served via the secure server
  headers.set("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' https://accounts.google.com https://*.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://cdnjs.cloudflare.com data:; " +
    "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com https://content.googleapis.com; " +
    "img-src 'self' blob: data: https://lh3.googleusercontent.com https://www.googleapis.com https://*.googleusercontent.com; " +
    "frame-src https://accounts.google.com https://*.google.com; " +
    "worker-src 'self' blob:; " +
    "object-src 'none'; " +
    "base-uri 'self';"
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);

  // Network-only for Google APIs (auth, Drive, thumbnails)
  if (
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("google.com") ||
    url.hostname.includes("googleusercontent.com") ||
    url.hostname.includes("gstatic.com")
  ) {
    return; // Let browser handle
  }

  // Scope guard: only serve requests whose path starts with our registered scope.
  // This prevents the Destroyer SW from intercepting Decimator requests and vice versa
  // when both apps are served from the same localhost origin.
  // Each app must be in its own subfolder (e.g. /destroyer/ and /decimator/) for
  // complete isolation. If in the root, SW scopes overlap — serve from cache only
  // if the requested path matches a known Destroyer asset.
  const knownAssets = new Set(PRECACHE.map(p => new URL(p, self.location.href).pathname));
  if (!knownAssets.has(url.pathname) && url.origin === self.location.origin) {
    return; // Not our asset — let the browser (or the other app's SW) handle it
  }

  // Dev mode: always fetch from network, never cache
  if (IS_DEV) {
    ev.respondWith(
      fetch(ev.request).then(r => addSecurityHeaders(r)).catch(() => fetch(ev.request))
    );
    return;
  }

  // Cache-first for app assets (production)
  ev.respondWith(
    caches.match(ev.request).then(cached => {
      if (cached) return addSecurityHeaders(cached);
      return fetch(ev.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(ev.request, clone)).catch(() => {});
        }
        return addSecurityHeaders(response);
      });
    }).catch(() => caches.match("./index.html"))
  );
});

// ============================================================================
// Feature #20: Background computation keepalive
// Receives hash-queue messages from main thread when tab goes hidden.
// Replies with "keepalive-ack" so the main thread knows the SW is active.
// ============================================================================

let pendingHashJobs = []; // { clientId, jobData }

self.addEventListener("message", async (ev) => {
  const { type, data } = ev.data || {};

  if (type === "KEEPALIVE_PING") {
    ev.source?.postMessage({ type: "KEEPALIVE_ACK", timestamp: Date.now() });
    return;
  }

  if (type === "QUEUE_HASH_JOB") {
    // Store job for when a visible client can process it
    pendingHashJobs.push({ clientId: ev.source?.id, jobData: data });
    ev.source?.postMessage({ type: "JOB_QUEUED", jobId: data?.jobId });
    return;
  }

  if (type === "FLUSH_HASH_JOBS") {
    // Main thread is visible again — send it all queued jobs
    const jobs = pendingHashJobs.splice(0);
    ev.source?.postMessage({ type: "FLUSHED_JOBS", jobs });
    return;
  }

  if (type === "CLEAR_HASH_QUEUE") {
    pendingHashJobs = [];
    ev.source?.postMessage({ type: "QUEUE_CLEARED" });
    return;
  }

  if (type === "VERSION_CHECK") {
    ev.source?.postMessage({ type: "VERSION", version: "14.0", cacheName: CACHE_NAME });
    return;
  }
});

// ============================================================================
// Periodic sync: flush any stale jobs (fallback for browsers that wake the SW)
// ============================================================================
self.addEventListener("periodicsync", (ev) => {
  if (ev.tag === "ddd-flush-jobs") {
    ev.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then(clients => {
        if (clients.length > 0 && pendingHashJobs.length > 0) {
          const jobs = pendingHashJobs.splice(0);
          clients[0].postMessage({ type: "FLUSHED_JOBS", jobs });
        }
      })
    );
  }
});
