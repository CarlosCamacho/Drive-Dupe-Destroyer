/*
 * Drive Dupe Destroyer (DDD) — uiText.js
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
// What the chrome SAYS, as arithmetic (#130).
//
// js/ui.js was 732 lines and 29 exports with not one unit test, because every
// function reaches for `document` on its first line. But a good half of what
// those functions do is arithmetic and string formatting that merely HAPPENS
// to end in an assignment to textContent, and three of the five most important
// have already shipped a real defect:
//
//   #113  refreshActionButtons disabled the whole toolbar after every render
//   #114  the reclaimable figure over-promised when Drive reported no size
//   14.7.12  the toast cap's eviction loop spun the renderer until Chromium
//            killed the tab -- found because an unrelated harness lost its page
//
// None of those needed a browser to catch. This module holds the half that
// does not, so ui.js can shrink to the half that does.
//
// The eviction case is worth one note. The infinite loop was a `while` over a
// LIVE DOM collection whose removals are deferred 300ms, so the first child was
// still the first child on the next pass. toastsToEvict returns the list to
// dismiss instead of a condition to loop on, which is why that shape cannot
// come back here.

import { bytesToHuman, humanDuration } from "./util.js";

/** How many toasts may be on screen at once. */
export const TOAST_MAX = 3;

/**
 * The reclaimable line (#114).
 *
 * A floor, not a promise, when Drive reported no size for some duplicates:
 * "≥ 8.3 GB" is a number the user can trust, "8.3 GB" is one that quietly
 * over-promises. `stats` is null before a scan has produced anything.
 *
 * @param {{reclaimable: number, selected: number, unknown: number}|null} stats
 */
export function sizeStatsText(stats) {
  if (!stats) {
    return { reclaimable: "—", reclaimableTitle: "", selected: "", selectedTitle: "" };
  }
  const { reclaimable = 0, selected = 0, unknown = 0 } = stats;
  return {
    reclaimable:
      reclaimable <= 0 ? "—"
      : unknown > 0 ? `≥ ${bytesToHuman(reclaimable)}`
      : bytesToHuman(reclaimable),
    reclaimableTitle: unknown > 0
      ? `At least this much: Google Drive reported no size for ${unknown} duplicate(s), so they are not counted.`
      : "The total size of every duplicate that is not its group's keeper.",
    selected: selected > 0 ? ` — ${bytesToHuman(selected)} selected` : "",
    selectedTitle: "",
  };
}

/**
 * The scan summary row. `null` means "not measured", which is not the same as
 * zero -- a 0% cache hit is a finding and an em dash is an absence.
 */
export function scanStatsText({ groups = 0, files = 0, totalBytes = 0, cacheHit = null, durationMs = null } = {}) {
  return {
    groups: String(groups),
    files: String(files),
    size: bytesToHuman(totalBytes),
    cacheHit: cacheHit == null ? "—" : `${Math.round(cacheHit * 100)}%`,
    duration: durationMs == null ? "—" : humanDuration(durationMs),
  };
}

/**
 * "(412 groups, 1,003 files · 88 of 412 reviewed)".
 *
 * The filter half only appears when a filter is actually narrowing something;
 * the review half only once there is progress to report (#117), because
 * "0 of 412 reviewed" on a fresh scan is noise.
 */
export function filterStatsText(groups, files, filter, review = null) {
  const parts = [];
  if (filter !== "all") parts.push(`${groups} groups, ${files} files`);
  if (review && review.total > 0 && review.untouched < review.total) {
    parts.push(`${(review.total - review.untouched).toLocaleString()} of ${review.total.toLocaleString()} reviewed`);
  }
  return parts.length ? `(${parts.join(" · ")})` : "";
}

/**
 * Which toolbar buttons are live, and what they say (#113).
 *
 * Two different counts, and conflating them is exactly the bug that shipped:
 * SELECT ALL depends on there being rows at all, TRASH and QUEUE on something
 * being ticked. The row count must come from the result set rather than the
 * DOM, because the table is virtualised and the tbody is empty at the moment
 * this runs.
 */
export function actionButtonState(rowCount, checkedCount) {
  const rows = Number(rowCount) || 0;
  const checked = Number(checkedCount) || 0;
  return {
    selectAllDisabled: rows === 0,
    selectNoneDisabled: rows === 0,
    trashDisabled: checked === 0,
    trashLabel: checked > 0 ? `🗑️ Trash Selected (${checked})` : "🗑️ Trash Selected",
    queueDisabled: checked === 0,
    queueLabel: checked > 0 ? `📋 Queue Selected (${checked})` : "📋 Queue Selected",
  };
}

/**
 * What a screen reader hears on the progress bar itself (#104).
 *
 * A bare percentage says nothing about what is happening. #status is a live
 * region and announces the phase; this is for anyone who navigates to the bar.
 */
