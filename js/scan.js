/*
 * Drive Dupe Destroyer (DDD) — scan.js
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
// Main scanning logic with PROGRESSIVE RESULTS
// v12.0: MD5 fast-path, AIMD throttle, resume, delta scan, aspect filter, pHash, LSH auto-tune, rejection filter

import { el, nowMs, humanDuration, CONFIG } from "./util.js";
import { validateFolderId, sanitizeText } from "./security.js";
import { setStatus, setPhase, setProgress, showSpinner, updateStats, setSearchSummary, showEmptyState, setScanningState, showToast, setHashingErrors, updateEta, resetEta, showCollectingSpinner } from "./ui.js";
import { driveFetch, fetchChangesSince, getChangesStartToken, isFolderMime } from "./drive.js";

import { ensureValidToken } from "./auth.js";
import { dbGetImagesBatch, dbPutImagesBatch, recordFoldersScan, dbCountImages, getChangesToken, setChangesToken, isQuotaError, onQuotaExceeded, pathCachePrune } from "./db.js";
import { computeHashesForFiles, getHashingStats, HASH_VERSION, HASH_CONCURRENCY } from "./hashing.js";
import { runMatching, packEntries } from "./matcher.js";
import { saveResumeState, clearResumeState } from "./resume.js";
import { getRejectionStats, preloadRejections, getRejectionKeys } from "./rejection.js";
import { updateTelemetry } from "./telemetry.js";
import { thresholdFromEasy, isSupportedImageFile, SUPPORTED_IMAGE_MIMES, getFileExtension, DEFAULT_KEEP_RULE, canBrowserDecode, SIMILARITY_BITS } from "./common.js";
import { buildPathsParallel, clearMemoryPathCaches } from "./paths.js";

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

/**
 * Escape a Drive folder ID for interpolation into a `q` expression.
 *
 * Drive IDs are [-\w] in practice, but the ID reaches here from API responses
 * and from the folder picker, and a stray quote would silently corrupt the
 * query rather than fail loudly. validateFolderId was imported by drive.js and
 * never called, while three files carried a header comment claiming "all
 * file/folder IDs validated before API calls".
 */
function quoteFolderId(folderId) {
  const id = String(folderId ?? "");
  if (!validateFolderId(id)) {
    throw new Error(`Refusing to query with a malformed folder ID: ${sanitizeText(id.slice(0, 64))}`);
  }
  return id;
}

function buildQuery(folderId) {
  const extra = NON_IMAGE_MIME_QUERIES ? ` or ${NON_IMAGE_MIME_QUERIES}` : '';
  return `'${quoteFolderId(folderId)}' in parents and trashed = false and (mimeType contains 'image/'${extra})`;
}

/**
 * One request per folder page, returning both images and subfolders.
 *
 * The recursive walk previously issued two list calls per folder — one filtered
 * to images, one filtered to folders — doubling request count against a
 * per-user rate limit the app already has to back off from. A single unfiltered
 * query returns both and the split is free client-side, since isFolderMime and
 * isSupportedImageFile already exist. It costs a little more JSON per page and
 * saves half the round-trips; requests are the constrained resource here.
 */
