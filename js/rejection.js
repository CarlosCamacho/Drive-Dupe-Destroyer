/*
 * Drive Dupe Destroyer (DDD) v14.0 — rejection.js
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
// False-positive feedback loop - Feature #19
// Stores rejected pairs by hash fingerprint so they persist across sessions.
// Also tracks session-level calibration data for weight tuning.

import { settingGet, settingSet } from "./db.js";

const REJECTION_KEY = "destroyer_rejected_pairs_v1";
const MAX_REJECTIONS = 10000;

// In-memory cache loaded once per session
let rejectionSet = null;

async function ensureLoaded() {
  if (rejectionSet !== null) return;
  const saved = await settingGet(REJECTION_KEY, []).catch(() => []);
  rejectionSet = new Set(Array.isArray(saved) ? saved : []);
}

/**
 * Create a canonical key from two hash fingerprints.
 * Order-independent: always smaller hash first.
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
  rejectionSet.add(key);
  // Trim if too large
  if (rejectionSet.size > MAX_REJECTIONS) {
    const first = rejectionSet.values().next().value;
    rejectionSet.delete(first);
  }
  await settingSet(REJECTION_KEY, Array.from(rejectionSet)).catch(() => {});
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
  await settingSet(REJECTION_KEY, []).catch(() => {});
}
