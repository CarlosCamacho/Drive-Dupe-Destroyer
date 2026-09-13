/*
 * Drive Dupe Destroyer (DDD) — rejection.js
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
// False-positive feedback loop - Feature #19
// Stores rejected pairs by hash fingerprint so they persist across sessions.
// Also tracks session-level calibration data for weight tuning.

import {
  rejectionsAll, rejectionAdd, rejectionsClear, rejectionsTrim,
  migrateRejectionsFromSettings,
} from "./db.js";

const REJECTION_KEY = "destroyer_rejected_pairs_v1";
const MAX_REJECTIONS = 10000;

// In-memory cache loaded once per session
let rejectionSet = null;

async function ensureLoaded() {
  if (rejectionSet !== null) return;
  try {
    // Carry over anything stored under the old single-blob scheme.
    await migrateRejectionsFromSettings(REJECTION_KEY);
    rejectionSet = new Set(await rejectionsAll());
  } catch (e) {
    console.warn("[Rejection] Load failed:", e?.message || e);
    rejectionSet = new Set();
  }
}

/**
 * Create a canonical key from two hash fingerprints.
 * Order-independent: always smaller hash first.
 *
 * NOTE: keying on the hash rather than on file IDs has two consequences worth
 * knowing about. Changing the dHash size setting (8 vs 12) changes every hash,
 * so stored rejections stop matching and the user's "not a duplicate" feedback
 * appears to evaporate. And any OTHER pair with the same two hashes is also
 * suppressed — which is arguably the intent ("these two images look identical
 * and I said they differ"), but it is a consequence of the design, not an
 * accident.
 */
function pairKey(hashA, hashB) {
  const a = Array.from(hashA || []).join(",");
  const b = Array.from(hashB || []).join(",");
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Record a user rejection for a pair of entries.
 * entryA, entryB: hash entry objects with base12 property.
 */
export async function recordRejection(entryA, entryB) {
  await ensureLoaded();
  if (!entryA?.base12 || !entryB?.base12) return;

  const key = pairKey(entryA.base12, entryB.base12);
  if (rejectionSet.has(key)) return;
  rejectionSet.add(key);

  // One small row, rather than re-serializing the entire collection. This runs
  // every time the user presses "4" in the compare modal, so the old
  // whole-array rewrite (up to ~1 MB at the cap) was squarely on the hot path.
  await rejectionAdd(key).catch(e => console.warn("[Rejection] Save failed:", e?.message || e));

  if (rejectionSet.size > MAX_REJECTIONS) {
    const removed = await rejectionsTrim(MAX_REJECTIONS).catch(() => 0);
    if (removed > 0) rejectionSet = new Set(await rejectionsAll().catch(() => []));
  }
}

/**
 * Preload the rejection set so the synchronous check below can be used inside
 * the hot matching loop without awaiting per pair. Call once before matching.
 */
export async function preloadRejections() {
  await ensureLoaded();
  return rejectionSet.size;
}

/**
 * Cheap per-entry hash fingerprint, memoized on the entry so the expensive
 * Array.from(...).join(',') runs at most once per entry rather than once per
 * comparison. Used only for rejection-set lookups.
 */
function entryHashStr(entry) {
  if (entry._rejKey !== undefined) return entry._rejKey;
  const h = entry.base12;
  const s = h ? Array.from(h).join(",") : null;
  try { Object.defineProperty(entry, "_rejKey", { value: s, enumerable: false, writable: true, configurable: true }); }
  catch { /* frozen entry: fall through */ }
  return s;
}

/**
 * Synchronous pair-rejection check. Requires preloadRejections() to have been
 * awaited first. Safe to call in tight loops (no async/await overhead).
 * Returns false if the set isn't loaded yet (fail-open: don't hide matches).
 */
export function isRejectedPairSync(entryA, entryB) {
  if (rejectionSet === null || rejectionSet.size === 0) return false;
  const a = entryHashStr(entryA);
  const b = entryHashStr(entryB);
  if (!a || !b) return false;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  return rejectionSet.has(key);
}

/**
 * Check if a pair has been rejected before.
 */
export async function isRejectedPair(entryA, entryB) {
  await ensureLoaded();
  if (!entryA?.base12 || !entryB?.base12) return false;
  return rejectionSet.has(pairKey(entryA.base12, entryB.base12));
}

/**
 * Filter a group array to remove files whose pair has been rejected.
 * Returns the filtered group (may be length 1 if all pairs rejected).
 */
export async function filterRejectedPairs(group, idToEntry) {
  if (!group || group.length < 2) return group;
  await ensureLoaded();
  if (rejectionSet.size === 0) return group;
  // Keep a file only if at least one non-rejected partner exists
  const keep = [];
  for (let i = 0; i < group.length; i++) {
    let hasPartner = false;
    const eA = idToEntry?.get(group[i].id);
    for (let j = 0; j < group.length; j++) {
      if (i === j) continue;
      const eB = idToEntry?.get(group[j].id);
      if (!eA || !eB || !rejectionSet.has(pairKey(eA.base12, eB.base12))) {
        hasPartner = true;
        break;
      }
    }
    if (hasPartner) keep.push(group[i]);
  }
  return keep.length >= 2 ? keep : group; // never shrink below 2 to preserve group integrity
}

/**
 * Get rejection stats for the telemetry panel.
 */
export async function getRejectionStats() {
  await ensureLoaded();
  return { count: rejectionSet.size };
}

export async function clearRejections() {
  rejectionSet = new Set();
  await rejectionsClear().catch(e => console.warn("[Rejection] Clear failed:", e?.message || e));
}
