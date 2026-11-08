/*
 * Drive Dupe Destroyer (DDD) — test/update-reload.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// How a new version reaches a tab that is already open.
//
// Dialogs removed releases ago kept appearing: the tab had been open for days.
// A browser only looks for a new service worker when a page loads (and about
// once a day), so a tab that never navigates never finds out. And when the
// update did arrive while something was open, the only notice was a toast that
// vanished after ten seconds and was never shown again.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldCheckForUpdate, updateReloadAction } from "../js/uiText.js";

const idle = { hadController: true, alreadyHandled: false, scanning: false, modalOpen: false, resultRows: 0 };

describe("updateReloadAction", () => {
  test("an idle page that was already controlled reloads straight away", () => {
    assert.equal(updateReloadAction(idle), "reload");
  });

  test("a first visit is never reloaded: the worker that activates is not an update", () => {
    assert.equal(updateReloadAction({ ...idle, hadController: false }), "ignore");
  });

  test("an update is handled once", () => {
    assert.equal(updateReloadAction({ ...idle, alreadyHandled: true }), "ignore");
  });

  for (const [why, busy] of [
    ["a scan is running", { scanning: true }],
    ["a dialog or the crop window is open", { modalOpen: true }],
    ["there are duplicates on screen being reviewed", { resultRows: 12 }],
  ]) {
    test(`it offers the reload instead when ${why}`, () => {
      assert.equal(updateReloadAction({ ...idle, ...busy }), "offer");
    });
  }
});

describe("shouldCheckForUpdate", () => {
  const MIN = 60 * 1000;
  test("checks when it never has", () => {
    assert.equal(shouldCheckForUpdate(1_000_000, undefined), true);
    assert.equal(shouldCheckForUpdate(1_000_000, NaN), true);
  });
  test("does not ask again within ten minutes of the last time", () => {
    assert.equal(shouldCheckForUpdate(100 * MIN, 95 * MIN), false);
    assert.equal(shouldCheckForUpdate(100 * MIN, 91 * MIN), false);
  });
  test("asks again once ten minutes have passed", () => {
    assert.equal(shouldCheckForUpdate(100 * MIN, 90 * MIN), true);
    assert.equal(shouldCheckForUpdate(100 * MIN, 0), true);
  });
  test("the gap is a parameter", () => {
    assert.equal(shouldCheckForUpdate(100 * MIN, 95 * MIN, 3 * MIN), true);
  });
});
