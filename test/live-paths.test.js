/*
 * Drive Dupe Destroyer (DDD) — test/live-paths.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// #91: folder paths for live groups, resolved while matching runs.
//
// The keeper is the one file NOT offered for deletion, and the folder-priority
// rule ranks on the resolved path. Paths used to arrive only in phase 4, so for
// the whole time the live table was the thing the user could act on, that rule
// had no data and the keeper was picked by tie-break — then silently changed
// when the scan finished.
//
// The render side of this is tools/live-keeper.mjs, which drives the real table.
// Here: the queue that feeds it. Matches arrive in bursts and groups are
// re-emitted as they grow, so batching and de-duplication are what keep this
// from becoming a request per group per growth step.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { makeLivePathResolver } from "../js/scan.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stands in for buildPathsParallel; records what it was asked for. */
function recordingBuilder({ delayMs = 0, fail = false } = {}) {
  const calls = [];
  const build = async (files) => {
    calls.push(files.map((f) => f.id));
    if (delayMs) await tick(delayMs);
    if (fail) throw new Error("path lookup failed");
    return new Map(files.map((f) => [f.id, "/My Drive/" + f.id]));
  };
  return { build, calls };
}

const file = (id) => ({ id, name: id + ".jpg" });

describe("live path resolver", () => {
  test("a burst of groups becomes one batch", async () => {
    const { build, calls } = recordingBuilder();
    const got = [];
    const r = makeLivePathResolver({ onResolved: (e) => got.push(e), debounceMs: 20, build });

    r.enqueue([file("a"), file("b")]);
    r.enqueue([file("c")]);
    r.enqueue([file("d")]);
    await tick(80);
    r.stop();

    assert.equal(calls.length, 1, "three enqueues inside the debounce window are one request");
    assert.deepEqual(calls[0].sort(), ["a", "b", "c", "d"]);
    assert.equal(got.length, 1);
    assert.deepEqual(new Map(got[0]).get("a"), "/My Drive/a");
  });

  // Groups are re-emitted as they grow, so the same file arrives many times.
  // Without this the resolver would re-request a path it already has, which is
  // the behaviour the phase-4 resolver was moved earlier to avoid.
  test("a file already resolved is never requested twice", async () => {
    const { build, calls } = recordingBuilder();
    const r = makeLivePathResolver({ onResolved: () => {}, debounceMs: 20, build });

    r.enqueue([file("a"), file("b")]);
    await tick(60);
    r.enqueue([file("a"), file("b"), file("c")]);   // the group grew
    await tick(60);
    r.stop();

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ["c"], "only the new file is looked up");
  });

  test("batches never overlap", async () => {
    const { build, calls } = recordingBuilder({ delayMs: 60 });
    let inFlight = 0, maxInFlight = 0;
    const counting = async (files, opts) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await build(files, opts); } finally { inFlight--; }
    };
    const r = makeLivePathResolver({ onResolved: () => {}, debounceMs: 10, build: counting });

    r.enqueue([file("a")]);
    await tick(30);
    r.enqueue([file("b")]);
    await tick(30);
    r.enqueue([file("c")]);
    await tick(200);
    r.stop();

    assert.equal(maxInFlight, 1, "a second batch must wait for the first");
    assert.ok(calls.length >= 2);
  });

  // Phase 4 resolves these paths regardless. This only changes WHEN they
  // arrive, so a failure here must be invisible rather than fatal.
  test("a failed batch is swallowed and does not stop later ones", async () => {
    const failing = recordingBuilder({ fail: true });
    const got = [];
    const r = makeLivePathResolver({ onResolved: (e) => got.push(e), debounceMs: 10, build: failing.build });

    r.enqueue([file("a")]);
    await tick(60);
    assert.equal(got.length, 0, "nothing reported for a batch that threw");

    r.enqueue([file("b")]);
    await tick(60);
    r.stop();
    assert.equal(failing.calls.length, 2, "the resolver keeps going");
  });

  test("stop() halts a pending batch", async () => {
    const { build, calls } = recordingBuilder();
    const r = makeLivePathResolver({ onResolved: () => {}, debounceMs: 40, build });

    r.enqueue([file("a")]);
    r.stop();
    await tick(100);

    assert.equal(calls.length, 0, "the debounce timer must not fire after stop");
    r.enqueue([file("b")]);
    await tick(100);
    assert.equal(calls.length, 0, "and nothing new is accepted either");
  });

  test("with no callback it is an inert stub", async () => {
    const { build, calls } = recordingBuilder();
    const r = makeLivePathResolver({ debounceMs: 10, build });
    r.enqueue([file("a")]);
    await tick(50);
    r.stop();
    assert.equal(calls.length, 0, "no consumer means no requests");
  });
});