async function listFolderContents(folderId, pageSize, signal) {
  const images = [];
  const subfolders = [];
  let token = null;

  do {
    if (signal?.aborted) throw new Error("Scan stopped.");
    await ensureValidToken();

    const res = await driveFetch("files", {
      params: {
        q: `'${quoteFolderId(folderId)}' in parents and trashed = false`,
        fields: FIELDS,
        pageSize: String(pageSize),
        pageToken: token || undefined,
        orderBy: "folder,name"
      },
      signal
    });

    for (const f of (res.files || [])) {
      if (isFolderMime(f.mimeType)) subfolders.push(f);
      else if (isSupportedImageFile(f)) images.push(f);
    }
    token = res.nextPageToken || null;
  } while (token);

  return { images, subfolders };
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


// ============================================================================
// File Collection
// ============================================================================

async function fetchAllImagesRecursive({ folderIds, exclusions, maxItems, pageSize, signal, onStatus, resume = null, onCheckpoint = null }) {
  // Resuming means picking up the BFS frontier where it stopped: the folders
  // already walked stay walked, and the queue restarts from what was still
  // pending. Previously the resume state recorded neither, so "Resume" ran a
  // full rescan from the selected roots.
  // `visited` is the BFS dedup set and is seeded with the exclusions so the walk
  // skips them. `walked` is the folders we actually listed — the two must not be
  // conflated: returning `visited` as "visitedFolderIds" meant the delta scan's
  // containment check treated EXCLUDED folders as in-scope, and only a separate
  // excludedSet guard happening to run first kept that from leaking files back
  // in. Track them apart so the guarantee does not depend on statement order.
  const visited = new Set(exclusions);
  const walked = new Set();
  const allFiles = resume?.files ? [...resume.files] : [];
  if (resume?.visitedFolderIds) {
    for (const id of resume.visitedFolderIds) { visited.add(id); walked.add(id); }
  }
  const queue = resume?.pendingFolderIds?.length ? [...resume.pendingFolderIds] : [...folderIds];
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
    walked.add(folderId);
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
      const { images, subfolders } = await listFolderContents(folderId, pageSize, signal);

      for (const img of images) {
        if (maxItems > 0 && allFiles.length >= maxItems) break;
        allFiles.push(img);
      }

      totalSubfoldersFound += subfolders.length;
      for (const sub of subfolders) {
        if (!visited.has(sub.id)) queue.push(sub.id);
      }

      // Checkpoint the frontier, not just a count. Writing this once at the end
      // of collection (as before) was useless: a crash during the long phase
      // had nothing to resume from.
      if (onCheckpoint && foldersScanned % 25 === 0) {
        onCheckpoint({ files: allFiles, visitedFolderIds: Array.from(walked), pendingFolderIds: [...queue] });
      }
    } catch (e) {
      if (signal?.aborted || e.message === "Scan stopped.") throw e;
      console.warn(`Error scanning folder ${folderId}:`, e.message);
    }
  }

  if (onStatus) onStatus(`Collection complete: ${allFiles.length} images in ${foldersScanned} folders (${totalSubfoldersFound} subfolders traversed)`);
  console.log(`[DDD] Recursive scan: ${foldersScanned} folders scanned, ${totalSubfoldersFound} subfolders discovered, ${allFiles.length} images found`);
  // `walked`, not `visited`: only folders we actually listed. The delta scan
  // uses this to decide whether a changed file lies inside the user's selection,
  // and the resume state uses it to describe what was covered.
  return { files: allFiles, visitedFolderIds: walked };
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

  return { files: allFiles, visitedFolderIds: new Set(folderIds.filter(id => !excludedSet.has(id))) };
}

// ============================================================================
// Hash Computation with DB Cache
// ============================================================================

/**
 * Whether a cached record is unusable for THIS run and the file must be hashed
 * again. Every optional hash is computed only when its feature is on, so a
 * record cached with the feature off is a miss once it is turned on -- that is
 * what makes enabling crop, colour or pHash matching on an already-scanned
 * library actually do something (#84).
 */
export function cacheRecordNeedsRecompute(rec, { withVariants = false, withRotation = false, withCropDetect = false, withColorMatch = false, withPHash = false } = {}) {
  if (!rec?.base12) return true;
  // Variants are two flips plus three rotations, each requested separately. A
  // record cached by a run that wanted neither -- or wanted only the flips --
  // cannot serve a run that wants more, and nothing used to notice (#88).
  const wantVariants = (withVariants ? 2 : 0) + (withRotation ? 3 : 0);
  if (wantVariants > 0 && (rec.variants?.length || 0) < wantVariants) return true;
  if (withCropDetect && !rec.cropHashes) return true;
  // Crop detection needs the histograms too: they are the only way a crop of an
  // image is ever offered as a candidate, since it shares no dHash bands with
  // the original (#86). A record cached by a colour-less run is a miss.
  if ((withColorMatch || withCropDetect) && (!rec.colorHist || !rec.edgeHist)) return true;
  if (withPHash && !rec.pHashBits) return true;
  // Records written before the current hashing scheme are not comparable with
  // freshly computed ones. Treating them as misses is cheaper than wiping the
  // whole cache, and it self-heals as files are rescanned.
  if ((rec.hv || 1) !== HASH_VERSION) return true;
  return false;
}