export function progressValueText(pct, phase = "") {
  return `${Math.round(Number(pct) || 0)}%${phase ? " — " + phase : ""}`;
}

/**
 * The three first-run states (#103).
 *
 * The panel used to say "No duplicates found" from the very first paint -- a
 * verdict on a scan that had never run, above a toolbar of ten disabled
 * controls. These are three different situations:
 *
 *   before-signin : nothing has been attempted, and the next step is sign-in
 *   ready         : signed in, nothing scanned yet
 *   none-found    : a scan really did run and found nothing -- the only state
 *                   in which the old copy was true
 */
const EMPTY_STATES = {
  "before-signin": {
    icon: "🖼️",
    title: "Find duplicate photos in Google Drive",
    body: "Sign in to get started.",
    steps: ["Sign in with Google", "Choose the folders to search", "Start the scan"],
  },
  ready: {
    icon: "📂",
    title: "Ready to scan",
    body: "Choose the folders to search, then start the scan.",
    steps: null,
  },
  "none-found": {
    icon: "✅",
    title: "No duplicates found",
    body: "Nothing in the folders you scanned looks like a duplicate.",
    steps: null,
  },
};

export const DEFAULT_EMPTY_STATE = "before-signin";

/**
 * @param {'before-signin'|'ready'|'none-found'} kind
 * @param {string} detail  what was actually searched, so "no duplicates" reads
 *                         as a finding rather than an assertion
 */
export function emptyStateFor(kind, detail = "") {
  const s = EMPTY_STATES[kind] || EMPTY_STATES[DEFAULT_EMPTY_STATE];
  return { icon: s.icon, title: s.title, body: detail || s.body, steps: s.steps };
}

/**
 * How long a toast stays.
 *
 * An error stays until the user deals with it; a confirmation does not need to.
 * A toast carrying an action gets longer, because the action has to be
 * reachable before it vanishes. 0 means "until dismissed".
 */
export function toastDurationMs(type = "info", duration = null, action = null) {
  if (duration != null) return duration;
  if (type === "error") return 0;
  return action ? 10000 : 4000;
}

/** Errors interrupt; everything else waits its turn. */
export function toastRole(type) {
  return type === "error" ? "alert" : "status";
}

/**
 * Which toasts to dismiss to get back under the cap, oldest first.
 *
 * Returns the LIST rather than a condition to loop on. The version this
 * replaces was `while (container.children.length > MAX) dismiss(first)` over a
 * live collection whose removals are deferred 300ms: the first child was still
 * the first child on the next pass, and the second dismiss returned early
 * because that toast was already leaving. It spun the renderer until Chromium
 * killed the tab (14.7.12).
 *
 * @param {Array} live  the toasts not already leaving, oldest first
 */
export function toastsToEvict(live, max = TOAST_MAX) {
  const list = Array.isArray(live) ? live : [];
  const over = list.length - Math.max(0, max);
  return over > 0 ? list.slice(0, over) : [];
}

/** "×3" on a collapsed duplicate. */
export function toastCountText(n) {
  return `×${Number(n) || 0}`;
}

/** "Moved 1 file to Google Drive Trash" / "Moved 1,204 files ..." (#106). */
export function trashedToastMessage(count) {
  const n = Number(count) || 0;
  return `Moved ${n === 1 ? "1 file" : `${n.toLocaleString()} files`} to Google Drive Trash`;
}

/**
 * The ETA, and whether there is one worth showing.
 *
 * Three ways there is not: too early to extrapolate from, too little elapsed
 * time, and progress that has not moved (or gone backwards, which a rescan
 * does). `restart` says the clock should be reset -- the caller owns the
 * timestamps, so this stays a function of its arguments.
 *
 * @param {number} pct              current progress, 0-100
 * @param {number} elapsedSeconds   since the clock was last restarted
 * @param {number} lastPct          the previous pct this returned `show` for
 */
export function etaState(pct, elapsedSeconds, lastPct = 0) {
  if (pct <= 2) return { show: false, restart: true, lastPct: pct, label: "" };
  if (elapsedSeconds < 3 || pct <= lastPct) {
    return { show: false, restart: false, lastPct, label: "" };
  }
  const remaining = (100 - pct) / (pct / elapsedSeconds);
  return { show: true, restart: false, lastPct: pct, label: `ETA: ${etaLabel(remaining)}` };
}

/** Seconds remaining, rounded to a unit somebody can act on. */
export function etaLabel(remainingSeconds) {
  const r = Number(remainingSeconds);
  if (!isFinite(r) || r < 0) return "—";
  if (r < 10) return "< 10s";
  if (r < 60) return `~${Math.round(r)}s`;
  if (r < 3600) return `~${Math.round(r / 60)}m`;
  return `~${Math.round(r / 3600)}h`;
}
