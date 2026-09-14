/*
 * Drive Dupe Destroyer (DDD) — test/phash-plumbing.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// #84: pHash mode did nothing, because the field changed name in transit.
//
// The hasher writes `pHashBits` and bestDistWithPHash reads `pHashBits`, but
// packEntries/unpackEntries carried `pHash` — a field nothing sets and nothing
// reads. Since #75 put matching in a worker, every run went through that pack,
// so the feature had no effect at all. The cache-hit path dropped it too.
//
// These tests follow the field end to end rather than asserting on its name in
// one place, because the bug was precisely that two places agreed on a name and
// the third did not.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runMatching, packEntries, unpackEntries } from "../js/matcher.js";
import { bestDist, pHashDistance } from "../js/common.js";
import { cacheRecordNeedsRecompute, entryFromCacheRecord } from "../js/scan.js";
import { HASH_VERSION } from "../js/hashing.js";

/**
 * An entry whose dHash differs from the baseline by `diffBytes` bytes -- close
 * enough that the LSH index still offers the pair as a candidate, far enough
 * that plain dHash rejects it at a threshold of 2. pHash is what has to rescue
 * it.
 */
function entry(diffBytes, pHashFill) {
  const base12 = new Uint8Array(18);
  const base8 = new Uint8Array(8);
  for (let i = 0; i < diffBytes; i++) base12[i] = 0xF0;
  for (let i = 0; i < Math.min(diffBytes, 8); i++) base8[i] = 0xF0;
  const pHashBits = new Uint8Array(8);
  pHashBits.fill(pHashFill);
  return { base12, base8, pHashBits };
}

/** structuredClone stand-in: postMessage copies, it does not share. */
function viaPostMessage(payload) {
  return JSON.parse(
    JSON.stringify(payload, (k, v) => (ArrayBuffer.isView(v) ? { __ta: [...v] } : v)),
    (k, v) => (v && v.__ta ? new Uint8Array(v.__ta) : v)
  );
}

async function groupCount(entries) {
  const groups = [];
  await runMatching({
    entries,
    hamThresh: 2,
    withPHash: true,
    allIds: [...entries.keys()],
    onGroups: (p) => groups.push(...p.batch),
  });
  return groups.length;
}

describe("pHash survives the trip to the match worker", () => {
  const A = entry(0, 0xAA);
  const B = entry(3, 0xAA);   // 12 dHash bits apart, identical pHash

  test("the fixture really is a pHash-only match", () => {
    assert.equal(bestDist(A, B, false, true), 12, "dHash alone must reject it at threshold 2");
    assert.equal(pHashDistance(A.pHashBits, B.pHashBits), 0, "pHash must accept it");
  });

  test("packEntries/unpackEntries carry pHashBits", () => {
    const { payload } = packEntries(new Map([["a", A], ["b", B]]));
    const out = unpackEntries(viaPostMessage(payload));
    assert.ok(out.get("a").pHashBits, "pHashBits must survive the transfer");
    assert.deepEqual([...out.get("a").pHashBits], [...A.pHashBits]);
  });

  // The regression, stated as the user would see it: the same images, the same
  // settings, grouped on one path and not the other.
  test("the worker path finds the same group the main thread does", async () => {
    const direct = new Map([["a", A], ["b", B]]);
    const { payload } = packEntries(direct);
    const packed = unpackEntries(viaPostMessage(payload));

    assert.equal(await groupCount(direct), 1, "main-thread path groups the pair");
    assert.equal(await groupCount(packed), 1, "and so must the worker path");
  });

  test("an entry with no pHash is still packed, and simply does not match", async () => {
    const C = entry(0, 0xAA); delete C.pHashBits;
    const D = entry(3, 0xAA); delete D.pHashBits;
    const { payload } = packEntries(new Map([["c", C], ["d", D]]));
    const out = unpackEntries(viaPostMessage(payload));
    assert.equal(out.get("c").pHashBits, undefined);
    assert.equal(await groupCount(out), 0, "without pHash the pair is 12 bits apart and must not group");
  });
});

describe("cacheRecordNeedsRecompute", () => {
  const full = {
    hv: HASH_VERSION,
    base8: new Uint8Array(8),
    base12: new Uint8Array(18),
    cropHashes: [{ name: "c", hash: new Uint8Array(18) }],
    colorHist: new Uint8Array(4),
    edgeHist: new Uint8Array(4),
    pHashBits: new Uint8Array(8),
  };

  test("a complete, current record is a hit", () => {
    assert.equal(cacheRecordNeedsRecompute(full, { withCropDetect: true, withColorMatch: true, withPHash: true }), false);
  });

  // The second half of #84: turning pHash on after a scan had already cached
  // the file never recomputed anything, so the feature could only ever apply to
  // files being hashed for the first time.
  test("turning pHash on forces a recompute of a record cached without it", () => {
    const { pHashBits, ...noPHash } = full;
    assert.equal(cacheRecordNeedsRecompute(noPHash, { withPHash: true }), true);
    assert.equal(cacheRecordNeedsRecompute(noPHash, { withPHash: false }), false, "and not when the feature is off");
  });

  test("the same rule already held for crop and colour", () => {
    const { cropHashes, ...noCrop } = full;
    const { colorHist, ...noColor } = full;
    assert.equal(cacheRecordNeedsRecompute(noCrop, { withCropDetect: true }), true);
    assert.equal(cacheRecordNeedsRecompute(noColor, { withColorMatch: true }), true);
  });

  test("a record from an older hashing scheme is a miss", () => {
    assert.equal(cacheRecordNeedsRecompute({ ...full, hv: HASH_VERSION - 1 }), true);
    assert.equal(cacheRecordNeedsRecompute({ ...full, hv: undefined }), true, "pre-versioning records count as v1");
  });

  test("an absent or hashless record is a miss", () => {
    assert.equal(cacheRecordNeedsRecompute(undefined), true);
    assert.equal(cacheRecordNeedsRecompute({}), true);
    assert.equal(cacheRecordNeedsRecompute({ hv: HASH_VERSION, base8: new Uint8Array(8) }), true);
  });
});

describe("entryFromCacheRecord", () => {
  test("restores every field the matcher can read", () => {
    const rec = {
      hv: HASH_VERSION,
      base8: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      base12: new Uint8Array(18).fill(9),
      variants: [{ base8: new Uint8Array(8).fill(2), base12: new Uint8Array(18).fill(3) }],
      cropHashes: [{ name: "center", hash: new Uint8Array(18).fill(4) }],
      colorHist: new Uint8Array([10, 20]),
      edgeHist: new Uint8Array([30, 40]),
      pHashBits: new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5]),
    };
    const e = entryFromCacheRecord(rec);
    assert.deepEqual([...e.base8], [...rec.base8]);
    assert.deepEqual([...e.base12], [...rec.base12]);
    assert.deepEqual([...e.pHashBits], [...rec.pHashBits], "the field #84 was about");
    assert.deepEqual([...e.colorHist], [...rec.colorHist]);
    assert.deepEqual([...e.edgeHist], [...rec.edgeHist]);
    assert.equal(e.variants.length, 1);
    assert.equal(e.cropHashes[0].name, "center");
  });

  test("absent optional fields come back as null, not undefined typed arrays", () => {
    const e = entryFromCacheRecord({ base8: new Uint8Array(8), base12: new Uint8Array(18) });
    assert.equal(e.pHashBits, null);
    assert.equal(e.colorHist, null);
    assert.equal(e.edgeHist, null);
    assert.equal(e.cropHashes, null);
    assert.deepEqual(e.variants, []);
  });
});
