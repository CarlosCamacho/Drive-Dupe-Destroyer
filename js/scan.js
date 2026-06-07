/*
 * Drive Dupe Destroyer (DDD) v14.0 — scan.js
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
// Security: folder IDs validated before API calls
// Main scanning logic with PROGRESSIVE RESULTS
// v12.0: MD5 fast-path, AIMD throttle, resume, delta scan, aspect filter, pHash, LSH auto-tune, rejection filter

import { el, nowMs, humanDuration, CONFIG } from "./util.js";
import { setStatus, setPhase, setProgress, showSpinner, updateStats, setSearchSummary, showEmptyState, setScanningState, showToast, setHashingErrors, updateEta, resetEta, showCollectingSpinner } from "./ui.js";
import { driveFetch, fetchChangesSince, getChangesStartToken } from "./drive.js";

import { ensureValidToken } from "./auth.js";
import { dbGetImagesBatch, dbPutImagesBatch, recordFoldersScan, dbCountImages, getChangesToken, setChangesToken } from "./db.js";
import { computeHashesForFiles, getHashingStats } from "./hashing.js";
import { saveResumeState, clearResumeState } from "./resume.js";
import { getRejectionStats, preloadRejections, isRejectedPairSync } from "./rejection.js";
import { updateTelemetry } from "./telemetry.js";
import { bestDist, bestDistExtended, bestDistWithPHash, thresholdFromEasy, isSupportedImageFile, aspectRatioCompatible, SUPPORTED_IMAGE_MIMES, getFileExtension } from "./common.js";
import { makeUnionFind } from "./unionfind.js";
import { buildPathsParallel, clearPathCaches } from "./paths.js";
import { buildAutoTunedLshIndex, lshCandidates, lshStats } from "./lsh.js";

// ============================================================================
// Constants
// ============================================================================

const FIELDS = [
  "nextPageToken",
  "files(id,name,mimeType,size,modifiedTime,createdTime,parents,thumbnailLink,md5Checksum,webViewLink,imageMediaMetadata(width,height,time))"
].join(",");

// Progress update intervals
const MATCH_EMIT_INTERVAL = 10;      // Emit after every N new matches (render side coalesces per frame)
const STATUS_UPDATE_INTERVAL = 500;  // ms between status updates

// Cooperative main-thread yield. setTimeout(0) is clamped to ~4ms by browsers
// and competes with timers, so a tight loop that yields via setTimeout still
// hogs the thread. A MessageChannel postMessage resolves on the very next
// macrotask with no clamp, letting queued input handlers and paints run before
// we resume — a much cleaner hand-off that keeps the foreground responsive.
let _yieldChannel = null;
function yieldToUI() {
  if (typeof MessageChannel === "undefined") {
    return new Promise(r => setTimeout(r, 0));
  }
  if (!_yieldChannel) _yieldChannel = new MessageChannel();
  return new Promise(resolve => {
    const ch = _yieldChannel;
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

// ============================================================================
// Drive API Functions
// ============================================================================

// v14.0 BUGFIX — Drive discovery query.
//
// v12.8 tried to discover PSD/TGA/IFF/PCX with `name contains '.psd'` clauses.
// That does NOT work: Google Drive documents that the `contains` operator does
// *prefix* matching on the `name` term (a file named "HelloWorld" matches
// `name contains 'Hello'` but NOT `name contains 'World'`), so
// `name contains '.psd'` never matches "photo.psd". Worse, chaining 14 such
// clauses bloated the query and risked the whole request failing server-side —
// which silently returned zero files for the folder, so even plain GIFs that
// matched `mimeType contains 'image/'` were never seen (the symptom reported in
// v12.8: two identical title.gif copies "not found", unaffected by clearing the
// cache because the failure was at collection time).
//
// Discover by MIME type only. The generic `image/` prefix covers
// gif/jpg/png/webp/bmp/tiff/etc. The remaining (non-image/) MIME types Drive
// assigns to design/legacy formats are derived from SUPPORTED_IMAGE_MIMES in
// common.js — the single source of truth for supported formats — so adding a
// format there automatically updates this query. `mimeType =` is exact and
// reliable (unlike the v12.8 name-prefix match this replaces). octet-stream is
// included because Drive often reports PSD/TGA/IFF/PCX uploads that way; the
// client-side isSupportedImageFile() extension filter then drops any
// non-image binaries that slipped through.
const NON_IMAGE_MIME_QUERIES = Array.from(SUPPORTED_IMAGE_MIMES)
  .filter(mt => !mt.startsWith('image/'))
  .map(mt => `mimeType = '${mt}'`)
  .join(' or ');

function buildQuery(folderId) {
  const extra = NON_IMAGE_MIME_QUERIES ? ` or ${NON_IMAGE_MIME_QUERIES}` : '';
  return `'${folderId}' in parents and trashed = false and (mimeType contains 'image/'${extra})`;
}

async function listFolderLevel(folderId, pageSize, signal) {
  const out = [];
  let token = null;
  
  do {
    if (signal?.aborted) throw new Error("Scan stopped.");
    await ensureValidToken();
    
    const res = await driveFetch("files", {
      params: {
        q: buildQuery(folderId),
        fields: FIELDS,
        pageSize: String(pageSize),
        pageToken: token || undefined,
        orderBy: "folder,name"
      },
      signal
    });
    
    for (const f of (res.files || [])) out.push(f);
    token = res.nextPageToken || null;
  } while (token);
  
  return out;
}

async function listFolders(folderId, pageSize, signal) {
  const out = [];
  let token = null;
  
  do {
    if (signal?.aborted) throw new Error("Scan stopped.");
    await ensureValidToken();
    
    const res = await driveFetch("files", {
      params: {
        q: `'${folderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
        fields: "nextPageToken, files(id,name)",
        pageSize: String(pageSize),
        pageToken: token || undefined
      },
      signal
    });
    
    for (const f of (res.files || [])) out.push(f);
    token = res.nextPageToken || null;
  } while (token);
  
  return out;
}

// ============================================================================
// File Collection
// ============================================================================

async function fetchAllImagesRecursive({ folderIds, exclusions, maxItems, pageSize, signal, onStatus }) {
  const visited = new Set(exclusions);
  const allFiles = [];
  const queue = [...folderIds];
  let foldersScanned = 0;
  let totalSubfoldersFound = 0;
  let lastTokenCheck = Date.now();
  let lastStatusUpdate = Date.now();
  const TOKEN_CHECK_INTERVAL = 5 * 60 * 1000;

  while (queue.length > 0) {
    if (signal?.aborted) throw new Error("Scan stopped.");
    if (maxItems > 0 && allFiles.length >= maxItems) break;

    const folderId = queue.shift();
    if (visited.has(folderId)) continue;
    visited.add(folderId);
    foldersScanned++;

    if (Date.now() - lastTokenCheck > TOKEN_CHECK_INTERVAL) {
      try {
        await ensureValidToken();
        lastTokenCheck = Date.now();
      } catch (e) {
        console.warn("Token refresh during collection failed:", e.message);
      }
    }

    // Always update status on each folder for visibility
    if (Date.now() - lastStatusUpdate > 200) {
      if (onStatus) onStatus(`Scanning folder ${foldersScanned}… (${allFiles.length} images found, ${queue.length} subfolders queued, ${totalSubfoldersFound} total subfolders discovered)`);
      lastStatusUpdate = Date.now();
    }

    try {
      const [images, subfolders] = await Promise.all([
        listFolderLevel(folderId, pageSize, signal),
        listFolders(folderId, pageSize, signal)
      ]);

      for (const img of images) {
        if (maxItems > 0 && allFiles.length >= maxItems) break;
        allFiles.push(img);
      }

      totalSubfoldersFound += subfolders.length;
      for (const sub of subfolders) {
        if (!visited.has(sub.id)) queue.push(sub.id);
      }
    } catch (e) {
      if (signal?.aborted || e.message === "Scan stopped.") throw e;
      console.warn(`Error scanning folder ${folderId}:`, e.message);
    }
  }

  if (onStatus) onStatus(`Collection complete: ${allFiles.length} images in ${foldersScanned} folders (${totalSubfoldersFound} subfolders traversed)`);
  console.log(`[DDD] Recursive scan: ${foldersScanned} folders scanned, ${totalSubfoldersFound} subfolders discovered, ${allFiles.length} images found`);
  return allFiles;
}

async function fetchAllImagesFlat({ folderIds, exclusions, maxItems, pageSize, signal, onStatus }) {
  const allFiles = [];
  let foldersDone = 0;

  // exclusions may arrive as a Set (from getExclusions) or an array. Normalize
  // to a Set so membership checks work either way. (Previously this called
  // exclusions.includes(), which throws on a Set and aborted flat scans.)
  const excludedSet = exclusions instanceof Set ? exclusions : new Set(exclusions || []);

  for (const fid of folderIds) {
    if (signal?.aborted) throw new Error("Scan stopped.");
    if (excludedSet.has(fid)) continue;
    if (maxItems > 0 && allFiles.length >= maxItems) break;

    foldersDone++;
    if (onStatus) onStatus(`Scanning folder ${foldersDone}/${folderIds.length}… (${allFiles.length} images)`);

    try {
      const images = await listFolderLevel(fid, pageSize, signal);
      for (const img of images) {
        if (maxItems > 0 && allFiles.length >= maxItems) break;
        allFiles.push(img);
      }
    } catch (e) {
      if (signal?.aborted || e.message === "Scan stopped.") throw e;
      console.warn(`Error scanning folder ${fid}:`, e.message);
    }
  }

  return allFiles;
}

// ============================================================================
// Hash Computation with DB Cache
// ============================================================================

async function computeHashesWithDb(images, { 
  useDb = true, 
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
  const toCompute = [];
  const idToEntry = new Map();
  let cacheHits = 0;

  // Check DB cache first
  if (useDb) {
    try {
      const ids = images.map(f => f.id);
      const dbRecords = await dbGetImagesBatch(ids).catch(() => new Map());
      
      for (const f of images) {
        const rec = dbRecords.get(f.id);
        if (rec?.base12) {
          // If crop/color detection was requested but not in cache, need to recompute
          const needsCrop = withCropDetect && !rec.cropHashes;
          const needsColor = withColorMatch && (!rec.colorHist || !rec.edgeHist);
          
          if (needsCrop || needsColor) {
            toCompute.push(f);
          } else {
            cacheHits++;
            idToEntry.set(f.id, {
              base8: new Uint8Array(rec.base8),
              base12: new Uint8Array(rec.base12),
              variants: (rec.variants || []).map(v => ({
                base8: new Uint8Array(v.base8),
                base12: new Uint8Array(v.base12)
              })),
              cropHashes: rec.cropHashes ? rec.cropHashes.map(ch => ({
                name: ch.name,
                hash: new Uint8Array(ch.hash)
              })) : null,
              colorHist: rec.colorHist ? new Uint8Array(rec.colorHist) : null,
              edgeHist: rec.edgeHist ? new Uint8Array(rec.edgeHist) : null
            });
          }
        } else {
          toCompute.push(f);
        }
      }
    } catch (e) {
      console.warn("Cache lookup failed:", e.message);
      toCompute.push(...images);
    }
  } else {
    toCompute.push(...images);
  }

  let hashingFailed = 0;
  let failedFiles = [];
  let hashErrors = [];

  if (toCompute.length > 0) {
    const result = await computeHashesForFiles(toCompute, { 
      withVariants,
      withCropDetect,
      withColorMatch,
      withPHash,
      withRotation,
      concurrency, 
      signal, 
      onProgress,
      onError
    });
    
    hashingFailed = result.failed || 0;
    failedFiles = result.failedFiles || [];
    hashErrors = result.stats?.errors || [];
    
    const recordsToSave = [];
    
    for (const f of toCompute) {
      const e = result.out.get(f.id);
      if (e) {
        idToEntry.set(f.id, e);
        
        if (useDb && e.base12) {
          recordsToSave.push({
            id: f.id,
            name: f.name,
            size: f.size,
            md5: f.md5Checksum || null,
            modifiedTime: f.modifiedTime,
            parents: f.parents,
            mimeType: f.mimeType,
            base8: e.base8,
            base12: e.base12,
            variants: e.variants,
            cropHashes: e.cropHashes || null,
            colorHist: e.colorHist || null,
            edgeHist: e.edgeHist || null,
            pHashBits: e.pHashBits || null
          });
        }
      }
    }
    
    // Save to cache in background
    if (recordsToSave.length > 0) {
      dbPutImagesBatch(recordsToSave)
        .then(() => updateCacheCount())
        .catch(e => console.warn("Batch save failed:", e));
    }
  }

  return { 
    idToEntry, 
    cacheHit: images.length > 0 ? cacheHits / images.length : 0,
    hashingFailed,
    failedFiles,
    errors: hashErrors
  };
}

async function updateCacheCount() {
  const dbCount = el("dbCount");
  if (dbCount) {
    try {
      const count = await dbCountImages();
      dbCount.textContent = count.toLocaleString();
      console.log(`Cache count updated: ${count} images`);
    } catch (err) {
      console.error("Failed to update cache count:", err);
      dbCount.textContent = "—";
    }
  }
}

// ============================================================================
// Quick Exact Match (MD5-based)
// ============================================================================

function quickExactGroups(images) {
  const map = new Map();
  
  for (const f of images) {
    const key = `${f.md5Checksum || ""}|${f.size || 0}`;
    if (!key.startsWith("|") && f.md5Checksum) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    }
  }
  
  return Array.from(map.values()).filter(g => g.length > 1);
}

// ============================================================================
// PROGRESSIVE MATCHING - Core Innovation
// ============================================================================

/**
 * Find matches progressively, emitting results as they're discovered
 * 
 * @param {Map} idToEntry - Hash entries by file ID
 * @param {Map} idToFile - File metadata by ID
 * @param {Object} options - Matching options
 * @param {Function} onMatchFound - Callback when a new match group is found/updated
 * @param {AbortSignal} signal - Cancellation signal
 */
