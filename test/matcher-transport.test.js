/*
 * Drive Dupe Destroyer (DDD) — test/matcher-transport.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// What actually reaches the matcher (#84, #86).
//
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runMatching, packEntries, unpackEntries, OPTIONAL_ENTRY_FIELDS } from "../js/matcher.js";
import { bestCropDist, bestDist, pHashDistance } from "../js/distance.js";
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

  // #86: crop detection finds its candidates through the colour/edge histograms,
  // because a crop shares no dHash bands with its original. A record cached by a
  // run that had colour matching off therefore cannot serve a crop-detect run.
  test("crop detection also requires the histograms it finds candidates with", () => {
    const { colorHist, edgeHist, ...noHist } = full;
    assert.equal(cacheRecordNeedsRecompute(noHist, { withCropDetect: true }), true);
    assert.equal(cacheRecordNeedsRecompute(noHist, { withCropDetect: false, withColorMatch: false }), false);
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

// ---------------------------------------------------------------------------
// The check that would have caught both #84 and #86
// ---------------------------------------------------------------------------
//
// Both bugs were the same shape: the hasher computed a field, a comparator read
// it, and the worker payload did not carry it -- so the feature ran, compared
// undefined against undefined, and silently returned "no match". Neither was
// visible from any single file.
//
// So assert the relationship directly. Read what the comparators actually reach
// for on an entry, and require the transport to carry all of it. Over-inclusive
// by design: a field named in a comment counts as read, which can only make
// this stricter, never let a real omission through.

describe("the worker payload carries every field the comparators read", () => {
  // The comparators moved to js/distance.js when common.js was split (#121).
  const distanceSrc = readFileSync(
    fileURLToPath(new URL("../js/distance.js", import.meta.url)), "utf8"
  );

  const fieldsRead = new Set();
  for (const m of distanceSrc.matchAll(/\bentry[AB]\.([A-Za-z_$][\w$]*)/g)) fieldsRead.add(m[1]);

  // base12 and base8 ride in the flat buffers, not the extras map.
  const PACKED_IN_BUFFERS = ["base12", "base8"];

  test("the scan of distance.js found the fields we expect", () => {
    // A guard on the guard: if this regex ever stops matching, the test below
    // would pass vacuously.
    assert.ok(fieldsRead.size >= 6, `expected several fields, found ${[...fieldsRead]}`);
    for (const f of PACKED_IN_BUFFERS) assert.ok(fieldsRead.has(f), `expected to see ${f}`);
  });

  test("every field a comparator reads is either packed or carried in extras", () => {
    const carried = new Set([...PACKED_IN_BUFFERS, ...OPTIONAL_ENTRY_FIELDS]);
    const missing = [...fieldsRead].filter((f) => !carried.has(f));
    assert.deepEqual(
      missing, [],
      `distance.js reads ${missing.join(", ")} but packEntries does not carry it — ` +
      `that feature will silently find nothing in the worker (#84, #86)`
    );
  });

  test("and every carried field actually survives a round trip", () => {
    const e = { base12: new Uint8Array(18).fill(1), base8: new Uint8Array(8).fill(2) };
    for (const f of OPTIONAL_ENTRY_FIELDS) {
      e[f] = f === "cropHashes" ? [{ name: "center", hash: new Uint8Array(18).fill(3) }]
           : f === "variants"   ? [{ base8: new Uint8Array(8), base12: new Uint8Array(18) }]
           : new Uint8Array(8).fill(4);
    }
    const out = unpackEntries(viaPostMessage(packEntries(new Map([["x", e]])).payload)).get("x");
    for (const f of OPTIONAL_ENTRY_FIELDS) {
      assert.ok(out[f], `${f} must survive packEntries -> postMessage -> unpackEntries`);
    }
  });
});

// ---------------------------------------------------------------------------
// Crop detection (#86)
// ---------------------------------------------------------------------------

describe("crop detection reaches the matcher and can find a candidate", () => {
  const rnd = (seed, n) => {
    const h = new Uint8Array(n);
    let x = (seed * 2654435761) >>> 0;
    for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; h[i] = (x >>> 16) & 0xff; }
    return h;
  };
  // A photo and a crop of it: dHash unrelated, but the crop's own hash equals
  // the original's centre-region hash, and the colour/edge profile survives.
  const colorHist = new Uint8Array(32).fill(100);
  const edgeHist = new Uint8Array(16).fill(50);
  const nudge = (a) => { const b = new Uint8Array(a); b[0] = Math.min(255, b[0] + 2); return b; };
  const centre = rnd(7, 18);
  const A = { base12: rnd(1, 18), base8: rnd(1, 8), colorHist, edgeHist,
              cropHashes: [{ name: "center", hash: centre }] };
  const B = { base12: centre, base8: rnd(2, 8), colorHist: nudge(colorHist), edgeHist: nudge(edgeHist),
              cropHashes: [{ name: "center", hash: rnd(9, 18) }] };

  const cropGroups = (entries, withColorMatch) => {
    const groups = [];
    return runMatching({
      entries, hamThresh: 8, withCropDetect: true, withColorMatch,
      lshForceMode: "loose", allIds: [...entries.keys()],
      onGroups: (p) => groups.push(...p.batch),
    }).then(() => groups.length);
  };

  test("the fixture really is a crop-only match", () => {
    assert.equal(bestDist(A, B, false, true) > 8, true, "dHash alone must reject it");
    assert.equal(bestCropDist(A, B), 0, "the crop hashes must agree exactly");
  });

  test("cropHashes survives the trip to the worker", () => {
    const out = unpackEntries(viaPostMessage(packEntries(new Map([["a", A]])).payload));
    assert.ok(out.get("a").cropHashes, "not carried at all before #86");
    assert.equal(out.get("a").cropHashes[0].name, "center");
  });

  test("the worker path finds the same group the main thread does", async () => {
    const direct = new Map([["a", A], ["b", B]]);
    const packed = unpackEntries(viaPostMessage(packEntries(direct).payload));
    assert.equal(await cropGroups(direct, true), 1, "main-thread path groups the crop");
    assert.equal(await cropGroups(packed, true), 1, "and so must the worker path");
  });

  // The second half of #86: a crop shares no dHash bands with its original, so
  // without the widened candidate search the pair is never compared at all --
  // and the widening used to require colour matching to be ticked as well.
  test("crop detection works on its own, without colour matching ticked", async () => {
    assert.equal(await cropGroups(new Map([["a", A], ["b", B]]), false), 1);
  });

  test("a pair with no crop hashes is left alone", async () => {
    const strip = (e) => ({ base12: e.base12, base8: e.base8, colorHist: e.colorHist, edgeHist: e.edgeHist });
    assert.equal(await cropGroups(new Map([["a", strip(A)], ["b", strip(B)]]), false), 0);
  });
});
