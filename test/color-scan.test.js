/*
 * Drive Dupe Destroyer (DDD) — test/color-scan.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The crop+colour candidate widening in scan.js. See #65.
//
// It used to scan up to 2,000 array neighbours in each direction — 4,000
// comparisons per image on the main thread — over an ordering (position in a
// Map's key list) that has nothing to do with similarity. It now sorts by the
// luminance signature the pre-filter reads and walks the contiguous run that
// could plausibly pass, with a cap.
//
// Two properties are asserted, and the second only because the first version of
// this fix failed it: the run must contain every pair the filter would accept,
// AND the work must not grow faster than what it replaced. A bucket-index
// version was lossless but measured 2x WORSE at 20,000 images, which is why the
// shipped version is a sorted run with a bound.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCAN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "js", "scan.js"), "utf8");

const LUM_LIMIT = 200;
const SCAN_CAP = 400;

const lumOf = (h) => { let l = 0; for (let b = 24; b < 32; b++) l += h[b]; return l; };
const colorDiff = (x, y) => { let d = 0; for (let b = 24; b < 32; b++) d += Math.abs(x[b] - y[b]); return d; };

function hist(bins) {
  const h = new Uint16Array(32);
  for (let i = 0; i < 8; i++) h[24 + i] = bins[i] ?? 0;
  return h;
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Clusters of near-identical images spread across a wide brightness range —
// what a real library looks like. Independent uniform noise in every bin, which
// an earlier version of this test used, produces almost no acceptable pairs at
// all and so cannot detect loss.
function corpus(seed, n) {
  const rand = rng(seed);
  const out = [];
  while (out.length < n) {
    const base = Array.from({ length: 8 }, () => Math.floor(rand() * 900));
    const copies = 1 + Math.floor(rand() * 4);
    for (let c = 0; c < copies && out.length < n; c++) {
      out.push(hist(base.map(v => Math.max(0, v + Math.floor((rand() - 0.5) * 40)))));
    }
  }
  return out;
}

// The shipped walk, reproduced: sort by luminance, step outward alternating
// sides while within LUM_LIMIT, stop at the cap.
function walk(items, cap = SCAN_CAP) {
  const sorted = items.map((h, i) => ({ i, lum: lumOf(h) })).sort((a, b) => a.lum - b.lum);
  const pos = new Map(sorted.map((x, idx) => [x.i, idx]));
  let visits = 0;
  const reached = new Map();
  for (let i = 0; i < items.length; i++) {
    const centre = pos.get(i), myLum = sorted[centre].lum;
    const seen = new Set();
    let visited = 0;
    for (let step = 1; visited < cap; step++) {
      const l = centre - step, r = centre + step;
      const lIn = l >= 0 && myLum - sorted[l].lum < LUM_LIMIT;
      const rIn = r < sorted.length && sorted[r].lum - myLum < LUM_LIMIT;
      if (!lIn && !rIn) break;
      for (const side of [lIn ? l : -1, rIn ? r : -1]) {
        if (side < 0) continue;
        visited++; visits++;
        seen.add(sorted[side].i);
      }
    }
    reached.set(i, seen);
  }
  return { visits, reached };
}

// What the old code did: min(n, 2000) array neighbours each way.
function positionalVisits(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.min(n, 2000);
    total += Math.min(n, i + w) - Math.max(0, i - w) - 1;
  }
  return total;
}

describe("crop+colour candidate widening", () => {
  test("the constants here match the ones scan.js uses", () => {
    assert.match(SCAN, new RegExp(`COLOR_LUM_LIMIT = ${LUM_LIMIT}\\b`));
    assert.match(SCAN, new RegExp(`COLOR_SCAN_CAP = ${SCAN_CAP}\\b`));
    assert.match(SCAN, /colorDiff >= 200/, "the pre-filter threshold the limit is derived from");
  });

  test("the luminance limit is implied by the pre-filter, not chosen freely", () => {
    // |lum(a) - lum(b)| <= sum|a[b] - b[b]|, so a pair the filter accepts
    // (sum < 200) always has a luminance gap under 200.
    const rand = rng(3);
    for (let t = 0; t < 4000; t++) {
      const a = hist(Array.from({ length: 8 }, () => Math.floor(rand() * 900)));
      const b = hist(Array.from({ length: 8 }, () => Math.floor(rand() * 900)));
      if (colorDiff(a, b) < 200) {
        assert.ok(Math.abs(lumOf(a) - lumOf(b)) < LUM_LIMIT,
          "a pair inside the filter fell outside the luminance window");
      }
    }
  });

  test("with the cap lifted, the walk reaches every pair the filter would accept", () => {
    const items = corpus(20260914, 600);
    const { reached } = walk(items, Infinity);
    let accepted = 0, missed = 0;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (colorDiff(items[i], items[j]) >= 200) continue;
        accepted++;
        if (!reached.get(i).has(j)) missed++;
      }
    }
    assert.ok(accepted > 100, `expected plenty of acceptable pairs, got ${accepted}`);
    assert.equal(missed, 0, `${missed} of ${accepted} acceptable pairs were outside the walked run`);
  });

  test("work stays below the positional scan at every size, including large ones", () => {
    // The version this replaced was capped per image, so it could only be beaten
    // by something also capped. A bucket index was not, and was 2x worse at
    // 20,000 images — that regression is what this test exists to prevent.
    const rows = [];
    for (const n of [2000, 5000, 10000, 20000]) {
      const { visits } = walk(corpus(7, n));
      const old = positionalVisits(n);
      rows.push({ n, old, visits, ratio: +(visits / old).toFixed(2) });
    }
    for (const r of rows) {
      console.log(`      n=${String(r.n).padStart(6)}  positional ${String(r.old).padStart(11)}  walk ${String(r.visits).padStart(11)}  ratio ${r.ratio}`);
    }
    for (const r of rows) {
      assert.ok(r.ratio <= 1, `at n=${r.n} the walk does ${r.ratio}x the work of the scan it replaced`);
    }
    // And it must actually help, not merely tie.
    assert.ok(rows.some(r => r.ratio < 0.8), "no size showed a meaningful reduction");
  });
});
