/*
 * Drive Dupe Destroyer (DDD) — test/variant-matching.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// #88: variant and rotation matching never got a pair to compare.
//
// bestDist has always compared A's variants against B and B's against A. The
// LSH index was built from, and queried with, the BASE hash only -- and a
// rotated or mirrored copy shares no dHash bands with its original, which is
// the whole premise. So the pair was never offered as a candidate and that
// comparison was never reached.
//
// #89 also lives here: the similarity percentage has to be computed in the
// space the distance was measured in.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runMatching } from "../js/matcher.js";
import { SIMILARITY_BITS, bestDist, distToPercent } from "../js/distance.js";
import { cacheRecordNeedsRecompute } from "../js/scan.js";
import { HASH_VERSION } from "../js/hashing.js";

const rnd = (seed, n) => {
  const h = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; h[i] = (x >>> 16) & 0xff; }
  return h;
};

// An image and the same image re-saved rotated. The four rotation hashes are
// h0 h90 h180 h270; the original's base is h0 with the other three as variants,
// the rotated copy's base is h90 with h180 h270 h0 as its variants.
//
// That closure is what makes the candidate search symmetric, and it is why the
// forward-only `ci <= i` guard in the matching loop stays correct: the flips are
// involutions and the rotations form a cycle, so whichever of the pair comes
// first in the ordering can still reach the other through one of its own
// variant hashes. A one-sided fixture would pass or fail for the wrong reason.
const H = [0, 1, 2, 3].map((k) => rnd(100 + k, 18));
const H8 = [0, 1, 2, 3].map((k) => rnd(200 + k, 8));
const rotatedBy = (start) => ({
  base12: H[start],
  base8: H8[start],
  variants: [1, 2, 3].map((k) => ({ base12: H[(start + k) % 4], base8: H8[(start + k) % 4] })),
});

async function groupCount(entries, opts) {
  const groups = [];
  await runMatching({
    entries, hamThresh: 2, lshForceMode: "loose",
    allIds: [...entries.keys()], onGroups: (p) => groups.push(...p.batch), ...opts,
  });
  return groups.length;
}

describe("rotated and mirrored copies are offered as candidates", () => {
  const O = rotatedBy(0);
  const R = rotatedBy(1);

  test("the fixture really is a variant-only match", () => {
    assert.ok(bestDist(O, R, false, true) > 2, "the base hashes must be far apart");
    assert.equal(bestDist(O, R, true, true), 0, "and the variants must agree exactly");
  });

  test("with variants on, the pair groups", async () => {
    assert.equal(await groupCount(new Map([["o", O], ["r", R]]), { withVariants: true }), 1);
  });

  test("with variants off, it does not", async () => {
    assert.equal(await groupCount(new Map([["o", O], ["r", R]]), { withVariants: false }), 0);
  });

  // Order matters: the loop only compares forward, so if the candidate could be
  // reached from one side only, whichever entry came second would skip it.
  test("it groups regardless of which copy is seen first", async () => {
    assert.equal(await groupCount(new Map([["r", R], ["o", O]]), { withVariants: true }), 1);
  });

  test("an entry with no variants is unaffected", async () => {
    const plain = (e) => ({ base12: e.base12, base8: e.base8 });
    assert.equal(await groupCount(new Map([["o", plain(O)], ["r", plain(R)]]), { withVariants: true }), 0);
  });
});

describe("the hash cache and variants", () => {
  const base = {
    hv: HASH_VERSION,
    base8: new Uint8Array(8),
    base12: new Uint8Array(18),
    colorHist: new Uint8Array(4),
    edgeHist: new Uint8Array(4),
  };
  const withN = (n) => ({ ...base, variants: Array.from({ length: n }, () => ({})) });

  test("a record with no variants cannot serve a run that wants them", () => {
    assert.equal(cacheRecordNeedsRecompute(withN(0), { withVariants: true }), true);
    assert.equal(cacheRecordNeedsRecompute(base, { withRotation: true }), true);
  });

  // Two flips and three rotations are requested by separate checkboxes, so a
  // record cached with only the flips cannot serve a run that also wants the
  // rotations. A plain "has some variants" check would have missed this.
  test("a record with only the flips cannot serve a run that wants rotations too", () => {
    assert.equal(cacheRecordNeedsRecompute(withN(2), { withVariants: true }), false);
    assert.equal(cacheRecordNeedsRecompute(withN(2), { withVariants: true, withRotation: true }), true);
    assert.equal(cacheRecordNeedsRecompute(withN(5), { withVariants: true, withRotation: true }), false);
    assert.equal(cacheRecordNeedsRecompute(withN(3), { withRotation: true }), false);
  });

  test("a run that wants no variants does not care what is cached", () => {
    assert.equal(cacheRecordNeedsRecompute(withN(0), {}), false);
    assert.equal(cacheRecordNeedsRecompute(base, {}), false);
  });
});

describe("the similarity percentage matches the distance it describes", () => {
  // #89: bestDist is called with use12 = true in the matcher, the results table
  // and the export, so the distance is always over 144 bits. The percentage
  // used to be computed from the "Hash size" select instead.
  test("SIMILARITY_BITS is the width comparisons are actually made over", () => {
    assert.equal(SIMILARITY_BITS, 144);
    const a = { base12: rnd(1, 18) };
    const b = { base12: new Uint8Array(rnd(1, 18)) };
    b.base12[0] ^= 0x0f;
    const d = bestDist(a, b, false, true);
    assert.equal(d, 4, "a four-bit difference, measured over the 144-bit hash");
    assert.equal(distToPercent(d, SIMILARITY_BITS), 97);
  });

  test("the old 64-bit figure was a different, wrong answer for the same pair", () => {
    assert.notEqual(distToPercent(6, 64), distToPercent(6, SIMILARITY_BITS));
    // Anything past 64 bits apart clamped up from a negative percentage.
    assert.equal(distToPercent(67, 64), 0);
    assert.equal(distToPercent(67, SIMILARITY_BITS), 53);
  });

  test("distToPercent defaults to the same width", () => {
    assert.equal(distToPercent(10), distToPercent(10, SIMILARITY_BITS));
  });
});
