/*
 * Drive Dupe Destroyer (DDD) — reviewState.js
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
// How far through the review you got, kept across sessions (#117).
//
// The asymmetry this fixes: js/resume.js persists the SCAN -- folder ids,
// exclusions, the BFS frontier, the files collected so far, with #99 going as
// far as shrinking webViewLink out of the payload because checkpoints were
// writing 125 MB a scan. Scanning is treated as expensive work worth
// protecting. Reviewing was not persisted at all.
//
// But the scan is the part the machine does. The review is the part the PERSON
// does, and on a large library it is far longer -- 800 groups is an evening,
// not a coffee break, so it will be interrupted. An interruption used to cost
// the entire review, and the likely real-world outcome is not "start over", it
// is "don't come back".
//
// Keyed on the group signature (member ids, sorted) rather than the group's
// position, for the same reason keeper pins are: numbering is re-derived on
// every filter change and after every delete, so a positional key would move
// somebody's judgement onto a different group.

import { stateGet, stateSet } from "./db.js";

const KEY = "destroyer_review_v1";

export const UNTOUCHED = "untouched";
export const DECIDED = "decided";
export const SKIPPED = "skipped";

/**
 * What makes two scans "the same review".
 *
 * Folder selection and exclusions only. Narrowing the similarity threshold or
 * re-sorting still shows the same groups, so the review carries over; scanning
 * a DIFFERENT set of folders is a different job and must not inherit anything
 * -- the same reason the delta scan has to invalidate on scope change (#116).
 */
export function reviewScopeKey({ folderIds = [], exclusions = [] } = {}) {
  const inc = [...folderIds].map(String).sort().join(",");
  const exc = [...(exclusions instanceof Set ? exclusions : exclusions)].map(String).sort().join(",");
  return `${inc}|${exc}`;
}

export function makeReviewState(scope = "") {
  return { scope, marks: new Map(), keepers: new Map() };
}

/** Record that something was actually done to this group. */
export function markDecided(state, signature) {
  state.marks.set(signature, DECIDED);
  return state;
}

/** Record that the user looked and chose to move on. */
export function markSkipped(state, signature) {
  state.marks.set(signature, SKIPPED);
  return state;
}

export function statusOf(state, signature) {
  return state?.marks.get(signature) || UNTOUCHED;
}

export function isReviewed(state, signature) {
  return statusOf(state, signature) !== UNTOUCHED;
}

/** Remember which file the user pinned as this group's keeper (#73). */
export function setKeeper(state, signature, fileId) {
  if (fileId) state.keepers.set(signature, fileId);
  else state.keepers.delete(signature);
  return state;
}

/** How much is left to do, which is the number worth showing. */
export function reviewCounts(state, signatures) {
  const counts = { [UNTOUCHED]: 0, [DECIDED]: 0, [SKIPPED]: 0 };
  for (const sig of signatures) counts[statusOf(state, sig)]++;
  return counts;
}

/**
 * Forget marks for groups that no longer exist.
 *
 * Without this the store grows forever: every rescan that reshapes a group
 * leaves its old signature behind, and IndexedDB keeps it indefinitely.
 */
export function pruneToSignatures(state, signatures) {
  const live = new Set(signatures);
  for (const sig of [...state.marks.keys()]) if (!live.has(sig)) state.marks.delete(sig);
  for (const sig of [...state.keepers.keys()]) if (!live.has(sig)) state.keepers.delete(sig);
  return state;
}

// --- persistence ----------------------------------------------------------
//
// Maps do not survive structured clone into IndexedDB as anything useful to
// read back by hand, so they are stored as plain arrays of pairs.

export function serializeReviewState(state) {
  return {
    scope: state.scope,
    marks: [...state.marks.entries()],
    keepers: [...state.keepers.entries()],
    savedAt: Date.now(),
  };
}

export function deserializeReviewState(raw, scope) {
  // A stored review from a DIFFERENT folder selection is not this review.
  // Returning a fresh state rather than the stored one is what stops a
  // judgement made about one set of folders leaking into another.
  if (!raw || raw.scope !== scope) return makeReviewState(scope);
  return {
    scope,
    marks: new Map(Array.isArray(raw.marks) ? raw.marks : []),
    keepers: new Map(Array.isArray(raw.keepers) ? raw.keepers : []),
  };
}

export async function loadReviewState(scope) {
  const raw = await stateGet(KEY).catch(() => null);
  return deserializeReviewState(raw, scope);
}

export async function saveReviewState(state) {
  if (!state) return;
  await stateSet(KEY, serializeReviewState(state)).catch(() => {});
}

export async function clearReviewState() {
  await stateSet(KEY, null).catch(() => {});
}
