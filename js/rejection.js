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
 * NOTE: keying on the hash rather than on file IDs means any OTHER pair with
 * the same two hashes is also suppressed — arguably the intent ("these two
 * images look identical and I said they differ"), but a consequence of the
 * design rather than an accident, and one the user cannot see. It is why
 * clearRejections is reachable from the telemetry panel (#101): a single
 * mis-press in the compare modal otherwise suppresses that pair in every future
 * scan, permanently.
 *
 * A warning about the dHash size setting used to sit here too. That setting was
 * removed in #89 -- it controlled nothing and only corrupted the similarity
 * percentage -- so the hashes no longer change under the user.
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
 * The rejection set as plain "hashA|hashB" keys.
 *
 * The matcher runs in a worker (#69), which has no database access and must not
 * grow one. Handing it the keys keeps the "not a duplicate" decisions the user
 * has made without the worker needing to know where they came from.
 */
export function getRejectionKeys() {
  return rejectionSet ? Array.from(rejectionSet) : [];
}

/**
 * Check if a pair has been rejected before. Used by the tests and by anything
 * outside the matching loop; the loop itself uses the key set it was handed
 * (makeRejectionLookup in matcher.js), because it runs in a worker.
 */
export async function isRejectedPair(entryA, entryB) {
  await ensureLoaded();
  if (!entryA?.base12 || !entryB?.base12) return false;
  return rejectionSet.has(pairKey(entryA.base12, entryB.base12));
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
