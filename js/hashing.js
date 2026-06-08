/*
 * Drive Dupe Destroyer (DDD) v14.0 — hashing.js
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
// Image hashing with WASM acceleration and SharedArrayBuffer support

import { makeLimiter, nowMs, CONFIG } from "./util.js";
import { downloadFileBlob, thumbLinkSized } from "./drive.js";
import { ensureValidToken } from "./auth.js";

export { bestDist, hammingWithThreshold } from "./common.js";

// ============================================================================
// Dynamic Imports for Optional Modules
// ============================================================================

let wasmModule = null;
let sharedWorkerPoolModule = null;

async function loadOptionalModules() {
  // Try to load WASM module
  try {
    wasmModule = await import("./wasm-hash.js");
    await wasmModule.initWasm();
    console.log('[Hashing] WASM module loaded');
  } catch (e) {
    console.log('[Hashing] WASM module not available, using JS fallback');
  }
  
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

class LRUCache {
  constructor(maxSize = 5000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      const oldestValue = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (typeof oldestValue === 'string' && oldestValue.startsWith('blob:')) {
        try { URL.revokeObjectURL(oldestValue); } catch {}
      }
    }
    this.cache.set(key, value);
  }
  
  has(key) { return this.cache.has(key); }
  clear() {
    for (const value of this.cache.values()) {
      if (typeof value === 'string' && value.startsWith('blob:')) {
        try { URL.revokeObjectURL(value); } catch {}
      }
    }
    this.cache.clear();
  }
  get size() { return this.cache.size; }
}

const thumbUrlCache = new LRUCache(5000);

// ============================================================================
// Hashing Statistics
// ============================================================================

let hashingStats = {
  success: 0,
  failed: 0,
  retried: 0,
  cacheHits: 0,
  wasmUsed: 0,
  jsUsed: 0,
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
    wasmAvailable: wasmModule?.isWasmAvailable?.() || false,
    sabAvailable: sharedWorkerPoolModule?.getSecurityHeadersStatus?.().sabAvailable || false
  };
}

export function resetHashingStats() {
  hashingStats = { 
    success: 0, failed: 0, retried: 0, cacheHits: 0,
    wasmUsed: 0, jsUsed: 0, errors: [],
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

export async function getThumbUrlForFile(file, { signal = null, size = 256 } = {}) {
  const cacheKey = `${file.id}-${size}`;
  if (thumbUrlCache.has(cacheKey)) return thumbUrlCache.get(cacheKey);
  
  try {
    const blob = await downloadFileBlob(file.id, {
      altThumbUrl: file.thumbnailLink ? thumbLinkSized(file.thumbnailLink, size) : null,
      signal,
      maxSize: 5 * 1024 * 1024
    });
    
    if (blob) {
      const url = URL.createObjectURL(blob);
      thumbUrlCache.set(cacheKey, url);
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
  // Try WASM path if available (for base hashes only, worker for extended features)
  if (wasmModule?.isWasmAvailable?.() && !withCropDetect && !withColorMatch) {
    try {
      const imageBitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      const base12 = wasmModule.computeDHashFromRGBA(imageData.data, canvas.width, canvas.height, 12);
      const base8 = wasmModule.computeDHashFromRGBA(imageData.data, canvas.width, canvas.height, 8);
      
      hashingStats.wasmUsed++;
      imageBitmap.close();
      
      let variants = [];
      if (withVariants) {
        // Use worker for variant transforms
        const bmp = await createImageBitmap(blob, { resizeWidth: 256, resizeHeight: 256, resizeQuality: 'low' });
        const result = await hashInWorker(bmp, true);
        variants = (result.variants || []).map(v => ({
          base8: new Uint8Array(v.base8),
          base12: new Uint8Array(v.base12)
        }));
      }
      
      return { base8, base12, variants, cropHashes: null, colorHist: null, edgeHist: null };
    } catch (e) {
      console.warn('[WASM] Hash failed, falling back to worker:', e.message);
    }
  }
  
  // Worker fallback (also used when crop/color features are enabled)
  hashingStats.jsUsed++;
  
  const bmp = await createImageBitmap(blob, {
    resizeWidth: 256,
    resizeHeight: 256,
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
      
      const cacheKey = `${file.id}-256`;
      if (!thumbUrlCache.has(cacheKey)) {
        thumbUrlCache.set(cacheKey, URL.createObjectURL(blob));
      }
      
      const result = await computeHashOptimized(blob, withVariants, withCropDetect, withColorMatch, withPHash, withRotation);
      if (attempt > 1) hashingStats.retried++;
      return result;
      
    } catch (e) {
      lastError = e;
      if (signal?.aborted || e.message === "Scan stopped.") throw e;
      
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
    } catch (e) {
      if (signal?.aborted || e.message === "Scan stopped.") throw e;
      
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
    wasmAvailable: wasmModule?.isWasmAvailable?.() || false
  };
}
