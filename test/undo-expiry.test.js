/*
 * Drive Dupe Destroyer (DDD) — test/undo-expiry.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// When the Undo button's promise stops being true (#141).
//
// Measured before this existed: record a delete, advance the clock 31 minutes
// with nothing else touching the page, and the button still read "Undo (1)"
// and was still enabled. getUndoCount() correctly returned 0 -- the model was
// right and the display was frozen, because nothing recomputed it.
//
// That is the wrong thing to get wrong. The whole argument for proposing
// irreversible deletions is that they are reversible for thirty minutes, and
// the button is the visible promise of it.
//
// The scheduling decision is pure so it can be checked without waiting out a
// real clock; the browser half is tools/undo-expiry.mjs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { msUntilNextExpiry } from "../js/undo.js";

const TTL = 30 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = Date.parse("2026-01-01T12:00:00Z");
const op = (minutesAgo) => ({ trashedAt: NOW - minutesAgo * MIN });

describe("when to recompute the Undo button (#141)", () => {
  test("nothing to expire means nothing to schedule", () => {
    assert.equal(msUntilNextExpiry([], NOW), null);
    assert.equal(msUntilNextExpiry(null, NOW), null);
  });

  test("a fresh delete expires a full TTL from now", () => {
    assert.equal(msUntilNextExpiry([op(0)], NOW), TTL);
  });

  test("a delete made 10 minutes ago has 20 left", () => {
    assert.equal(msUntilNextExpiry([op(10)], NOW), 20 * MIN);
  });

  test("the SOONEST expiry wins, not the newest entry", () => {
    // The count on the button drops by one the moment the OLDEST fresh
    // operation lapses. Waiting for the newest would leave an overstated count
    // on screen until then -- "Undo (3)" when only 2 are still restorable.
    const ms = msUntilNextExpiry([op(25), op(10), op(0)], NOW);
    assert.equal(ms, 5 * MIN, "should wake when the 25-minute-old op lapses");
  });

  test("already-expired entries are ignored, not scheduled for the past", () => {
    const ms = msUntilNextExpiry([op(45), op(5)], NOW);
    assert.equal(ms, 25 * MIN);
  });

  test("a stack where everything has expired schedules nothing", () => {
    assert.equal(msUntilNextExpiry([op(31), op(60)], NOW), null);
  });

  test("never returns 0, which would reschedule in a tight loop", () => {
    // Exactly on the boundary the entry still counts as fresh, so a naive
    // `oldest + TTL - now` would be 0 and the timeout would fire immediately,
    // recompute, and schedule another 0.
    const ms = msUntilNextExpiry([op(30)], NOW);
    assert.ok(ms > 0, `expected a positive delay, got ${ms}`);
  });

  test("ignores malformed entries rather than scheduling on NaN", () => {
    assert.equal(msUntilNextExpiry([null, {}, { trashedAt: "soon" }], NOW), null);
    assert.equal(msUntilNextExpiry([null, op(10)], NOW), 20 * MIN);
  });
});
