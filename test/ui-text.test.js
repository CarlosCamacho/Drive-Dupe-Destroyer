/*
 * Drive Dupe Destroyer (DDD) — test/ui-text.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The half of js/ui.js that never needed a browser (#130).
//
// Three of these paths have already shipped a defect: the toolbar that
// disabled itself after every render (#113), the reclaimable figure that
// over-promised (#114), and the toast eviction loop that spun the renderer
// until Chromium killed the tab (14.7.12). Each has its own case below.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  TOAST_MAX, DEFAULT_EMPTY_STATE,
  sizeStatsText, scanStatsText, filterStatsText, actionButtonState,
  progressValueText, emptyStateFor, toastDurationMs, toastRole,
  toastsToEvict, toastCountText, trashedToastMessage, etaState, etaLabel,
} from "../js/uiText.js";

describe("the reclaimable figure (#114)", () => {
  test("is a plain total when every duplicate has a known size", () => {
    const t = sizeStatsText({ reclaimable: 8_912_896, selected: 0, unknown: 0 });
    assert.equal(t.reclaimable, "8.5 MB");
    assert.match(t.reclaimableTitle, /every duplicate that is not its group's keeper/);
  });

  test("becomes a floor as soon as one size is unknown", () => {
    const t = sizeStatsText({ reclaimable: 8_912_896, selected: 0, unknown: 1 });
    assert.equal(t.reclaimable, "≥ 8.5 MB");
  });

  test("says how many sizes are missing, so the floor is explicable", () => {
    const t = sizeStatsText({ reclaimable: 1024, selected: 0, unknown: 7 });
    assert.match(t.reclaimableTitle, /no size for 7 duplicate\(s\)/);
  });

  test("an em dash when there is nothing to reclaim, not '0 B'", () => {
    assert.equal(sizeStatsText({ reclaimable: 0, selected: 0, unknown: 0 }).reclaimable, "—");
    assert.equal(sizeStatsText({ reclaimable: 0, selected: 0, unknown: 5 }).reclaimable, "—");
  });

  test("the selected clause appears only when something is selected", () => {
    assert.equal(sizeStatsText({ reclaimable: 100, selected: 0, unknown: 0 }).selected, "");
    assert.equal(
      sizeStatsText({ reclaimable: 2048, selected: 1024, unknown: 0 }).selected,
      " — 1.0 KB selected",
    );
  });

  test("no stats at all reads as absence, not as zero", () => {
    const t = sizeStatsText(null);
    assert.equal(t.reclaimable, "—");
    assert.equal(t.selected, "");
    assert.equal(t.reclaimableTitle, "");
  });
});

describe("the scan summary", () => {
  test("distinguishes a measured zero from an unmeasured one", () => {
    const measured = scanStatsText({ groups: 4, files: 9, totalBytes: 2048, cacheHit: 0, durationMs: 0 });
    assert.equal(measured.cacheHit, "0%");
    assert.equal(measured.duration, "0s");

    const unmeasured = scanStatsText({ groups: 4, files: 9, totalBytes: 2048 });
    assert.equal(unmeasured.cacheHit, "—");
    assert.equal(unmeasured.duration, "—");
  });

  test("rounds the cache hit to whole percent", () => {
    assert.equal(scanStatsText({ cacheHit: 0.876 }).cacheHit, "88%");
  });

  test("an empty call is all zeros and dashes, never NaN", () => {
    const t = scanStatsText();
    assert.equal(t.groups, "0");
    assert.equal(t.files, "0");
    assert.equal(t.size, "0 B");
  });
});

describe("the filter and review line (#117)", () => {
  test("is empty with no filter and no review progress", () => {
    assert.equal(filterStatsText(10, 30, "all", null), "");
  });

  test("reports the narrowed counts when a filter is on", () => {
    assert.equal(filterStatsText(3, 8, "images", null), "(3 groups, 8 files)");
  });

  test("stays quiet at zero reviewed -- that is not progress", () => {
    assert.equal(filterStatsText(10, 30, "all", { total: 412, untouched: 412 }), "");
  });

  test("counts reviewed as total minus untouched, with thousands separators", () => {
    assert.equal(
      filterStatsText(10, 30, "all", { total: 4120, untouched: 3000 }),
      "(1,120 of 4,120 reviewed)",
    );
  });

  test("shows both halves together", () => {
    assert.equal(
      filterStatsText(3, 8, "images", { total: 12, untouched: 5 }),
      "(3 groups, 8 files · 7 of 12 reviewed)",
    );
  });
});

describe("the toolbar (#113)", () => {
  test("rows enable Select All; a selection enables Trash and Queue", () => {
    const s = actionButtonState(40, 3);
    assert.equal(s.selectAllDisabled, false);
    assert.equal(s.selectNoneDisabled, false);
    assert.equal(s.trashDisabled, false);
    assert.equal(s.queueDisabled, false);
  });

  test("rows with nothing ticked: Select All live, Trash and Queue dead", () => {
    const s = actionButtonState(40, 0);
    assert.equal(s.selectAllDisabled, false, "40 rows exist -- Select All must be reachable");
    assert.equal(s.trashDisabled, true);
    assert.equal(s.queueDisabled, true);
  });

  test("no rows disables everything", () => {
    const s = actionButtonState(0, 0);
    assert.equal(s.selectAllDisabled, true);
    assert.equal(s.trashDisabled, true);
    assert.equal(s.queueDisabled, true);
  });

  test("the labels carry the count, and drop it at zero", () => {
    assert.equal(actionButtonState(40, 12).trashLabel, "🗑️ Trash Selected (12)");
    assert.equal(actionButtonState(40, 12).queueLabel, "📋 Queue Selected (12)");
    assert.equal(actionButtonState(40, 0).trashLabel, "🗑️ Trash Selected");
    assert.equal(actionButtonState(40, 0).queueLabel, "📋 Queue Selected");
  });

  test("a missing provider reads as zero rather than NaN", () => {
    const s = actionButtonState(undefined, null);
    assert.equal(s.selectAllDisabled, true);
    assert.equal(s.trashLabel, "🗑️ Trash Selected");
  });
});

describe("what a screen reader hears on the progress bar (#104)", () => {
  test("carries the phase, not just a number", () => {
    assert.equal(progressValueText(42, "Hashing images"), "42% — Hashing images");
  });

  test("works with no phase yet", () => {
    assert.equal(progressValueText(0, ""), "0%");
  });

  test("rounds, because 41.7% is not something anyone needs read aloud", () => {
    assert.equal(progressValueText(41.7, "Finding matches"), "42% — Finding matches");
  });
});

describe("the empty panel (#103)", () => {
  test("before sign-in, the next step is sign-in -- not a verdict", () => {
    const s = emptyStateFor("before-signin");
    assert.equal(s.title, "Find duplicate photos in Google Drive");
    assert.equal(s.steps.length, 3);
  });

  test("signed in but not scanned is its own state, with no steps list", () => {
    const s = emptyStateFor("ready");
    assert.equal(s.title, "Ready to scan");
    assert.equal(s.steps, null);
  });

  test("'No duplicates found' is reachable only after a scan", () => {
    assert.equal(emptyStateFor("none-found").title, "No duplicates found");
  });

  test("a detail replaces the generic body, so the verdict says what was searched", () => {
    const s = emptyStateFor("none-found", "No duplicates among 4,812 images in 12 folders.");
    assert.equal(s.body, "No duplicates among 4,812 images in 12 folders.");
  });

  test("an unknown kind falls back to before-signin, never to a verdict", () => {
    assert.equal(emptyStateFor("nonsense").title, emptyStateFor(DEFAULT_EMPTY_STATE).title);
    assert.notEqual(emptyStateFor("nonsense").title, "No duplicates found");
  });
});

describe("toasts", () => {
  test("an error persists until dismissed; everything else expires", () => {
    assert.equal(toastDurationMs("error"), 0);
    assert.equal(toastDurationMs("success"), 4000);
    assert.equal(toastDurationMs("info"), 4000);
  });

  test("a toast carrying an action gets longer, because it has to be clickable", () => {
    assert.equal(toastDurationMs("success", null, { label: "Undo" }), 10000);
  });

  test("an explicit duration wins over every rule, including for errors", () => {
    assert.equal(toastDurationMs("error", 2500), 2500);
    assert.equal(toastDurationMs("success", 0, { label: "Undo" }), 0);
  });

  test("errors interrupt the screen reader; the rest wait their turn", () => {
    assert.equal(toastRole("error"), "alert");
    assert.equal(toastRole("success"), "status");
  });

  test("the duplicate badge counts the collapsed copies", () => {
    assert.equal(toastCountText(3), "×3");
  });

  // 14.7.12: the loop that replaced this spun the renderer until Chromium
  // killed the tab. The property that matters is that it TERMINATES and names
  // every toast to remove in one pass.
  test("evicts exactly the overflow, oldest first", () => {
    assert.deepEqual(toastsToEvict(["a", "b", "c", "d"], 3), ["a"]);
    assert.deepEqual(toastsToEvict(["a", "b", "c", "d", "e"], 3), ["a", "b"]);
  });

  test("evicts nothing at or under the cap", () => {
    assert.deepEqual(toastsToEvict(["a", "b", "c"], 3), []);
    assert.deepEqual(toastsToEvict([], 3), []);
  });

  test("a cap of zero evicts everything rather than looping", () => {
    assert.deepEqual(toastsToEvict(["a", "b"], 0), ["a", "b"]);
  });

  test("survives a negative cap and a non-array", () => {
    assert.deepEqual(toastsToEvict(["a"], -5), ["a"]);
    assert.deepEqual(toastsToEvict(null, 3), []);
  });

  test("the default cap is the one ui.js ships", () => {
    assert.equal(TOAST_MAX, 3);
  });

  test("the trash message counts files, and says '1 file' for one (#106)", () => {
    assert.equal(trashedToastMessage(1), "Moved 1 file to Google Drive Trash");
    assert.equal(trashedToastMessage(2), "Moved 2 files to Google Drive Trash");
    assert.equal(trashedToastMessage(1204), "Moved 1,204 files to Google Drive Trash");
  });
});

describe("the ETA", () => {
  test("says nothing below 3%, and restarts the clock there", () => {
    const s = etaState(1, 40, 0);
    assert.equal(s.show, false);
    assert.equal(s.restart, true);
    assert.equal(s.lastPct, 1);
  });

  test("says nothing in the first 3 seconds, however far along it is", () => {
    assert.equal(etaState(50, 2.9, 0).show, false);
  });

  test("says nothing when progress has not moved, and keeps the old mark", () => {
    const s = etaState(50, 30, 50);
    assert.equal(s.show, false);
    assert.equal(s.lastPct, 50, "a stalled reading must not become the new baseline");
  });

  test("says nothing when progress goes backwards, as a rescan does", () => {
    assert.equal(etaState(20, 30, 55).show, false);
  });

  test("extrapolates from the rate so far", () => {
    // 50% in 50s is 1%/s, so the remaining 50% is ~50s.
    assert.equal(etaState(50, 50, 10).label, "ETA: ~50s");
  });

  test("advances the mark only on a reading it showed", () => {
    assert.equal(etaState(50, 50, 10).lastPct, 50);
  });

  test("picks a unit somebody can act on", () => {
    assert.equal(etaLabel(4), "< 10s");
    assert.equal(etaLabel(45), "~45s");
    assert.equal(etaLabel(600), "~10m");
    assert.equal(etaLabel(7200), "~2h");
  });

  test("an impossible remaining time is an em dash, not 'Infinityh'", () => {
    assert.equal(etaLabel(Infinity), "—");
    assert.equal(etaLabel(NaN), "—");
    assert.equal(etaLabel(-1), "—");
  });
});
