/*
 * Drive Dupe Destroyer (DDD) — test/aimd.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// AIMDController, and the classification that decides when hashing.js calls it.
//
// The controller halves concurrency on EVERY onError call — its isThrottle
// argument only changes the log line. That makes the decision of *when to call
// it* the load-bearing part. That decision lives in isBackpressureError, which
// is in common.js precisely so this can test the real function rather than a
// copy of it that would drift.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { AIMDController } from "../js/aimd.js";
import { isBackpressureError, isThrottleError } from "../js/common.js";

describe("AIMDController", () => {
  test("halves on error, down to the floor", () => {
    const c = new AIMDController({ initial: 8, min: 1, max: 12 });
    c.onError(true); assert.equal(c.value, 4);
    c.onError(true); assert.equal(c.value, 2);
    c.onError(true); assert.equal(c.value, 1);
    c.onError(true); assert.equal(c.value, 1, "must not go below min");
  });

  test("climbs back only after a streak of successes", () => {
    const c = new AIMDController({ initial: 2, min: 1, max: 12 });
    for (let i = 0; i < 4; i++) c.onSuccess();
    assert.equal(c.value, 2, "four successes is below the streak threshold");
    c.onSuccess();
    assert.equal(c.value, 3, "the fifth crosses it");
  });

  test("respects the ceiling", () => {
    const c = new AIMDController({ initial: 11, min: 1, max: 12 });
    for (let i = 0; i < 50; i++) c.onSuccess();
    assert.equal(c.value, 12);
  });

  test("onUpdate fires only when the value actually moves", () => {
    const seen = [];
    const c = new AIMDController({ initial: 1, min: 1, max: 4, onUpdate: n => seen.push(n) });
    c.onError(true);                       // already at min — no change
    assert.deepEqual(seen, []);
    for (let i = 0; i < 5; i++) c.onSuccess();
    assert.deepEqual(seen, [2]);
  });

  // The argument is cosmetic. Documented here so nobody assumes onError(false)
  // is a no-op — that assumption is exactly what caused the bug below.
  test("isThrottle does NOT gate the decrease", () => {
    const c = new AIMDController({ initial: 8, min: 1, max: 12 });
    c.onError(false);
    assert.equal(c.value, 4, "onError(false) halves just the same");
  });
});

// ---------------------------------------------------------------------------
// isBackpressureError — the real function hashing.js calls
// ---------------------------------------------------------------------------

describe("backoff classification", () => {
  test("backs off on real server pressure", () => {
    for (const e of [
      { status: 429 },
      { message: "Drive API error 429: Rate Limit Exceeded" },
      { message: "too many requests" },
      { status: 500 },
      { status: 503 },
      { code: "NETWORK", message: "Network request failed" },
      { message: "Silent refresh timeout" },
    ]) {
      assert.equal(isBackpressureError(e), true, JSON.stringify(e));
    }
  });

  // Regression: hashing.js called aimd.onError() on EVERY per-file failure. Since
  // the controller halves unconditionally, a Drive containing a handful of
  // undecodable or corrupt images dragged the whole scan down to concurrency 1 —
  // and climbing back needs five consecutive successes per step. A file the
  // browser cannot decode says nothing about how hard we are hitting Drive.
  test("does NOT back off on per-file failures unrelated to load", () => {
    for (const e of [
      { code: "UNDECODABLE", message: "The source image could not be decoded." },
      { name: "InvalidStateError", message: "The source image could not be decoded." },
      { status: 404, message: "Drive API error 404: File not found" },
      { status: 403, message: "Drive API error 403: Insufficient permissions" },
      { message: "The browser could not encode the cropped image" },
      {},
    ]) {
      assert.equal(isBackpressureError(e), false, JSON.stringify(e));
    }
  });

  test("isThrottleError is narrower: rate limiting only, not 5xx or network", () => {
    assert.equal(isThrottleError({ status: 429 }), true);
    assert.equal(isThrottleError({ status: 503 }), false);
    assert.equal(isThrottleError({ code: "NETWORK" }), false);
    // Both still back off; only the stat and the log wording differ.
    assert.equal(isBackpressureError({ status: 503 }), true);
  });

  test("a 429 buried in a Drive error body still counts", () => {
    assert.equal(
      isBackpressureError({ message: 'Drive API error 429: {"error":{"code":429}}' }),
      true
    );
  });
});
