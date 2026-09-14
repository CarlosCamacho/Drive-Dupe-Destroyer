/*
 * Drive Dupe Destroyer (DDD) — matcher.js
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
// The pair-matching core: LSH candidates, Hamming distances, union-find.
//
// Extracted from scan.js so it can run in a worker (#69). It previously ran on
// the UI thread, handing control back every 8ms — which kept the page usable but
// capped throughput and made matching compete with the thumbnail decoding and
// paint for the very results it was producing.
//
// Two rules keep this portable, and both matter:
//
//   1. NO DOM, NO UI. Status and progress leave through callbacks. There is no
//      `setStatus` here and there must never be one.
//   2. IDs ONLY — never Drive file objects. The worker receives hashes and
//      metadata and returns group membership as arrays of ids; the main thread
//      owns the file objects and maps ids back. Transferring thousands of Drive
//      file records into a worker to hand them straight back would cost more
//      than the matching it is meant to speed up.
//
// The same module runs in the worker and, unchanged, on the main thread when a
// worker cannot start. That is not only a fallback: it is what makes the two
// paths provably equivalent rather than merely similar, and test/matcher-parity
// runs both over the same input and compares the grouping.

import { makeUnionFind } from "./unionfind.js";
import { buildAutoTunedLshIndex, lshCandidates, lshStats } from "./lsh.js";
import { bestDist, bestDistExtended, bestDistWithPHash, aspectRatioCompatible } from "./common.js";

// The rejection set arrives as plain "hashA|hashB" keys so the worker needs no
// database access. Mirrors entryHashStr in rejection.js.
function entryHashKey(entry) {
  const h = entry?.base12;
  return h ? Array.from(h).join(",") : null;
}

function makeRejectionLookup(rejectedKeys) {
  const set = rejectedKeys instanceof Set ? rejectedKeys : new Set(rejectedKeys || []);
  if (set.size === 0) return () => false;
  return (a, b) => {
    const ka = entryHashKey(a), kb = entryHashKey(b);
    if (!ka || !kb) return false;
    return set.has(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
  };
}

// ---------------------------------------------------------------------------
// Payload packing
//
// Handing a worker 4,000 entry objects, each holding two typed arrays, costs
// more in structured-clone than the matching it is meant to offload: measured
// at 4,000 images, the naive transfer made the worker 7x SLOWER than the
// yielding main thread (587ms vs 82ms). The hashes are fixed-width, so they
// pack into two flat buffers that transfer with zero copy.
// ---------------------------------------------------------------------------

const B12 = 18;   // 144-bit dHash
const B8 = 8;     // 64-bit dHash

/**
 * Every entry field beyond the two base hashes that a comparator in common.js
 * reads. Packing and unpacking both drive off this list, so adding a field to
 * the hasher and forgetting the transport is one edit, not two.
 */
export const OPTIONAL_ENTRY_FIELDS = ["pHashBits", "cropHashes", "colorHist", "edgeHist", "variants"];

/**
 * Flatten entries into transferable buffers. Returns { payload, transfer }.
 *
 * Optional per-entry fields (pHashBits, cropHashes, histograms, variants) are
 * NOT packed into the flat buffers: they only exist when crop, colour or pHash
 * matching is on, and they are variable-width. Those runs carry them as
 * ordinary cloned objects, which is the honest trade — packing a rarely used
 * field would complicate the common path for nothing.
 *
 * But they MUST all ride along. This list is the entry as the comparators in
 * common.js see it, and anything missing from it is a matching feature that
 * silently does nothing: `pHashBits` was carried under the wrong name (#84),
 * and `cropHashes` was not carried at all (#86). OPTIONAL_ENTRY_FIELDS is the
 * single list both sides use, and test/phash-plumbing.test.js checks it against
 * what common.js actually reads.
 */
export function packEntries(entries) {
  const ids = [];
  const extras = [];
  let n = 0;
  for (const [, e] of entries) { if (e?.base12) n++; }

  const b12 = new Uint8Array(n * B12);
  const b8 = new Uint8Array(n * B8);
  let i = 0;
  for (const [id, e] of entries) {
    if (!e?.base12) continue;
    ids.push(id);
    b12.set(e.base12.subarray ? e.base12.subarray(0, B12) : e.base12.slice(0, B12), i * B12);
    if (e.base8) b8.set(e.base8.subarray ? e.base8.subarray(0, B8) : e.base8.slice(0, B8), i * B8);
    // Anything beyond the two base hashes rides along unpacked.
    let extra = null;
    for (const k of OPTIONAL_ENTRY_FIELDS) {
      if (e[k]) (extra ||= {})[k] = e[k];
    }
    if (extra) extras.push([id, extra]);
    i++;
  }
  return {
    payload: { ids, b12, b8, extras },
    transfer: [b12.buffer, b8.buffer],
  };
}