async function findMatchesProgressively({
  idToEntry,
  idToFile,
  idToFileMeta,
  hamThresh,
  withVariants,
  withCropDetect,
  withColorMatch,
  withPHash,
  useAspectFilter,
  aspectTolerancePct,
  lshModeEl,
  signal,
  onMatchFound,
  onProgress
}) {
  const uf = makeUnionFind();
  const lshForceMode = typeof lshModeEl !== 'undefined' ? (lshModeEl || 'auto') : 'auto';
  const index = buildAutoTunedLshIndex(idToEntry, { use12: true, targetThreshold: hamThresh, forceMode: lshForceMode });
  
  // Log LSH stats
  const stats = lshStats(index);
  console.log(`[DDD] LSH Index Stats:`, stats);
  if (withCropDetect) console.log(`[DDD] Crop detection enabled`);
  if (withColorMatch) console.log(`[DDD] Color histogram matching enabled`);
  
  const ids = Array.from(idToEntry.keys());
  const idIndex = new Map(ids.map((id, idx) => [id, idx]));
  
  let comparisons = 0;
  let matches = 0;
  let lastYield = performance.now();
  let lastEmit = 0;
  let sinceYieldCheck = 0;  // cheap counter to rate-limit the time-based yield check
  
  // Track which groups have been emitted
  const emittedGroups = new Map();  // root -> group array
  // Roots whose membership changed since the last flush. We throttle how often
  // we emit, but we must flush EVERY changed group — not just the most recent
  // one — or the live view silently drops groups formed between flushes.
  const dirtyRoots = new Set();

  // Flush all dirty groups to the UI, then clear the dirty set.
  const flushDirty = () => {
    if (onMatchFound && dirtyRoots.size > 0) {
      // Build root -> members in ONE pass over ids, rather than scanning all ids
      // once per dirty root (which was O(ids x dirtyRoots) every flush and ran on
      // the main thread). We only collect members for roots that are dirty.
      const membersByRoot = new Map();
      for (let gi = 0; gi < ids.length; gi++) {
        const gid = ids[gi];
        const root = uf.find(gid);
        if (!dirtyRoots.has(root)) continue;
        let arr = membersByRoot.get(root);
        if (!arr) { arr = []; membersByRoot.set(root, arr); }
        const f = idToFile.get(gid);
        if (f) arr.push(f);
      }
      for (const root of dirtyRoots) {
        const group = membersByRoot.get(root);
        if (group && group.length > 1) {
          emittedGroups.set(root, group);
          onMatchFound({
            group,
            root,
            totalMatches: matches,
            totalGroups: emittedGroups.size
          });
        }
      }
    }
    // Always clear and advance so dirtyRoots can't grow unbounded when there's
    // no progressive consumer attached.
    dirtyRoots.clear();
    lastEmit = matches;
  };
  
  // Use extended matching if crop or color are enabled
  const useExtended = withCropDetect || withColorMatch;
  
  for (let i = 0; i < ids.length; i++) {
    if (signal?.aborted) throw new Error("Scan stopped.");
    
    const id = ids[i];
    const entry = idToEntry.get(id);
    if (!entry?.base12) continue;
    
    const candidates = lshCandidates(index, id, entry);
    
    // When crop detection is on, we need broader candidate search
    // since cropped images may not share LSH bands.
    // Use combined color+edge similarity as additional candidates.
    let extendedCandidates = candidates;
    if (withCropDetect && withColorMatch && entry.colorHist && entry.edgeHist) {
      const colorCandidates = new Set(candidates);
      const MAX_COLOR_SCAN = Math.min(ids.length, 2000);
      const startIdx = Math.max(0, i - MAX_COLOR_SCAN);
      const endIdx = Math.min(ids.length, i + MAX_COLOR_SCAN);
      
      for (let j = startIdx; j < endIdx; j++) {
        if (j === i) continue;
        const otherId = ids[j];
        const otherEntry = idToEntry.get(otherId);
        if (!otherEntry?.colorHist || !otherEntry?.edgeHist) continue;
        
        // Quick color check on luminance bins
        let colorDiff = 0;
        for (let b = 24; b < 32; b++) {
          colorDiff += Math.abs(entry.colorHist[b] - otherEntry.colorHist[b]);
        }
        if (colorDiff >= 200) continue;
        
        // Quick edge direction check (first 6 bins of edgeHist)
        let edgeDiff = 0;
        for (let b = 0; b < 6; b++) {
          edgeDiff += Math.abs(entry.edgeHist[b] - otherEntry.edgeHist[b]);
        }
        // Only add if both color AND edge structure are similar
        if (edgeDiff < 300) {
          colorCandidates.add(otherId);
        }
      }
      extendedCandidates = colorCandidates;
    }
    
    for (const cid of extendedCandidates) {
      const ci = idIndex.get(cid);
      if (ci === undefined || ci <= i) continue;
      
      const centry = idToEntry.get(cid);
      if (!centry?.base12) continue;
      
      comparisons++;
      // Aspect ratio pre-filter (Feature #8) — free metadata check before Hamming
      if (useAspectFilter && idToFileMeta) {
        const fA = idToFileMeta.get(id);
        const fB = idToFileMeta.get(cid);
        if (fA && fB && !aspectRatioCompatible(fA, fB, aspectTolerancePct)) {
          continue;
        }
      }
      let d;
      if (withPHash) {
        d = bestDistWithPHash(entry, centry, withVariants, true, Math.ceil(hamThresh * 64 / 144));
        if (d > hamThresh && useExtended) {
          d = bestDistExtended(entry, centry, withVariants, true, withCropDetect, withColorMatch, hamThresh);
        }
      } else if (useExtended) {
        d = bestDistExtended(entry, centry, withVariants, true, withCropDetect, withColorMatch, hamThresh);
      } else {
        d = bestDist(entry, centry, withVariants, true);
      }
      
      if (d <= hamThresh) {
        // Respect the user's "not a duplicate" feedback: if this exact pair was
        // previously rejected, don't union them. (Previously filterRejectedPairs
        // was imported but never called, so rejected pairs kept reappearing.)
        if (isRejectedPairSync(entry, centry)) continue;

        matches++;
        
        // Union the two files
        const oldRootA = uf.find(id);
        const oldRootB = uf.find(cid);
        uf.union(id, cid);
        const newRoot = uf.find(id);
        
        // Mark the surviving root dirty; if a merge happened, retire the root
        // that was absorbed so we don't emit a stale (now-empty) group.
        if (oldRootA !== newRoot) { dirtyRoots.delete(oldRootA); emittedGroups.delete(oldRootA); }
        if (oldRootB !== newRoot) { dirtyRoots.delete(oldRootB); emittedGroups.delete(oldRootB); }
        dirtyRoots.add(newRoot);
        
        // Throttle how often we flush, but flush ALL dirty groups together so
        // none are dropped between flushes.
        if (matches - lastEmit >= MATCH_EMIT_INTERVAL || matches === 1) {
          flushDirty();
          // Keep status text in step with what the UI is showing.
          setStatus(`Finding matches… ${emittedGroups.size} groups (${matches} pairs)`);
        }
      }

      // Cooperative yield INSIDE the inner loop. The matching loop runs on the
      // main thread; if it holds the thread too long, clicks, image decoding and
      // paints all stall — that's what made the foreground feel dead during a
      // background scan. Checking time every few comparisons and handing the
      // thread back whenever we've held it >8ms keeps input/paint responsive,
      // even when a single item has thousands of candidates.
      if ((++sinceYieldCheck & 0x3F) === 0) {  // check ~every 64 comparisons
        const now = performance.now();
        if (now - lastYield > 8) {
          await yieldToUI();
          lastYield = performance.now();
        }
      }
    }
    
    // Report progress
    if (i % 100 === 0 && onProgress) {
      onProgress(i, ids.length, matches, emittedGroups.size);
    }
  }
  
  // Flush any groups changed in the final (partial) batch so the live view is
  // complete even if the scan ends mid-interval.
  flushDirty();
  
  // Final emission of all groups
  const finalGroups = [];
  const rootMap = new Map();
  
  for (const id of ids) {
    const root = uf.find(id);
    if (!rootMap.has(root)) rootMap.set(root, []);
    rootMap.get(root).push(idToFile.get(id));
  }
  
  for (const [root, group] of rootMap) {
    if (group.length > 1) {
      finalGroups.push(group);
    }
  }
  
  return {
    groups: finalGroups,
    comparisons,
    matches,
    uf
  };
}

