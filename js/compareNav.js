/*
 * Drive Dupe Destroyer (DDD) — compareNav.js
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
// Walking the pairs in the compare view, as arithmetic (#129).
//
// js/compare.js is 612 lines and had no test or harness of any kind, on the
// screen where a person looks at two near-identical photographs and decides
// which one to destroy. The navigation is the part worth pinning, because the
// set it walks SHRINKS WHILE THE VIEW IS OPEN: trashing a file removes it from
// its group, and a group that drops below two members has nothing left to
// compare.
//
// Every failure mode here is silent and lands on the destructive path. An
// off-by-one in nextReviewable skips a group nobody ever sees. A wrong
// pairCount shows the keeper against itself. A stale index after a delete
// shows the wrong pair — and which pane is the keeper decides whether the
// "you are deleting the KEEP file" warning appears at all.
//
// The keeper is passed in as a function rather than computed here, so this
// module never has to know about the keep-rule dropdown, the folder-priority
// field, or the per-group pins from #73.

/** The keeper, and every member that is not it. */
export function candidatesIn(group, keeperFor) {
  const keepFile = (Array.isArray(group) && group.length) ? keeperFor(group) : null;
  return { keepFile, others: (group || []).filter(f => f.id !== keepFile?.id) };
}

/** How many comparisons this group still offers. */
export function pairCount(groups, index, keeperFor) {
  const g = groups[index];
  return g && g.length >= 2 ? candidatesIn(g, keeperFor).others.length : 0;
}

/**
 * The first group at or after `index`, walking by `step`, that still has
 * something to compare. -1 when there is none.
 */
export function nextReviewable(groups, index, step, keeperFor) {
  for (let i = index; i >= 0 && i < groups.length; i += step) {
    if (pairCount(groups, i, keeperFor) > 0) return i;
  }
  return -1;
}

/** Is there anything left to review at all? */
export function anyReviewable(groups, keeperFor) {
  return nextReviewable(groups, 0, 1, keeperFor) >= 0;
}

/**
 * Resolve a (group, pair) request to a real pair, rolling across group
 * boundaries in either direction.
 *
 * Returns a status rather than showing a toast, so the same logic can be
 * checked without a DOM:
 *
 *   "ok"        -> groupIndex / pairIndex / keepFile / other are set
 *   "empty"     -> nothing anywhere is reviewable; the caller closes the view
 *   "at-end"    -> ran off the last group
 *   "at-start"  -> ran off the first group
 *
 * Rolling BACKWARDS lands on the LAST pair of the previous reviewable group,
 * not its first: stepping back must not skip the members you just walked
 * forward through.
 */
export function resolvePair(groups, groupIndex, pairIndex, keeperFor) {
  if (!Array.isArray(groups) || groups.length === 0 || !anyReviewable(groups, keeperFor)) {
    return { status: "empty" };
  }

  let gi = groupIndex;
  let pi = pairIndex;

  while (gi < groups.length && pi >= pairCount(groups, gi, keeperFor)) {
    const next = nextReviewable(groups, gi + 1, 1, keeperFor);
    if (next < 0) return { status: "at-end" };
    // Math.max(..., 1) so a group with no pairs cannot leave `pi` unchanged
    // and spin this loop forever.
    pi -= Math.max(pairCount(groups, gi, keeperFor), 1);
    gi = next;
    if (pi < 0) pi = 0;
  }

  while (gi >= 0 && pi < 0) {
    const prev = nextReviewable(groups, gi - 1, -1, keeperFor);
    if (prev < 0) return { status: "at-start" };
    gi = prev;
    pi += pairCount(groups, gi, keeperFor);
  }

  if (gi < 0 || gi >= groups.length) return { status: "at-end" };

  const { keepFile, others } = candidatesIn(groups[gi], keeperFor);
  if (!keepFile || others.length === 0) return { status: "at-end" };

  const resolved = Math.min(Math.max(pi, 0), others.length - 1);
  return {
    status: "ok",
    groupIndex: gi,
    pairIndex: resolved,
    keepFile,
    other: others[resolved],
  };
}

/**
 * "Group 3 of 12 · pair 2 of 4".
 *
 * The ordinal counts REVIEWABLE groups rather than raw indices, so the numbers
 * do not jump as groups are emptied by deletions — which is the whole reason
 * this is not simply `index + 1`.
 */
export function progressLabel(groups, groupIndex, pairIndex, keeperFor) {
  const pairs = pairCount(groups, groupIndex, keeperFor);
  let reviewable = 0;
  for (let i = 0; i < groups.length; i++) if (pairCount(groups, i, keeperFor) > 0) reviewable++;
  let ordinal = 0;
  for (let i = 0; i <= groupIndex && i < groups.length; i++) {
    if (pairCount(groups, i, keeperFor) > 0) ordinal++;
  }
  return pairs > 1
    ? `Group ${ordinal} of ${reviewable} · pair ${pairIndex + 1} of ${pairs}`
    : `Group ${ordinal} of ${reviewable}`;
}
