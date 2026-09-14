/*
 * Drive Dupe Destroyer (DDD) — test/matcher.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Pins the behaviour of the pair-matching core.
//
// This exists BEFORE the worker port, not after. #69 said the port had to be
// provable rather than plausible, and that only works if the behaviour being
// ported is written down first — otherwise "the worker agrees with the worker"
// is all you can ever show.
//
// Everything here is ids and hashes. No Drive file objects reach the matcher.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runMatching } from "../js/matcher.js";

const BYTES_12 = 18;   // 144-bit dHash
const BYTES_8 = 8;     // 64-bit dHash

// A hash that is `flips` bits away from a base pattern, deterministically.
function hashFrom(seed, bytes, flips = 0) {
  const h = new Uint8Array(bytes);
  let s = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    h[i] = s & 0xff;
  }
  for (let f = 0; f < flips; f++) h[f % bytes] ^= 1 << (f % 8);
  return h;
}

const entry = (seed, flips = 0) => ({
  base12: hashFrom(seed, BYTES_12, flips),
  base8: hashFrom(seed, BYTES_8, flips === 0 ? 0 : 1),
});

// Build entries where ids sharing a seed are near-identical.
function corpus(spec) {
  const entries = new Map();
  for (const [id, seed, flips] of spec) entries.set(id, entry(seed, flips));
  return entries;
}

const idsOf = (groups) => groups.map(g => [...g].sort()).sort((a, b) => a[0] < b[0] ? -1 : 1);

describe("runMatching", () => {
  test("groups near-identical hashes and leaves distinct ones alone", async () => {
    const entries = corpus([
      ["a1", 11, 0], ["a2", 11, 2],      // 2 bits apart
      ["b1", 77, 0], ["b2", 77, 1],      // 1 bit apart
      ["c1", 999, 0],                     // alone
    ]);
    const out = await runMatching({ entries, hamThresh: 6 });
    assert.deepEqual(idsOf(out.groups), [["a1", "a2"], ["b1", "b2"]]);
    assert.ok(out.comparisons > 0, "it did compare something");
  });

  test("a threshold of zero groups only identical hashes", async () => {
    const entries = corpus([["x1", 5, 0], ["x2", 5, 0], ["x3", 5, 3]]);
    const out = await runMatching({ entries, hamThresh: 0 });
    assert.deepEqual(idsOf(out.groups), [["x1", "x2"]]);
  });

  test("transitivity: a~b and b~c puts all three in one group", async () => {
    const entries = corpus([["t1", 21, 0], ["t2", 21, 2], ["t3", 21, 4]]);
    const out = await runMatching({ entries, hamThresh: 6 });
    assert.deepEqual(idsOf(out.groups), [["t1", "t2", "t3"]]);
  });

  // The MD5 fast path seeds byte-identical files that were never hashed.
  test("exact groups are seeded even for ids with no hash at all", async () => {
    const entries = corpus([["p1", 3, 0], ["p2", 3, 1]]);
    const out = await runMatching({
      entries,
      allIds: ["p1", "p2", "raw1", "raw2"],     // raw* have no entry — unhashable formats
      exactGroupIds: [["raw1", "raw2"]],
      hamThresh: 6,
    });
    const got = idsOf(out.groups);
    assert.ok(got.some(g => g.join() === "raw1,raw2"), "an unhashable exact pair must still be grouped");
    assert.ok(got.some(g => g.join() === "p1,p2"));
  });

  test("a rejected pair is never grouped", async () => {
    const entries = corpus([["r1", 42, 0], ["r2", 42, 1]]);
    const keyOf = (id) => Array.from(entries.get(id).base12).join(",");
    const [ka, kb] = [keyOf("r1"), keyOf("r2")].sort();
    const out = await runMatching({ entries, hamThresh: 6, rejectedKeys: [`${ka}|${kb}`] });
    assert.deepEqual(out.groups, [], "the user said these are not duplicates");
  });

  test("the aspect pre-filter suppresses pairs with incompatible shapes", async () => {
    const entries = corpus([["s1", 8, 0], ["s2", 8, 1]]);
    const meta = new Map([
      ["s1", { imageMediaMetadata: { width: 4000, height: 3000 } }],   // 4:3
      ["s2", { imageMediaMetadata: { width: 1000, height: 3000 } }],   // 1:3
    ]);
    const withFilter = await runMatching({ entries, meta, hamThresh: 6, useAspectFilter: true, aspectTolerancePct: 5 });
    const without = await runMatching({ entries, meta, hamThresh: 6, useAspectFilter: false });
    assert.deepEqual(withFilter.groups, [], "shapes this different should not be compared");
    assert.equal(without.groups.length, 1, "and without the filter they group");
  });

  test("groups stream out progressively, not only at the end", async () => {
    const spec = [];
    for (let i = 0; i < 40; i++) spec.push([`f${i}`, 100 + Math.floor(i / 2), i % 2 ? 1 : 0]);
    const seen = [];
    const out = await runMatching({
      entries: corpus(spec), hamThresh: 6, emitInterval: 1,
      onGroups: ({ batch }) => { for (const b of batch) seen.push(b.group); },
    });
    assert.ok(seen.length > 0, "nothing was emitted while matching ran");
    assert.ok(out.groups.length >= 15, `expected ~20 pairs, got ${out.groups.length}`);
    for (const g of seen) {
      assert.ok(Array.isArray(g) && typeof g[0] === "string",
        "emitted groups must be arrays of IDS — file objects must never reach the matcher");
    }
  });

  test("shouldStop aborts rather than returning a partial answer", async () => {
    const spec = [];
    for (let i = 0; i < 200; i++) spec.push([`z${i}`, 500 + i, 0]);
    let calls = 0;
    await assert.rejects(
      () => runMatching({ entries: corpus(spec), hamThresh: 6, shouldStop: () => ++calls > 5 }),
      /Scan stopped/
    );
  });

  test("progress is reported against the number of hashed ids", async () => {
    const spec = [];
    for (let i = 0; i < 250; i++) spec.push([`g${i}`, 900 + i, 0]);
    const seen = [];
    await runMatching({ entries: corpus(spec), hamThresh: 4, onProgress: (done, total) => seen.push([done, total]) });
    assert.ok(seen.length > 0);
    assert.equal(seen[0][1], 250, "total should be the hashed id count");
  });

  test("an empty corpus produces no groups and does not throw", async () => {
    const out = await runMatching({ entries: new Map(), hamThresh: 6 });
    assert.deepEqual(out.groups, []);
    assert.equal(out.matches, 0);
  });

  test("the result is identical across runs — no dependence on iteration timing", async () => {
    const spec = [];
    for (let i = 0; i < 60; i++) spec.push([`d${i}`, 300 + Math.floor(i / 3), i % 3]);
    const a = await runMatching({ entries: corpus(spec), hamThresh: 6 });
    const b = await runMatching({ entries: corpus(spec), hamThresh: 6 });
    assert.deepEqual(idsOf(a.groups), idsOf(b.groups));
  });
});
