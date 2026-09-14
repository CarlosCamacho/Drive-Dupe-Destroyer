/*
 * Drive Dupe Destroyer (DDD) — hashing.js
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
// Image hashing, with SharedArrayBuffer support when the headers allow it

import { makeLimiter, nowMs, CONFIG } from "./util.js";
import { AIMDController } from "./aimd.js";
import { isBackpressureError, isThrottleError } from "./common.js";
import { downloadFileBlob, thumbLinkSized } from "./drive.js";
import { ensureValidToken } from "./auth.js";

export { bestDist, hammingWithThreshold } from "./common.js";

// ============================================================================
// Dynamic Imports for Optional Modules
// ============================================================================

// There was a wasmModule here, dynamically importing js/wasm-hash.js for an
// advertised "2-3x speedup". It never once ran: initWasm() fetched ./dhash.wasm,
// a file that was not in the repository, had never been in its history, and that
// no build step produced. So isWasmAvailable() was permanently false, the guarded
// fast path below was dead, and the telemetry panel reported "WASM active: No" --
// which reads as a browser limitation rather than a missing file. Removed rather
// than completed; see #47 for the reasoning and for what finishing it would have
// required (a build step, and a test asserting the two paths produce
// byte-identical hashes, without which #42 recurs).
let sharedWorkerPoolModule = null;

async function loadOptionalModules() {
  
  // Try to load SharedWorkerPool
  try {
    sharedWorkerPoolModule = await import("./shared-worker-pool.js");
    console.log('[Hashing] SharedWorkerPool module loaded');
  } catch (e) {
    console.log('[Hashing] SharedWorkerPool not available');
  }
}

// ============================================================================
// LRU Cache for Thumbnails
// ============================================================================

/**
 * LRU cache of blob URLs, bounded by BYTES rather than entry count.
 *
 * The previous version capped at 5000 entries with no regard for their size.
 * Because the thumbnail fast-path failed (CORS) and the fallback downloaded the
 * full-resolution original, those 5000 entries could be 5000 multi-megabyte
 * photos — tens of gigabytes of live blob references. An eviction policy that
 * ignores object size cannot bound memory.
 */
class BlobUrlCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.cache = new Map();   // key -> { url, bytes }
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);   // refresh recency
    return entry.url;
  }

  set(key, url, bytes = 0) {
    const existing = this.cache.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.cache.delete(key);
      if (existing.url !== url) this._revoke(existing.url);
    }

    this.cache.set(key, { url, bytes });
    this.bytes += bytes;
    this._evictToFit();
  }

  _evictToFit() {
    // Always keep at least one entry, so a single blob larger than the whole
    // budget is still usable rather than being evicted the instant it is added.
    while (this.bytes > this.maxBytes && this.cache.size > 1) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.bytes -= oldest.bytes;
      this._revoke(oldest.url);
    }
  }

  _revoke(url) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch {}
    }
  }

  has(key) { return this.cache.has(key); }

  clear() {
    for (const { url } of this.cache.values()) this._revoke(url);
    this.cache.clear();
    this.bytes = 0;
  }

  get size() { return this.cache.size; }
  get byteSize() { return this.bytes; }
}

// 192 MB of decoded-image blobs is generous for a results table and small
// enough to stay well clear of a tab's memory ceiling on a modest machine.
const THUMB_CACHE_BYTES = 192 * 1024 * 1024;
const thumbUrlCache = new BlobUrlCache(THUMB_CACHE_BYTES);

// Every hash path downsamples to this edge length before looking at pixels.
// dHash reduces to 12x12 (144 bits) or 8x8 (64 bits) and pHash to 32x32, so
// 256px is already far more detail than any of them consume.
const HASH_EDGE = 256;

/**
 * Bump whenever a change would make newly computed hashes incomparable with
 * cached ones. Records written under an older version are treated as cache
 * misses and recomputed, rather than being compared against fresh hashes
 * derived differently — which would silently break matching for part of a
 * library with no visible error.
 *
 * 2: the (since removed, see #47) WASM path now downsamples to HASH_EDGE before
 *    hashing. It previously hashed at full resolution, so its cached values
 *    match neither the worker path's nor anything computed after this bump.
 *    Kept in this list because records written under version 1 still exist in
 *    users' caches and must still be treated as misses.
 * 3: hashes are now composited onto white instead of transparent black, so
 *    images with an alpha channel hash differently (and correctly) from before.
 */
