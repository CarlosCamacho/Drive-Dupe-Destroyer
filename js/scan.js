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
import { dbGetImagesBatch, dbPutImagesBatch, recordFoldersScan, dbCountImages, getChangesToken, setChangesToken, isQuotaError, onQuotaExceeded } from "./db.js";
import { computeHashesForFiles, getHashingStats, HASH_VERSION, HASH_CONCURRENCY } from "./hashing.js";
import { saveResumeState, clearResumeState } from "./resume.js";
import { getRejectionStats, preloadRejections, isRejectedPairSync } from "./rejection.js";
import { updateTelemetry } from "./telemetry.js";
import { bestDist, bestDistExtended, bestDistWithPHash, thresholdFromEasy, isSupportedImageFile, aspectRatioCompatible, SUPPORTED_IMAGE_MIMES, getFileExtension, DEFAULT_KEEP_RULE, canBrowserDecode } from "./common.js";
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
        if (rec?.base12) {
          // If crop/color detection was requested but not in cache, need to recompute
          const needsCrop = withCropDetect && !rec.cropHashes;
          const needsColor = withColorMatch && (!rec.colorHist || !rec.edgeHist);
          // Records written before the current hashing scheme are not comparable
          // with freshly computed ones, so treat them as misses. Cheaper than
          // wiping the whole cache, and it self-heals as files are rescanned.
          const staleHash = (rec.hv || 1) !== HASH_VERSION;

          if (needsCrop || needsColor || staleHash) {
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
async function findMatchesProgressively({
  idToEntry,
  idToFile,
  idToFileMeta,
  exactGroups = [],
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

  // Seed byte-identical files before any perceptual comparison. This is what
  // makes the MD5 fast path real: these files are grouped whether or not they
  // could be hashed, so PSD/RAW/TIFF duplicates -- which no browser can decode
  // -- now appear in results instead of only in the hashing-errors list.
  let seededPairs = 0;
  for (const group of exactGroups) {
    for (let i = 1; i < group.length; i++) {
      uf.union(group[0].id, group[i].id);
      seededPairs++;
    }
  }
  if (seededPairs > 0) console.log(`[DDD] Seeded ${seededPairs} exact-duplicate pair(s) from MD5`);

  const lshForceMode = typeof lshModeEl !== 'undefined' ? (lshModeEl || 'auto') : 'auto';
  const index = buildAutoTunedLshIndex(idToEntry, { use12: true, targetThreshold: hamThresh, forceMode: lshForceMode });
  
  // Log LSH stats
  const stats = lshStats(index);
  console.log(`[DDD] LSH Index Stats:`, stats);
  if (withCropDetect) console.log(`[DDD] Crop detection enabled`);
  if (withColorMatch) console.log(`[DDD] Color histogram matching enabled`);
  
  // `ids` are the files we compare pairwise -- only those with a hash.
  // `allIds` is every file that can appear in a result group, which includes
  // MD5-seeded members that were deliberately never hashed.
  const ids = Array.from(idToEntry.keys());
  const idIndex = new Map(ids.map((id, idx) => [id, idx]));
  const allIds = Array.from(idToFile.keys());
  
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
      for (let gi = 0; gi < allIds.length; gi++) {
        const gid = allIds[gi];
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
  
  // Colour/edge candidate widening for crop detection.
  //
  // What this replaces: a scan of up to 2,000 array neighbours in EACH direction
  // -- 4,000 comparisons per image, 14 histogram reads each, on the main thread.
  // That was both expensive and arbitrary: the window was over POSITION IN
  // `ids`, whose order comes from Map iteration and has nothing to do with
  // similarity, so two crops of the same photo 3,000 apart were never compared
  // while 4,000 unrelated images were.
  //
  // The pre-filter accepts a pair only when sum|a[b] - b[b]| over bins 24..31 is
  // under 200, and
  //     |lum(a) - lum(b)|  <=  sum|a[b] - b[b]|
  // where lum is the sum of those bins. So sorting by lum puts every candidate
  // that could possibly pass into one CONTIGUOUS RUN around each image, and
  // walking outward until the luminance gap reaches 200 visits exactly the
  // plausible set and nothing else.
  //
  // A cap still applies, because a library of near-identical brightness is
  // genuinely quadratic and nothing can change that. The difference is what the
  // cap discards: the least plausible candidates (furthest in luminance) rather
  // than whichever ones happened to sit far away in a Map. See #65.
  //
  // Measured on 20,000 synthetic images, a bucket-index version of this was 2x
  // WORSE than the positional scan it replaced -- buckets over a scalar key grow
  // linearly with library size, so the total work is quadratic with no cap at
  // all. That is why this is a sorted run with a bound, not an index.
  const COLOR_LUM_LIMIT = 200;      // implied by the colorDiff < 200 pre-filter
  const COLOR_SCAN_CAP = 400;       // most candidates considered per image

  const lumOf = (e) => {
    if (!e?.colorHist) return null;
    let l = 0;
    for (let b = 24; b < 32; b++) l += e.colorHist[b];
    return l;
  };

  let lumSorted = null;             // [{ id, lum }] ascending, built only if needed
  let lumPos = null;                // id -> index in lumSorted
  if (withCropDetect && withColorMatch) {
    lumSorted = [];
    for (const cid2 of ids) {
      const e = idToEntry.get(cid2);
      const l = lumOf(e);
      if (l !== null && e?.edgeHist) lumSorted.push({ id: cid2, lum: l });
    }
    lumSorted.sort((x, y) => x.lum - y.lum);
    lumPos = new Map(lumSorted.map((x, idx) => [x.id, idx]));
  }

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
      // Widen the candidate set with images of similar colour and edge
      // structure, which a cropped copy shares even when its dHash bands differ.
      //
      // This used to scan up to 2,000 array neighbours in EACH direction --
      // 4,000 comparisons per image, each reading 14 histogram bins, on the main
      // thread. At 10,000 images that is ~40 million inner iterations, and it
      // bypassed the LSH index two lines above whose entire purpose is to avoid
      // exactly that scan.
      //
      // It was also wrong, not merely slow: the window was over POSITION IN
      // `ids`, whose order comes from Map iteration and has nothing to do with
      // similarity. Two crops of the same photo sitting 3,000 apart were never
      // compared, while 4,000 unrelated images were.
      //
      // colorBuckets indexes on the same coarse luminance signature the
      // pre-filter tests, so candidates come from images that could plausibly
      // pass it. See #65.
      const colorCandidates = new Set(candidates);
      const centre = lumPos?.get(id);
      if (centre !== undefined) {
        const myLum = lumSorted[centre].lum;
        let visited = 0;
        // Walk outward from this image's place in the luminance ordering,
        // alternating sides, so the cap trims the furthest candidates rather
        // than everything on one side.
        for (let step = 1; visited < COLOR_SCAN_CAP; step++) {
          const left = centre - step;
          const right = centre + step;
          const leftInRange = left >= 0 && myLum - lumSorted[left].lum < COLOR_LUM_LIMIT;
          const rightInRange = right < lumSorted.length && lumSorted[right].lum - myLum < COLOR_LUM_LIMIT;
          if (!leftInRange && !rightInRange) break;

          for (const side of [leftInRange ? left : -1, rightInRange ? right : -1]) {
            if (side < 0) continue;
            visited++;
            const otherId = lumSorted[side].id;
            const otherEntry = idToEntry.get(otherId);
            if (!otherEntry) continue;

            let colorDiff = 0;
            for (let b = 24; b < 32; b++) {
              colorDiff += Math.abs(entry.colorHist[b] - otherEntry.colorHist[b]);
            }
            if (colorDiff >= 200) continue;

            let edgeDiff = 0;
            for (let b = 0; b < 6; b++) {
              edgeDiff += Math.abs(entry.edgeHist[b] - otherEntry.edgeHist[b]);
            }
            if (edgeDiff < 300) colorCandidates.add(otherId);
          }
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
  
  // Mark every MD5-seeded root dirty so seeded groups reach the live view even
  // when no perceptual match ever touched them.
  for (const group of exactGroups) {
    if (group.length > 1) dirtyRoots.add(uf.find(group[0].id));
  }

  // Flush any groups changed in the final (partial) batch so the live view is
  // complete even if the scan ends mid-interval.
  flushDirty();
  
  // Final emission of all groups
  const finalGroups = [];
  const rootMap = new Map();

  // Walk every file, not just the hashed ones, so MD5-seeded members are not
  // dropped from the final result set.
  for (const id of allIds) {
    const f = idToFile.get(id);
    if (!f) continue;
    const root = uf.find(id);
    if (!rootMap.has(root)) rootMap.set(root, []);
    rootMap.get(root).push(f);
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
    
    const matchResult = await findMatchesProgressively({
      idToEntry,
      idToFile,
      idToFileMeta: idToFile,
      exactGroups: exactDupeGroups,
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