// ============================================================================
// Main Scan Function
// ============================================================================

export async function runScan({ 
  folderIds, 
  folders = [], 
  exclusions, 
  signal, 
  renderCb,           // Final render callback
  onProgressiveMatch, // NEW: Progressive match callback
  emitGroupsCb 
}) {
  const start = nowMs();
  showSpinner(true);
  setScanningState(true);
  setProgress(0);
  resetEta();
  setPhase("1/4 Collecting files");
  
  // Record scan history
  if (folders.length > 0) {
    try {
      await recordFoldersScan(folders);
    } catch (e) {
      console.warn("Failed to record scan history:", e);
    }
  }
  
  let scanError = null;
  let hashingFailed = 0;
  let images = [];
  
  try {
    // Get settings from UI
    const recursive = el("recursiveMode")?.value === "yes";
    const maxItemsEl = el("maxItems");
    const pageSizeEl = el("pageSize");
    const maxItems = parseInt(maxItemsEl?.dataset?.actualValue || maxItemsEl?.value || "0", 10) || 0;
    const pageSize = parseInt(pageSizeEl?.dataset?.actualValue || pageSizeEl?.value || "500", 10) || 500;
    
    const imgMinSize = parseFloat(el("imgMinSize")?.value || "0") || 0;
    const imgMinUnit = el("imgMinUnit")?.value || "MB";
    const imgMaxSize = parseFloat(el("imgMaxSize")?.value || "999") || 999;
    const imgMaxUnit = el("imgMaxUnit")?.value || "MB";
    const minBytes = imgMinSize * (imgMinUnit === "KB" ? 1024 : 1024 * 1024);
    const maxBytes = imgMaxSize * (imgMaxUnit === "KB" ? 1024 : 1024 * 1024);
    
    const useDb = el("useDb")?.value !== "no";
    const matchMode = document.querySelector('input[name="matchMode"]:checked')?.value || "similar";
    const quickScan = matchMode === "exact";
    const sensitivityLevel = parseInt(el("sensitivityLevel")?.value || "3", 10);
    const hamThresh = thresholdFromEasy(sensitivityLevel);
    const keepRule = el("keepRule")?.value || "hires";
    const folderPriority = el("folderPriority")?.value || "";
    const dhashSize = parseInt(el("dhashSize")?.value || "12", 10);
    const withVariants = el("checkVariants")?.checked || el("checkVariants")?.value === "yes";
    const withCropDetect = el("cropDetect")?.checked || el("cropDetect")?.value === "yes";
    const withColorMatch = el("colorMatch")?.checked || el("colorMatch")?.value === "yes";
    const withPHash = el("pHashMode")?.checked || false;           // Feature #7
    const withRotation = el("rotationVariants")?.checked || false; // Feature #16
    const useAspectFilter = el("aspectFilter")?.checked || false;  // Feature #8
    const aspectTolerancePct = parseInt(el("aspectTolerance")?.value || "20", 10);
    const lshModeEl = el("lshMode")?.value || "auto";              // Feature #15

    // v14: per-format include toggles (🖼️ Image Types panel). Build the set of
    // enabled file extensions from the checked boxes. If the panel isn't present
    // (older markup), enabledExts stays null and nothing is filtered by type.
    const typeToggles = Array.from(document.querySelectorAll('.imgTypeToggle'));
    let enabledExts = null;
    if (typeToggles.length) {
      enabledExts = new Set();
      for (const cb of typeToggles) {
        if (!cb.checked) continue;
        for (const e of (cb.dataset.exts || '').split(',')) {
          const t = e.trim().toLowerCase();
          if (t) enabledExts.add(t);
        }
      }
    }

    // Feature #5: MD5 fast-path - pre-group exact duplicates before hashing
    // Feature #13: Delta scan - fetch only changed files
    const useChangesApi = el("useDeltaScan")?.checked || false;

    setSearchSummary(recursive, maxItems, useDb);

    // Phase 1: Collect files
    setStatus("Collecting files from Drive…");
    await ensureValidToken();
    
    const fetcher = recursive ? fetchAllImagesRecursive : fetchAllImagesFlat;
    let allItems = await fetcher({
      folderIds,
      exclusions,
      maxItems,
      pageSize,
      signal,
      onStatus: setStatus
    });
    
    if (signal?.aborted) throw new Error("Scan stopped.");

    // Feature #4: Save resume state after collection so a crash can resume
    try {
      await saveResumeState({
        folderIds,
        exclusions: exclusions instanceof Set ? Array.from(exclusions) : (exclusions || []),
        visitedFolderIds: Array.from(allItems.map(f => f.parents?.[0]).filter(Boolean)),
        hashedFileIds: [],
        totalImagesFound: allItems.length,
        options: { recursive, maxItems, pageSize, withVariants, withCropDetect, withColorMatch, withPHash, withRotation }
      });
    } catch {}

    // Filter by size and mime type
    images = allItems.filter(f => {
      const sz = Number(f.size || 0);
      if (!(isSupportedImageFile(f) && sz >= minBytes && sz <= maxBytes)) return false;
      // v14: honour the user's per-format selection. We match on extension; a
      // file with no/unknown extension (identified only by MIME) is not excluded
      // so we never silently drop a valid image just because it lacks a suffix.
      if (enabledExts) {
        const ext = getFileExtension(f.name);
        if (ext && !enabledExts.has(ext)) return false;
      }
      return true;
    });

    setStatus(`Found ${images.length} image(s).`);
    setProgress(10);
    showCollectingSpinner(false);

    // Feature #5: MD5 exact-duplicate fast path
    // Group files by md5Checksum before any hashing - zero cost since Drive API provides it
    const md5Groups = new Map();
    let md5ExactCount = 0;
    for (const f of images) {
      if (f.md5Checksum) {
        const key = f.md5Checksum;
        if (!md5Groups.has(key)) md5Groups.set(key, []);
        md5Groups.get(key).push(f);
      }
    }
    const exactDupeGroups = Array.from(md5Groups.values()).filter(g => g.length > 1);
    md5ExactCount = exactDupeGroups.reduce((s, g) => s + g.length, 0);
    if (exactDupeGroups.length > 0) {
      setStatus(`Found ${exactDupeGroups.length} exact duplicate group(s) via MD5 (${md5ExactCount} files). Continuing with perceptual hash…`);
      console.log(`[DDD] MD5 fast-path: ${exactDupeGroups.length} groups, ${md5ExactCount} exact dupes`);
    }

    // Feature #13: Delta scan - fetch only files changed since last scan
    let deltaRemovedIds = new Set();
    if (useChangesApi && !quickScan) {
      try {
        const savedToken = await getChangesToken();
        if (savedToken) {
          setStatus("Fetching changes since last scan…");
          const { files: changed, nextToken } = await fetchChangesSince(savedToken, { signal });
          const removedIds = changed.filter(f => f._removed).map(f => f.id);
          deltaRemovedIds = new Set(removedIds);
          // Add changed files not already in our list
          const existingIds = new Set(images.map(f => f.id));
          for (const cf of changed.filter(f => f._changed)) {
            if (!existingIds.has(cf.id)) images.push(cf);
          }
          // Remove deleted files
          images = images.filter(f => !deltaRemovedIds.has(f.id));
          if (nextToken) await setChangesToken(nextToken);
          setStatus(`Delta scan: ${changed.length} changes, ${removedIds.length} removed, ${images.length} images to process`);
        } else {
          // First run: get start token for future delta scans
          const startToken = await getChangesStartToken({ signal });
          if (startToken) await setChangesToken(startToken);
        }
      } catch (e) {
        console.warn("[DDD] Delta scan failed, doing full scan:", e.message);
      }
    }

    if (images.length === 0) {
      showEmptyState(true);
      setStatus("No images found.");
      setPhase("Complete");
      showSpinner(false);
      setScanningState(false);
      updateStats({ groups: 0, files: 0, totalBytes: 0, cacheHit: null, durationMs: nowMs() - start });
      return;
    }

    // Quick scan mode (MD5 only)
    if (quickScan) {
      setPhase("2/4 Finding exact matches");
      const groups = quickExactGroups(images);
      
      setPhase("3/4 Building paths");
      // Only grouped files need folder paths (see Phase 4 note below).
      const pathMap = await buildPathsParallel(groups.flat(), { 
        concurrency: CONFIG.PATH_CONCURRENCY, signal, 
        onProgress: (d, t) => setStatus(`Building paths… ${d}/${t}`) 
      });
      
      setPhase("4/4 Rendering");
      await renderCb({ 
        groups, idToEntry: new Map(), pathMap, keepRule, folderPriority, 
        bitsCount: 144, hamThresh, withVariants: false 
      });
      
      if (emitGroupsCb) emitGroupsCb(groups);
      
      updateStats({
        groups: groups.length,
        files: allItems.length,
        totalBytes: allItems.reduce((s, f) => s + (Number(f.size || 0) || 0), 0),
        cacheHit: null,
        durationMs: nowMs() - start
      });
      
      showSpinner(false);
      setScanningState(false);
      setStatus(`Done. ${groups.length} exact duplicate group(s) found.`);
      setPhase("Complete");
      setProgress(100);
      return;
    }

    // Phase 2: Hash images
    setPhase("2/4 Hashing (download + compute)");
    let lastRateT = nowMs();
    let lastDone = 0;
    let errorCount = 0;

    const hashResult = await computeHashesWithDb(images, {
      useDb, 
      withVariants,
      withCropDetect,
      withColorMatch,
      withPHash,
      withRotation,
      concurrency: CONFIG.HASH_CONCURRENCY, 
      signal,
      onProgress: (done, total) => {
        if (signal?.aborted) return;
        
        const pct = 10 + (done / Math.max(1, total)) * 45;
        setProgress(pct);
        updateEta(pct);
        
        const now = nowMs();
        if (now - lastRateT > 800) {
          const rate = (done - lastDone) / ((now - lastRateT) / 1000);
          lastRateT = now;
          lastDone = done;
          const failedStr = errorCount > 0 ? ` (${errorCount} errors)` : "";
          setStatus(`Hashing… ${done}/${total} (${rate.toFixed(1)} img/s)${failedStr}`);
        }
      },
      onError: (errorInfo) => {
        errorCount++;
        console.warn(`Hash error: ${errorInfo.fileName}: ${errorInfo.error}`);
      }
    });

    const { idToEntry, cacheHit, errors: hashErrors = [] } = hashResult;
    hashingFailed = hashResult.hashingFailed || 0;
    
    setHashingErrors(hashErrors);
    
    if (hashingFailed > 0) {
      console.warn(`Hashing completed with ${hashingFailed} failures`);
    }

    setProgress(55);

    // Phase 3: Find matches PROGRESSIVELY
    setPhase("3/4 Finding matches");
    const idToFile = new Map(images.map(f => [f.id, f]));

    // Load the user's rejected-pairs set once so the matching loop can skip
    // them synchronously (the "ignore group" feature now actually persists).
    try { await preloadRejections(); } catch {}
    
    // Notify UI to prepare for progressive results
    if (onProgressiveMatch) {
      onProgressiveMatch({ type: 'start', total: idToEntry.size, idToEntry });
    }
    
    const matchResult = await findMatchesProgressively({
      idToEntry,
      idToFile,
      idToFileMeta: idToFile,
      hamThresh,
      withVariants,
      withCropDetect,
      withColorMatch,
      withPHash,
      useAspectFilter,
      aspectTolerancePct,
      lshModeEl,
      signal,
      onMatchFound: (match) => {
        // Stream each changed group to the live UI. Status text is updated once
        // per flush inside findMatchesProgressively, so we don't repeat it here.
        if (onProgressiveMatch) {
          onProgressiveMatch({ 
            type: 'match', 
            ...match 
          });
        }
      },
      onProgress: (current, total, matches, groups) => {
        const pct = 55 + (current / Math.max(1, total)) * 30;
        setProgress(pct);
        updateEta(pct);
      }
    });

    const { groups, comparisons, matches } = matchResult;
    
    console.log(`[DDD] Matching complete: ${comparisons} comparisons, ${matches} matches, ${groups.length} groups`);

    setProgress(85);
    setStatus(`Found ${groups.length} group(s) from ${matches} matches.`);

    // Phase 4: Build paths and final render
    setPhase("4/4 Building paths");
    // Only resolve folder paths for files that actually appear in results.
    // Previously this ran over ALL scanned images (allItems), making a Drive
    // API call per unique parent folder even for non-duplicate files — on a
    // large library that's thousands of needless requests. Paths are only shown
    // for grouped files, so restrict to those.
    const filesNeedingPaths = groups.flat();
    const pathMap = await buildPathsParallel(filesNeedingPaths, { 
      concurrency: CONFIG.PATH_CONCURRENCY, 
      signal, 
      onProgress: (d, t) => setStatus(`Building paths… ${d}/${t}`) 
    });

    setPhase("Rendering");
    await renderCb({ 
      groups, 
      idToEntry, 
      pathMap, 
      keepRule, 
      folderPriority, 
      bitsCount: dhashSize * dhashSize, 
      withVariants,
      withCropDetect,
      withColorMatch
    });
    
    if (emitGroupsCb) emitGroupsCb(groups);

    // Notify progressive rendering is complete
    if (onProgressiveMatch) {
      onProgressiveMatch({ type: 'complete', groups });
    }

    const durationMs = nowMs() - start;
    
    updateStats({
      groups: groups.length,
      files: images.length,
      totalBytes: images.reduce((s, f) => s + (Number(f.size || 0) || 0), 0),
      cacheHit,
      durationMs
    });

    // Feature #3: Update telemetry overlay
    try {
      const hashStats = getHashingStats();
      const rejStats = await getRejectionStats();
      updateTelemetry({ ...hashStats, md5Exact: md5ExactCount, rejectedPairs: rejStats.count });
    } catch {}

    await clearResumeState().catch(() => {});
    setProgress(100);
    setPhase("Complete");
    
    let statusMsg = `Done. ${groups.length} group(s), ${images.length} file(s) in ${humanDuration(durationMs)}.`;
    if (hashingFailed > 0) {
      statusMsg += ` (${hashingFailed} file(s) could not be hashed)`;
      showToast(`Scan complete with ${hashingFailed} errors.`, "info", 5000);
    }
    setStatus(statusMsg);

  } catch (e) {
    scanError = e;
    
    if (e.message === "Scan stopped.") {
      setStatus("Scan stopped by user.");
      setPhase("Stopped");
    } else {
      console.error("Scan failed:", e);
      
      let errorMsg = "Scan failed: ";
      if (e.message?.includes("401") || e.message?.includes("auth")) {
        errorMsg += "Authentication expired. Please sign out and sign in again.";
      } else if (e.message?.includes("403")) {
        errorMsg += "Access denied. Check folder permissions.";
      } else if (e.message?.includes("404")) {
        errorMsg += "Folder not found. It may have been deleted.";
      } else if (e.message?.includes("429")) {
        errorMsg += "Too many requests. Wait a few minutes and try again.";
      } else if (e.message?.includes("network") || e.name === "TypeError") {
        errorMsg += "Network error. Check your internet connection.";
      } else {
        errorMsg += e.message || "Unknown error";
      }
      
      setStatus(errorMsg);
      setPhase("Failed");
      showToast(errorMsg, "error", 8000);
    }
  } finally {
    showSpinner(false);
    setScanningState(false);
    clearPathCaches();
    
    // Update cache count after scan completes
    updateCacheCount().catch(e => console.warn("Cache count update failed:", e));
  }
}

// ============================================================================
// Scan Controls
// ============================================================================

export function wireScanControls({ onScan }) {
  const btnScan = el("btnScan");
  const btnStop = el("btnStop");
  
  let controller = null;

  if (btnScan) {
    btnScan.onclick = async () => {
      controller = new AbortController();
      btnScan.style.display = "none";
      if (btnStop) btnStop.style.display = "";
      
      await onScan(controller.signal);
      
      btnScan.style.display = "";
      if (btnStop) btnStop.style.display = "none";
      controller = null;
    };
  }

  if (btnStop) {
    btnStop.onclick = () => {
      if (controller) {
        controller.abort();
        setStatus("Stopping…");
      }
    };
  }
}

// ============================================================================
// Background Tab Detection
// ============================================================================

export function setupBackgroundDetection() {
  let wasHidden = false;
  
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      wasHidden = true;
      console.log('[DDD] Tab hidden');
    } else if (wasHidden) {
      wasHidden = false;
      console.log('[DDD] Tab visible - resuming');
      showToast("Tab restored", "info", 2000);
    }
  });
  
  console.log('[DDD] Background detection enabled');
}