/**
 * Rebuild a hash entry from a cached record.
 *
 * Every optional field the matcher can read must be restored here. pHashBits
 * was written on every save since the feature shipped and never once read back,
 * so a cache hit silently downgraded the file to dHash-only (#84).
 */
export function entryFromCacheRecord(rec) {
  return {
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
    edgeHist: rec.edgeHist ? new Uint8Array(rec.edgeHist) : null,
    pHashBits: rec.pHashBits ? new Uint8Array(rec.pHashBits) : null
  };
}

async function computeHashesWithDb(images, { 
  useDb = true, 
  withVariants = false,
  withCropDetect = false,
  withColorMatch = false,
  withPHash = false,
  withRotation = false,
  concurrency = HASH_CONCURRENCY, 
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
        if (cacheRecordNeedsRecompute(rec, { withVariants, withRotation, withCropDetect, withColorMatch, withPHash })) {
          toCompute.push(f);
        } else {
          cacheHits++;
          idToEntry.set(f.id, entryFromCacheRecord(rec));
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
      // Crop detection needs the colour and edge histograms to find a candidate
      // at all (#86). Nearly free here: hashing.js already skips the thumbnail
      // fast path when crop detection is on, so the bitmap is decoded at full
      // size either way and this is one more pass over it.
      withColorMatch: withColorMatch || withCropDetect,
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
            hv: HASH_VERSION,
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
        .catch(e => {
          // A full cache is a user-visible condition, not a console footnote:
          // scans stop getting faster and nothing said why.
          if (isQuotaError(e)) onQuotaExceeded(msg => showToast(msg, "error", 8000));
          else console.warn("Batch save failed:", e);
        });
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
/**
 * Run the pair matching, off the UI thread when the browser allows it.
 *
 * The matching itself lives in matcher.js and is untouched by which path runs
 * it: the worker imports that module, and so does the fallback here. Two
 * implementations that agree today would drift; one module cannot.
 *
 * The worker never sees a Drive file object. It receives hashes and metadata
 * keyed by id and returns group membership as arrays of ids, which this
 * function maps back to files. Shipping thousands of file records across the
 * boundary to have them handed straight back would cost more than the matching
 * it is meant to speed up.
 */
/**
 * Resolve folder paths for groups as they stream out of the matcher.
 *
 * Batches rather than resolving per group: matches arrive in bursts, and
 * buildPathsParallel is at its most efficient given many files at once (it
 * fetches a whole ancestor level per request). A short debounce collects a
 * burst; the queue drains one batch at a time so two runs never overlap.
 *
 * Every failure here is swallowed. This is an optimisation of WHEN the paths
 * arrive, not whether -- phase 4 resolves them regardless, so a failed live
 * batch costs nothing but the earlier keeper.
 */
export function makeLivePathResolver({ signal, onResolved, debounceMs = 400, build = buildPathsParallel } = {}) {
  if (typeof onResolved !== "function") {
    return { enqueue() {}, stop() {} };
  }

  const pending = new Map();      // id -> file, deduped across re-emitted groups
  const done = new Set();
  let timer = null;
  let running = false;
  let stopped = false;

  const flush = async () => {
    timer = null;
    if (stopped || running || pending.size === 0) return;
    running = true;
    const batch = [...pending.values()];
    pending.clear();
    try {
      const map = await build(batch, {
        concurrency: CONFIG.PATH_CONCURRENCY,
        signal,
      });
      if (!stopped && map?.size) onResolved([...map]);
    } catch {
      // Phase 4 will resolve these anyway.
    } finally {
      running = false;
      if (!stopped && pending.size > 0) schedule();
    }
  };

  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = setTimeout(flush, debounceMs);
  };

  return {
    enqueue(files) {
      if (stopped) return;
      for (const f of files) {
        if (f?.id && !done.has(f.id)) { done.add(f.id); pending.set(f.id, f); }
      }
      if (pending.size > 0) schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
  };
}

async function findMatchesProgressively({
  idToEntry,
  idToFile,
  idToFileMeta,
  exactGroups = [],
  hamThresh,
  withVariants,
  withRotation,
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
  const allIds = Array.from(idToFile.keys());
  const toFiles = (ids) => ids.map(id => idToFile.get(id)).filter(Boolean);

  const options = {
    allIds,
    exactGroupIds: exactGroups.map(g => g.map(f => f.id)),
    hamThresh,
    // Rotation hashes are stored as variants, and bestDist returns before it
    // looks at variants unless this is on. Ticking "Rotation variants" alone
    // therefore cost four times the hashing work and changed nothing (#88).
    withVariants: withVariants || withRotation,
    withCropDetect,
    withColorMatch,
    withPHash,
    useAspectFilter,
    aspectTolerancePct,
    lshForceMode: lshModeEl || "auto",
    emitInterval: MATCH_EMIT_INTERVAL,
    rejectedKeys: getRejectionKeys(),
  };

  // Shared by both paths so the UI cannot tell them apart.
  // The matcher emits one batch per flush; the live view still wants one call
  // per group, so unpack here rather than making every consumer batch-aware.
  const handleGroups = (info) => {
    if (!onMatchFound) return;
    for (const item of info.batch || []) {
      const group = toFiles(item.group || []);
      if (group.length > 1) {
        onMatchFound({ group, root: item.root, totalMatches: info.totalMatches, totalGroups: info.totalGroups });
      }
    }
  };
  const handleStatus = ({ groups, matches }) =>
    setStatus(`Finding matches… ${groups} groups (${matches} pairs)`);

  const finish = (result) => ({
    groups: result.groups.map(toFiles).filter(g => g.length > 1),
    comparisons: result.comparisons,
    matches: result.matches,
  });

  const worker = createMatchWorker();
  if (worker) {
    try {
      const { payload: packed, transfer } = packEntries(idToEntry);
      return finish(await runMatchingInWorker(worker, {
        packed,
        // Only the aspect pre-filter reads metadata, and only the two
        // dimensions, so send those rather than whole Drive records.
        meta: (idToFileMeta && options.useAspectFilter)
          ? [...idToFileMeta].map(([id, f]) => [id, { imageMediaMetadata: f?.imageMediaMetadata }])
          : null,
        ...options,
      }, { signal, transfer, onGroups: handleGroups, onStatus: handleStatus, onProgress }));
    } catch (e) {
      if (signal?.aborted || /Scan stopped/.test(e?.message || "")) throw e;
      console.warn("[DDD] Match worker failed, matching on the main thread:", e?.message);
    } finally {
      worker.terminate();
    }
  }

  // Fallback: the same module, on this thread, yielding so the page stays
  // usable — which is what the whole app did before #69.
  return finish(await runMatching({
    entries: idToEntry,
    meta: idToFileMeta,
    ...options,
    shouldStop: () => signal?.aborted === true,
    onGroups: handleGroups,
    onStatus: handleStatus,
    onProgress,
    yieldFn: yieldToUI,
    log: (...a) => console.log(...a),
  }));
}

function createMatchWorker() {
  try {
    return new Worker(new URL("./worker-match.js", import.meta.url), { type: "module" });
  } catch (e) {
    console.warn("[DDD] Could not start the match worker:", e?.message);
    return null;
  }
}

function runMatchingInWorker(worker, payload, { signal, transfer, onGroups, onStatus, onProgress }) {
  return new Promise((resolve, reject) => {
    const onAbort = () => worker.postMessage({ type: "stop" });
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);

    worker.onmessage = (ev) => {
      const m = ev.data || {};
      switch (m.type) {
        case "groups":   onGroups?.(m); break;
        case "status":   onStatus?.(m); break;
        case "progress": onProgress?.(m.done, m.total, m.matches, m.groups); break;
        case "done":     cleanup(); resolve(m); break;
        case "error":    cleanup(); reject(new Error(m.message)); break;
      }
    };
    worker.onerror = (e) => { cleanup(); reject(new Error(e?.message || "match worker error")); };

    // Transfer the hash buffers rather than copying them.
    worker.postMessage({ type: "run", payload }, transfer || []);
  });
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
  emitGroupsCb,
  resume = null       // Saved collection frontier from an interrupted scan
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
    const keepRule = el("keepRule")?.value || DEFAULT_KEEP_RULE;
    const folderPriority = el("folderPriority")?.value || "";
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
    
    if (resume) {
      setStatus(`Resuming: ${resume.files?.length || 0} image(s) already collected, ${resume.pendingFolderIds?.length || 0} folder(s) left…`);
      console.log(`[DDD] Resuming collection from ${resume.pendingFolderIds?.length || 0} pending folder(s)`);
    }

    const fetcher = recursive ? fetchAllImagesRecursive : fetchAllImagesFlat;
    const collected = await fetcher({
      folderIds,
      exclusions,
      maxItems,
      pageSize,
      signal,
      onStatus: setStatus,
      resume: recursive ? resume : null,
      // Checkpoint through the collection phase so an interruption has
      // something to resume from. Fire-and-forget: a failed write must not
      // stall the walk.
      onCheckpoint: (state) => {
        saveResumeState({
          folderIds,
          exclusions: exclusions instanceof Set ? Array.from(exclusions) : (exclusions || []),
          visitedFolderIds: state.visitedFolderIds,
          pendingFolderIds: state.pendingFolderIds,
          files: state.files,
          totalImagesFound: state.files.length,
          options: { recursive, maxItems, pageSize, withVariants, withCropDetect, withColorMatch, withPHash, withRotation }
        }).catch(() => {});
      }
    });
    let allItems = collected.files;
    const visitedFolderIds = collected.visitedFolderIds;
    
    if (signal?.aborted) throw new Error("Scan stopped.");

    // Feature #4: Save resume state after collection so a crash can resume
    try {
      await saveResumeState({
        folderIds,
        exclusions: exclusions instanceof Set ? Array.from(exclusions) : (exclusions || []),
        visitedFolderIds: Array.from(visitedFolderIds),
        pendingFolderIds: [],
        files: allItems,
        totalImagesFound: allItems.length,
        options: { recursive, maxItems, pageSize, withVariants, withCropDetect, withColorMatch, withPHash, withRotation }
      });
    } catch {}

    // One predicate, applied everywhere a file can enter the scan set. It used
    // to be inlined here only, so delta-added files below bypassed the size
    // limits and the Image Types selection entirely.
    const passesFilters = (f) => {
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
    };

    images = allItems.filter(passesFilters);

    setStatus(`Found ${images.length} image(s).`);
    setProgress(10);
    showCollectingSpinner(false);

    // MD5 exact-duplicate fast path.
    //
    // Drive hands us md5Checksum in the file listing for free, so byte-identical
    // files are provably duplicates before we download anything. This used to
    // compute the groups, log them, and throw them away: every exact duplicate
    // was still downloaded and perceptually hashed, and a pair that failed to
    // decode (PSD, RAW, TIFF outside Safari) was never grouped at all even
    // though its checksum proved the match.
    //
    // Now the groups are (a) seeded into the union-find so they appear in
    // results regardless of hashing, and (b) used to skip redundant work: only
    // one representative per checksum is hashed, since the rest are the same
    // bytes and cannot differ perceptually.
    const md5Groups = new Map();
    for (const f of images) {
      if (f.md5Checksum) {
        const key = f.md5Checksum;
        if (!md5Groups.has(key)) md5Groups.set(key, []);
        md5Groups.get(key).push(f);
      }
    }
    const exactDupeGroups = Array.from(md5Groups.values()).filter(g => g.length > 1);
    const md5ExactCount = exactDupeGroups.reduce((s, g) => s + g.length, 0);

    // Everything after the first file in each checksum group is redundant work.
    const md5Redundant = new Set();
    for (const g of exactDupeGroups) {
      for (let i = 1; i < g.length; i++) md5Redundant.add(g[i].id);
    }

    if (exactDupeGroups.length > 0) {
      setStatus(
        `Found ${exactDupeGroups.length} exact duplicate group(s) via MD5 ` +
        `(${md5ExactCount} files, skipping ${md5Redundant.size} redundant download(s))…`
      );
      console.log(
        `[DDD] MD5 fast-path: ${exactDupeGroups.length} groups, ${md5ExactCount} exact dupes, ` +
        `${md5Redundant.size} downloads avoided`
      );
    }

    // Reconcile against the Changes API.
    //
    // This does NOT "fetch only files changed since last scan", which is what
    // the comment here used to claim and what "delta scan" implies. By the time
    // it runs, `images` has already been fully populated by paginating
    // files.list across every selected folder -- the expensive network pass is
    // done. What this adds is correctness at the edges: files created since the
    // enumeration began, and files trashed elsewhere that the listing still
    // returned.
    //
    // A real incremental scan -- skipping the enumeration entirely when a stored
    // token and an unchanged folder selection say nothing relevant moved --
    // needs the previous file list persisted alongside the token, and
    // invalidated whenever the selection, recursion setting or filters change.
    // That is tracked separately; see #67. Nothing here should be read as
    // saving a round trip today.
    let deltaRemovedIds = new Set();
    if (useChangesApi && !quickScan) {
      try {
        const savedToken = await getChangesToken();
        if (savedToken) {
          setStatus("Fetching changes since last scan…");
          const { files: changed, nextToken } = await fetchChangesSince(savedToken, { signal });
          const removedIds = changed.filter(f => f._removed).map(f => f.id);
          deltaRemovedIds = new Set(removedIds);
          // The Changes API reports changes across the ENTIRE Drive, not just
          // the selected folders. Without a containment check this pulled in
          // images from anywhere -- including folders the user had explicitly
          // excluded -- and presented them as delete candidates.
          const excludedSet = exclusions instanceof Set ? exclusions : new Set(exclusions || []);
          const inScope = (f) => {
            const parent = f.parents?.[0];
            if (!parent) return false;
            if (excludedSet.has(parent)) return false;
            return visitedFolderIds.has(parent);
          };

          const existingIds = new Set(images.map(f => f.id));
          let added = 0, outOfScope = 0, filteredOut = 0;

          for (const cf of changed.filter(f => f._changed)) {
            if (existingIds.has(cf.id)) continue;
            if (!inScope(cf)) { outOfScope++; continue; }
            // Same size/format rules as the main collection path.
            if (!passesFilters(cf)) { filteredOut++; continue; }
            images.push(cf);
            added++;
          }

          if (outOfScope || filteredOut) {
            console.log(
              `[DDD] Delta scan: ignored ${outOfScope} change(s) outside the selected folders ` +
              `and ${filteredOut} that did not pass the size/type filters.`
            );
          }
          // Remove deleted files
          images = images.filter(f => !deltaRemovedIds.has(f.id));
          if (nextToken) await setChangesToken(nextToken);
          setStatus(`Delta scan: ${changed.length} change(s), ${added} added, ${removedIds.length} removed, ${images.length} image(s) to process`);
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
        bitsCount: SIMILARITY_BITS, hamThresh, withVariants: false 
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

    // Skip the redundant members of each MD5 group; they are byte-identical to a
    // file we are already hashing, so their perceptual hash is knowable without
    // the download.
    // Also skip formats no browser can turn into pixels. They are still in the
    // scan -- MD5 groups them above -- but downloading a 300 MB layered PSD to
    // watch createImageBitmap reject it helps nobody.
    const undecodable = [];
    const imagesToHash = images.filter(f => {
      if (md5Redundant.has(f.id)) return false;
      if (!canBrowserDecode(f)) { undecodable.push(f); return false; }
      return true;
    });

    if (undecodable.length > 0) {
      console.log(
        `[DDD] ${undecodable.length} file(s) in formats this browser cannot decode — ` +
        `matched by checksum only, not downloaded.`
      );
    }

    const hashResult = await computeHashesWithDb(imagesToHash, {
      useDb, 
      withVariants,
      withCropDetect,
      withColorMatch,
      withPHash,
      withRotation,
      concurrency: HASH_CONCURRENCY, 
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

    // Resolve folder paths for live groups while matching runs.
    //
    // This costs nothing overall: matching is CPU-bound and runs after hashing,
    // so the network is idle exactly when live groups appear, and
    // buildPathsParallel memoises within a scan (and persists between them
    // since #79) -- so phase 4 below finds the work already done rather than
    // repeating it. The same requests, moved earlier and overlapped.
    // Reported through the same channel as live matches, so there is one
    // progressive callback rather than two.
    const livePaths = makeLivePathResolver({
      signal,
      onResolved: onProgressiveMatch ? (entries) => onProgressiveMatch({ type: 'paths', entries }) : null,
    });
    
    const matchResult = await findMatchesProgressively({
      idToEntry,
      idToFile,
      idToFileMeta: idToFile,
      exactGroups: exactDupeGroups,
      hamThresh,
      withVariants,
      withRotation,
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
        // Start resolving this group's folder paths now rather than waiting for
        // phase 4. The folder-priority keep rule ranks on the resolved path, so
        // until it arrives the live table nominates a keeper by tie-break and
        // then silently changes its mind when the scan ends (#91).
        if (Array.isArray(match?.group)) livePaths.enqueue(match.group);
      },
      onProgress: (current, total, matches, groups) => {
        const pct = 55 + (current / Math.max(1, total)) * 30;
        setProgress(pct);
        updateEta(pct);
      }
    });

    livePaths.stop();

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
      bitsCount: SIMILARITY_BITS,
      withVariants: withVariants || withRotation,
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
      
      // Classify on the status the fetch layer attached, not on substrings of
      // the message. Matching "403" anywhere in a Drive error body is fragile,
      // and `e.name === "TypeError"` matched every ordinary programming error
      // in the codebase — a genuine "x is not a function" was reported to the
      // user as "Network error. Check your internet connection.", sending them
      // to check a connection that was fine while the real stack trace stayed
      // in the console.
      let errorMsg = "Scan failed: ";
      const status = e?.status;

      if (status === 401 || e?.code === "AUTH") {
        errorMsg += "Authentication expired. Please sign out and sign in again.";
      } else if (status === 403) {
        errorMsg += "Access denied. Check folder permissions.";
      } else if (status === 404) {
        errorMsg += "Folder not found. It may have been deleted.";
      } else if (status === 429) {
        errorMsg += "Too many requests. Wait a few minutes and try again.";
      } else if (status >= 500) {
        errorMsg += `Google Drive returned a server error (${status}). Try again shortly.`;
      } else if (e?.code === "NETWORK") {
        errorMsg += "Network error. Check your internet connection.";
      } else {
        // Anything unclassified is most likely a bug. Show the real message
        // rather than dressing it up as something the user can act on.
        errorMsg += e?.message || "Unknown error";
      }
      
      setStatus(errorMsg);
      setPhase("Failed");
      showToast(errorMsg, "error", 8000);
    }
  } finally {
    showSpinner(false);
    setScanningState(false);
    // Drop the per-scan memo, KEEP the durable rows. This used to call
    // clearPathCaches(), which also empties the IndexedDB store -- so every path
    // resolved during a scan was deleted the moment it ended and the cache never
    // served a single request (#79). Staleness is handled by age below, which is
    // what the ts index has been there for since v1.
    clearMemoryPathCaches();
    pathCachePrune().catch(() => {});
    
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
