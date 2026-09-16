/*
 * Drive Dupe Destroyer (DDD) — test/thumb-budget.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// #126: the thumbnail budget scales to the device, and only downwards.
//
// The point of pulling this out as a pure function is that the policy is the
// risky part, not the plumbing: a formula that scaled the wrong way, or that
// quietly lowered the budget on browsers which report nothing, would be a
// regression nobody would notice until a results table started re-fetching
// every thumbnail on a desktop.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { thumbBudgetBytes } from "../js/hashing.js";
import { isBackpressureError, isMemoryPressureError } from "../js/errors.js";

const MB = 1024 * 1024;

describe("thumbnail budget (#126)", () => {
  test("a browser that does not report deviceMemory keeps the old behaviour", () => {
    // Safari and Firefox report nothing. Lowering their budget on no evidence
    // would be swapping one guess for another, so they get exactly 192 MB.
    for (const v of [undefined, null, 0, NaN, "", "banana"]) {
      assert.equal(thumbBudgetBytes(v), 192 * MB, `deviceMemory=${String(v)}`);
    }
  });

  test("8 GB and above is the old value — this never scales up", () => {
    assert.equal(thumbBudgetBytes(8), 192 * MB);
    // deviceMemory is capped at 8 by the spec, but a larger value must not
    // produce a larger budget.
    assert.equal(thumbBudgetBytes(16), 192 * MB);
    assert.equal(thumbBudgetBytes(64), 192 * MB);
  });

  test("a small device gets a proportionally smaller budget", () => {
    assert.equal(thumbBudgetBytes(4), 96 * MB);
    assert.equal(thumbBudgetBytes(2), 48 * MB);
  });

  test("and never less than the floor, however small the device claims to be", () => {
    for (const v of [1, 0.5, 0.25]) {
      assert.equal(thumbBudgetBytes(v), 48 * MB, `deviceMemory=${v}`);
    }
  });

  test("the budget is monotonic in device memory", () => {
    const steps = [0.25, 0.5, 1, 2, 4, 8];
    for (let i = 1; i < steps.length; i++) {
      assert.ok(thumbBudgetBytes(steps[i]) >= thumbBudgetBytes(steps[i - 1]),
        `${steps[i]} GB gave less than ${steps[i - 1]} GB`);
    }
  });
});

describe("memory pressure is not backpressure (#126)", () => {
  // AIMDController's doc comment has always said "call on 429, timeout, or
  // OOM", but nothing detected an OOM to call it with, and the two need
  // opposite responses: backpressure means send fewer requests, memory
  // pressure means hold less.
  test("the OOM shapes browsers actually throw are recognised", () => {
    const oom = [
      new RangeError("Array buffer allocation failed"),
      new Error("Out of memory"),
      new Error("Failed to execute 'createImageBitmap': insufficient resources"),
      new Error("QuotaExceededError"),
    ];
    for (const e of oom) {
      assert.ok(isMemoryPressureError(e), `not detected: ${e.message}`);
    }
  });

  test("network backpressure is not mistaken for it, or the app would hold less when it should send less", () => {
    const net = [
      Object.assign(new Error("rate limit exceeded"), { status: 429 }),
      Object.assign(new Error("Internal Server Error"), { status: 503 }),
      new Error("request timed out"),
    ];
    for (const e of net) {
      assert.ok(isBackpressureError(e), `should be backpressure: ${e.message}`);
      assert.ok(!isMemoryPressureError(e), `wrongly treated as OOM: ${e.message}`);
    }
  });

  test("an ordinary decode failure is neither", () => {
    const e = new Error("The source image cannot be decoded");
    assert.ok(!isMemoryPressureError(e));
    assert.ok(!isBackpressureError(e));
  });
});