export const HASH_VERSION = 3;

// ============================================================================
// Hashing Statistics
// ============================================================================

let hashingStats = {
  success: 0,
  failed: 0,
  retried: 0,
  throttled: 0,          // 429s seen — drives the AIMD decrease
  concurrency: CONFIG.HASH_CONCURRENCY,
  cacheHits: 0,
  hashed: 0,           // images actually hashed this run
  errors: [],
  startTime: 0,
  endTime: 0
};

export function getHashingStats() {
  const duration = hashingStats.endTime - hashingStats.startTime;
  return { 
    ...hashingStats,
    duration,
    rate: hashingStats.success > 0 && duration > 0
      ? (hashingStats.success / (duration / 1000)).toFixed(1)
      : 0,
    sabAvailable: sharedWorkerPoolModule?.getSecurityHeadersStatus?.().sabAvailable || false
  };
}

export function resetHashingStats() {
  hashingStats = { 
    success: 0, failed: 0, retried: 0, cacheHits: 0,
    throttled: 0, concurrency: CONFIG.HASH_CONCURRENCY,
    hashed: 0, errors: [],
    startTime: nowMs(), endTime: 0
  };
}

export function releaseAllThumbBlobs() {
  thumbUrlCache.clear();
}

// ============================================================================
// Worker Pool
// ============================================================================

const WORKER_POOL_SIZE = Math.min(
  Math.max(2, navigator.hardwareConcurrency - 1 || 3),
  8
);

const workers = [];
let workerIndex = 0;
let msgId = 0;
const pending = new Map();
let poolInitialized = false;
let modulesLoaded = false;

async function initHashModule() {
  if (modulesLoaded) return;
  modulesLoaded = true;
  await loadOptionalModules();
}

function initWorkerPool() {
  if (poolInitialized) return;
  poolInitialized = true;
  
  console.log(`[Hashing] Initializing worker pool with ${WORKER_POOL_SIZE} workers`);
  
  for (let i = 0; i < WORKER_POOL_SIZE; i++) {
    try {
      const worker = new Worker(
        new URL("./worker-hash.js", import.meta.url), 
        { type: "module" }
      );
      
      worker.onmessage = (ev) => {
        const r = ev.data;
        const p = pending.get(r.id);
        if (!p) return;
        pending.delete(r.id);
        if (r.ok) p.resolve(r);
        else p.reject(new Error(r.error || "Hash worker failed"));
      };
      
      worker.onerror = (e) => console.error(`[Worker ${i}] Error:`, e);
      workers.push(worker);
    } catch (e) {
      console.error(`Failed to create worker ${i}:`, e);
    }
  }
}

function getNextWorker() {
  initWorkerPool();
  if (workers.length === 0) throw new Error("No workers available");
  const idx = workerIndex;
  workerIndex = (workerIndex + 1) % workers.length;
  return { worker: workers[idx], index: idx };
}

function hashInWorker(bitmap, withVariants, timeout = 30000, withCropDetect = false, withColorMatch = false, withPHash = false, withRotation = false) {
  const id = ++msgId;
  const { worker, index } = getNextWorker();
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Hash computation timeout"));
    }, timeout);
    
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); },
      workerIndex: index
    });
    
    worker.postMessage({ id, bitmap, withVariants, withCropDetect, withColorMatch, withPHash, withRotation }, [bitmap]);
  });
}

// ============================================================================
// File Processing
// ============================================================================

/**
 * Blob URL for DISPLAY, at roughly `size` px.
 *
 * This is the fallback path: render.js points <img> at file.thumbnailLink
 * directly, which costs no memory and no API quota. We only get here when a
 * file has no thumbnailLink or that link failed to load, and then the blob is
 * an authenticated download.
 *
 * The cache key is deliberately distinct from anything the hashing path uses.
 * Both previously wrote `${id}-256`, so the full-resolution original downloaded
 * for hashing was handed straight to a 44px <img> — the browser then decoded a
 * whole 4000x3000 photo (or a 60 MB RAW) to paint a thumbnail.
 */