/** Rebuild the entry map inside the worker. */
export function unpackEntries({ ids, b12, b8, extras }) {
  const entries = new Map();
  const extraMap = new Map(extras || []);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const e = {
      base12: new Uint8Array(b12.buffer, b12.byteOffset + i * B12, B12),
      base8: new Uint8Array(b8.buffer, b8.byteOffset + i * B8, B8),
    };
    const x = extraMap.get(id);
    if (x) {
      for (const k of OPTIONAL_ENTRY_FIELDS) {
        if (x[k]) e[k] = x[k];
      }
    }
    entries.set(id, e);
  }
  return entries;
}

/**
 * Group near-identical images.
 *
 * `onGroups` receives arrays of IDS, not files. `shouldStop` is polled instead
 * of an AbortSignal so the worker can be told to stop over postMessage.
 * `yieldFn` is only supplied on the main-thread path; in a worker there is
 * nothing to yield to and passing one would be pure overhead.
 */
export async function runMatching({
  entries,
  meta = null,
  exactGroupIds = [],
  allIds = null,
  hamThresh,
  withVariants = false,
  withCropDetect = false,
  withColorMatch = false,
  withPHash = false,
  useAspectFilter = false,
  aspectTolerancePct = 20,
  lshForceMode = "auto",
  emitInterval = 25,
  rejectedKeys = null,
  onGroups = null,
  onProgress = null,
  onStatus = null,
  shouldStop = null,
  yieldFn = null,
  log = null,
} = {}) {

  const uf = makeUnionFind();
  const isRejected = makeRejectionLookup(rejectedKeys);

  // Seed byte-identical files before any perceptual comparison. This is what
  // makes the MD5 fast path real: these files are grouped whether or not they
  // could be hashed, so PSD/RAW/TIFF duplicates -- which no browser can decode
  // -- now appear in results instead of only in the hashing-errors list.
  let seededPairs = 0;
  for (const group of exactGroupIds) {
    for (let i = 1; i < group.length; i++) {
      uf.union(group[0], group[i]);
      seededPairs++;
    }
  }
  if (seededPairs > 0) if (log) log(`[DDD] Seeded ${seededPairs} exact-duplicate pair(s) from MD5`);

  
  const index = buildAutoTunedLshIndex(entries, { use12: true, targetThreshold: hamThresh, forceMode: lshForceMode });
  
  // Log LSH stats
  const stats = lshStats(index);
  if (log) log(`[DDD] LSH Index Stats:`, stats);
  if (withCropDetect) if (log) log(`[DDD] Crop detection enabled`);
  if (withColorMatch) if (log) log(`[DDD] Color histogram matching enabled`);
  
  // `ids` are the files we compare pairwise -- only those with a hash.
  // `allIds` is every file that can appear in a result group, which includes
  // MD5-seeded members that were deliberately never hashed.
  const ids = Array.from(entries.keys());
  const idIndex = new Map(ids.map((id, idx) => [id, idx]));
  const everyId = allIds ? Array.from(allIds) : Array.from(entries.keys());
  
  let comparisons = 0;
  let matches = 0;
  let lastYield = Date.now();
  let lastEmit = 0;
  let lastFlushAt = 0;
  const FLUSH_MIN_MS = 250;
  let sinceYieldCheck = 0;  // cheap counter to rate-limit the time-based yield check
  
  // Track which groups have been emitted
  const emittedGroups = new Map();  // root -> group array
  // Roots whose membership changed since the last flush. We throttle how often
  // we emit, but we must flush EVERY changed group — not just the most recent
  // one — or the live view silently drops groups formed between flushes.
  const dirtyRoots = new Set();

  // Flush all dirty groups to the UI, then clear the dirty set.
  const flushDirty = () => {
    if (onGroups && dirtyRoots.size > 0) {
      // Build root -> members in ONE pass over ids, rather than scanning all ids
      // once per dirty root (which was O(ids x dirtyRoots) every flush and ran on
      // the main thread). We only collect members for roots that are dirty.
      const membersByRoot = new Map();
      for (let gi = 0; gi < everyId.length; gi++) {
        const gid = everyId[gi];
        const root = uf.find(gid);
        if (!dirtyRoots.has(root)) continue;
        let arr = membersByRoot.get(root);
        if (!arr) { arr = []; membersByRoot.set(root, arr); }
        arr.push(gid);
      }
      // ONE call per flush carrying every changed group, not one call per
      // group. In a worker each call is a structured clone and an event
      // dispatch; measured at 12,000 images this was 13,930 separate messages.
      // The main-thread path benefits too -- the batch is what flushDirty
      // already computed.
      const batch = [];
      for (const root of dirtyRoots) {
        const group = membersByRoot.get(root);
        if (group && group.length > 1) {
          emittedGroups.set(root, group);
          batch.push({ group, root });
        }
      }
      if (batch.length) {
        onGroups({
          batch,
          totalMatches: matches,
          totalGroups: emittedGroups.size
        });
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
  // Built whenever crop detection is on -- it is the index the widening below
  // walks, and without it crop detection has no candidates to test (#86).
  if (withCropDetect) {
    lumSorted = [];
    for (const cid2 of ids) {
      const e = entries.get(cid2);
      const l = lumOf(e);
      if (l !== null && e?.edgeHist) lumSorted.push({ id: cid2, lum: l });
    }
    lumSorted.sort((x, y) => x.lum - y.lum);
    lumPos = new Map(lumSorted.map((x, idx) => [x.id, idx]));
  }

  for (let i = 0; i < ids.length; i++) {
    if (shouldStop && shouldStop()) throw new Error("Scan stopped.");
    
    const id = ids[i];
    const entry = entries.get(id);
    if (!entry?.base12) continue;
    
    const candidates = lshCandidates(index, id, entry);
    
    // When crop detection is on, we need broader candidate search
    // since cropped images may not share LSH bands.
    // Use combined color+edge similarity as additional candidates.
    let extendedCandidates = candidates;
    // Gated on withCropDetect alone, not on withColorMatch as well. A crop does
    // not share dHash bands with its original -- that is the premise of the
    // feature -- so without this widening the pair is never even compared, and
    // ticking "Crop detection" by itself did nothing whatsoever (#86). The
    // histograms are now computed whenever crop detection is on, so they are
    // here to be used. withColorMatch still decides whether a crop match is
    // VERIFIED against the histograms, in bestDistExtended.
    if (withCropDetect && entry.colorHist && entry.edgeHist) {
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
            const otherEntry = entries.get(otherId);
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
      
      const centry = entries.get(cid);
      if (!centry?.base12) continue;
      
      comparisons++;
      // Aspect ratio pre-filter (Feature #8) — free metadata check before Hamming
      if (useAspectFilter && meta) {
        const fA = meta.get(id);
        const fB = meta.get(cid);
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
        if (isRejected(entry, centry)) continue;

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
        // Flush on a TIME budget, not a match count.
        //
        // Every flush walks all ids to rebuild root -> members, because a union
        // can re-parent any of them. At 12,000 images a flush-every-25-matches
        // rule meant ~1,900 flushes x 12,000 ids: about 23 million find() calls,
        // which measured as the dominant cost of the whole matching phase --
        // far above the comparisons themselves or the messaging.
        //
        // Four updates a second is more than enough for a live view, and it
        // makes the flush cost proportional to elapsed time rather than to how
        // many matches the library happens to contain. The first match still
        // flushes immediately so something appears at once.
        const nowMs2 = Date.now();
        if (matches === 1 || (matches - lastEmit >= emitInterval && nowMs2 - lastFlushAt >= FLUSH_MIN_MS)) {
          lastFlushAt = nowMs2;
          flushDirty();
          // Keep status text in step with what the UI is showing.
          if (onStatus) onStatus({ groups: emittedGroups.size, matches });
        }
      }

      // Cooperative yield INSIDE the inner loop. The matching loop runs on the
      // main thread; if it holds the thread too long, clicks, image decoding and
      // paints all stall — that's what made the foreground feel dead during a
      // background scan. Checking time every few comparisons and handing the
      // thread back whenever we've held it >8ms keeps input/paint responsive,
      // even when a single item has thousands of candidates.
      // Only the main-thread fallback yields. In a worker there is nothing to
      // yield to, and the check itself would be the only cost.
      if (yieldFn && (++sinceYieldCheck & 0x3F) === 0) {
        const now = Date.now();
        if (now - lastYield > 8) {
          await yieldFn();
          lastYield = Date.now();
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
  for (const group of exactGroupIds) {
    if (group.length > 1) dirtyRoots.add(uf.find(group[0]));
  }

  // Flush any groups changed in the final (partial) batch so the live view is
  // complete even if the scan ends mid-interval.
  flushDirty();
  
  // Final emission of all groups
  const finalGroups = [];
  const rootMap = new Map();

  // Walk every id, not just the hashed ones, so MD5-seeded members are not
  // dropped from the final result set.
  for (const id of everyId) {
    const root = uf.find(id);
    if (!rootMap.has(root)) rootMap.set(root, []);
    rootMap.get(root).push(id);
  }
  
  for (const [root, group] of rootMap) {
    if (group.length > 1) {
      finalGroups.push(group);
    }
  }
  
  return { groups: finalGroups, comparisons, matches };
}