export async function getThumbUrlForFile(file, { signal = null, size = 256 } = {}) {
  const cacheKey = `display:${file.id}:${size}`;
  if (thumbUrlCache.has(cacheKey)) return thumbUrlCache.get(cacheKey);

  try {
    const blob = await downloadFileBlob(file.id, {
      altThumbUrl: file.thumbnailLink ? thumbLinkSized(file.thumbnailLink, size) : null,
      // preferThumb was never passed here, so display thumbnails downloaded the
      // full original too. For a 44px cell that is the wrong end of the trade.
      preferThumb: true,
      signal,
      maxSize: 5 * 1024 * 1024
    });

    if (blob) {
      const url = URL.createObjectURL(blob);
      thumbUrlCache.set(cacheKey, url, blob.size || 0);
      return url;
    }
  } catch (e) {
    console.warn(`Failed to load thumbnail for ${file.id}:`, e.message);
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Compute hash using WASM if available, otherwise worker
 */
async function computeHashOptimized(blob, withVariants, withCropDetect = false, withColorMatch = false, withPHash = false, withRotation = false) {
  hashingStats.hashed++;
  
  const bmp = await createImageBitmap(blob, {
    resizeWidth: HASH_EDGE,
    resizeHeight: HASH_EDGE,
    resizeQuality: 'low',
    premultiplyAlpha: 'none'
  });
  
  const result = await hashInWorker(bmp, withVariants, 30000, withCropDetect, withColorMatch, withPHash, withRotation);

  return {
    base8: new Uint8Array(result.base8),
    base12: new Uint8Array(result.base12),
    variants: (result.variants || []).map(v => ({
      base8: new Uint8Array(v.base8),
      base12: new Uint8Array(v.base12)
    })),
    cropHashes: result.cropHashes ? result.cropHashes.map(ch => ({
      name: ch.name,
      hash: new Uint8Array(ch.hash)
    })) : null,
    colorHist: result.colorHist ? new Uint8Array(result.colorHist) : null,
    edgeHist: result.edgeHist ? new Uint8Array(result.edgeHist) : null,
    pHashBits: result.pHashBits ? new Uint8Array(result.pHashBits) : null
  };
}

async function computeHashForFileWithRetry(file, {
  withVariants = false,
  withCropDetect = false,
  withColorMatch = false,
  withPHash = false,
  withRotation = false,
  signal = null,
  maxRetries = 3,
  retryDelayMs = 1000
} = {}) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) throw new Error("Scan stopped.");
      await ensureValidToken();
      
      // Use the thumbnail fast-path only for plain perceptual hashing. Crop and
      // color matching inspect sub-regions / full histograms and need the extra
      // resolution of the original, so we keep downloading originals for those.
      // dHash/pHash downscale to <=32px anyway, so a 512px thumbnail is ample.
      const canUseThumb = !withCropDetect && !withColorMatch;
      const thumbSize = canUseThumb ? 512 : 256;
      const thumb = file.thumbnailLink ? thumbLinkSized(file.thumbnailLink, thumbSize) : null;
      const blob = await downloadFileBlob(file.id, { altThumbUrl: thumb, signal, preferThumb: canUseThumb });

      // The hash-source blob is NOT retained. It used to be stored under
      // `${file.id}-256` — the same key the results table reads for display —
      // so a scan left thousands of full-resolution originals alive in the blob
      // cache and then painted them into 44px thumbnails. createImageBitmap
      // consumes what it needs below; after that the blob is garbage.
      const result = await computeHashOptimized(blob, withVariants, withCropDetect, withColorMatch, withPHash, withRotation);
      if (attempt > 1) hashingStats.retried++;
      return result;
      
    } catch (e) {
      lastError = e;
      if (signal?.aborted || e.message === "Scan stopped.") throw e;

      // A decode failure is deterministic: the bytes will not become decodable
      // on a second attempt, and each retry re-downloads the whole file. With
      // maxRetries=3 that tripled the transfer cost of every unsupported format
      // before giving up.
      const undecodable =
        e?.name === "InvalidStateError" ||
        /source image|decode|unsupported|could not be decoded/i.test(e?.message || "");
      if (undecodable) {
        throw Object.assign(e, { code: "UNDECODABLE" });
      }

      if (attempt < maxRetries) {
        let delay = retryDelayMs * Math.pow(2, attempt - 1);
        if (e.message?.includes("429")) delay = Math.max(delay, 5000);
        if (e.message?.includes("401")) {
          try { await ensureValidToken(); } catch {}
        }
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

export async function computeHashesForFile(file, opts = {}) {
  return computeHashForFileWithRetry(file, { ...opts, maxRetries: 1 });
}

export async function computeHashesForFiles(files, {
  withVariants = false,
  withCropDetect = false,
  withColorMatch = false,
  withPHash = false,
  withRotation = false,
  concurrency = CONFIG.HASH_CONCURRENCY,
  signal = null,
  onProgress = null,
  onError = null
} = {}) {
  resetHashingStats();
  hashingStats.startTime = nowMs();
  
  await initHashModule();

  const limit = makeLimiter(concurrency);

  // Adaptive throttle. Without this, a 429 only slowed the one file that hit it:
  // all six workers backed off independently and then independently resumed at
  // full rate, which is the pattern that keeps a rate limit pinned. The
  // controller has existed in aimd.js since v12 but was never connected to
  // anything, while scan.js advertised an "AIMD throttle" in its header.
  const aimd = new AIMDController({
    initial: concurrency,
    max: Math.max(concurrency, 12),
    min: 1,
    onUpdate: (n) => {
      limit.setConcurrency(n);
      hashingStats.concurrency = n;
      console.log(`[Hashing] Concurrency → ${n}`);
    }
  });

  let done = 0;
  const out = new Map();
  const failedFiles = [];
  
  let lastTokenCheck = Date.now();
  const TOKEN_CHECK_INTERVAL = 5 * 60 * 1000;
  
  const promises = files.map(f => limit(async () => {
    if (signal?.aborted) throw new Error("Scan stopped.");
    
    if (Date.now() - lastTokenCheck > TOKEN_CHECK_INTERVAL) {
      try { await ensureValidToken(); lastTokenCheck = Date.now(); } catch {}
    }
    
    try {
      const hashes = await computeHashForFileWithRetry(f, { withVariants, withCropDetect, withColorMatch, withPHash, withRotation, signal });
      out.set(f.id, hashes);
      hashingStats.success++;
      aimd.onSuccess();
    } catch (e) {
      if (signal?.aborted || e.message === "Scan stopped.") throw e;

      // Back off only for failures that mean the server is under pressure from
      // us — see isBackpressureError in common.js. A decode failure is not one.
      const throttled = isThrottleError(e);
      if (throttled) hashingStats.throttled++;
      if (isBackpressureError(e)) aimd.onError(throttled);
      
      const errorInfo = { fileId: f.id, fileName: f.name, error: e.message || String(e) };
      hashingStats.failed++;
      hashingStats.errors.push(errorInfo);
      failedFiles.push(f);
      out.set(f.id, { base8: null, base12: null, variants: [] });
      if (onError) onError(errorInfo);
    }
    
    done++;
    if (onProgress) onProgress(done, files.length);
  }));
  
  await Promise.all(promises);
  hashingStats.endTime = nowMs();
  
  return { out, failed: hashingStats.failed, failedFiles, stats: getHashingStats() };
}

export function terminateWorkers() {
  for (const worker of workers) {
    try { worker.terminate(); } catch {}
  }
  workers.length = 0;
  workerIndex = 0;
  pending.clear();
  poolInitialized = false;
}

export function getWorkerPoolStatus() {
  return {
    poolSize: workers.length,
    pendingJobs: pending.size,
    initialized: poolInitialized,
  };
}
