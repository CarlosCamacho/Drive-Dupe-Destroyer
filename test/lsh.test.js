/*
 * Drive Dupe Destroyer (DDD) — test/lsh.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Locality-sensitive hashing decides which pairs are compared AT ALL.
//
// That makes its failures invisible: a pair the index never surfaces as a
// candidate is never evaluated, so the user just sees fewer duplicates, with no
// error and nothing in the console. Worth testing for exactly that reason.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildLshIndex,
  buildAutoTunedLshIndex,
  makeLshConfig,
  lshCandidates,
} from "../js/lsh.js";

/** Deterministic 18-byte (144-bit) hashes. */
function hash(seed, { flipByte = null } = {}) {
  const b = new Uint8Array(18);
  for (let j = 0; j < 18; j++) b[j] = (seed * 31 + j * 17) & 0xff;
  if (flipByte !== null) b[flipByte] ^= 0x01;
  return b;
}

function corpus(n) {
  const m = new Map();
  for (let i = 0; i < n; i++) {
    const b = hash(i);
    m.set("id" + i, { base12: b, base8: b.slice(0, 8) });
  }
  return m;
}

// ---------------------------------------------------------------------------
// The mode dropdown
// ---------------------------------------------------------------------------

describe("buildAutoTunedLshIndex forceMode", () => {
  // Regression: forceMode was handed to buildAdaptiveLshIndex, which has no
  // sensitivity parameter — it derives one from dataset size. So loose, normal
  // and strict all produced the SAME band configuration and the UI dropdown
  // did nothing at all.
  test("each mode produces a distinct band configuration", () => {
    const entries = corpus(300);
    const shape = (forceMode) => {
      const idx = buildAutoTunedLshIndex(entries, { use12: true, targetThreshold: 10, forceMode });
      return `${idx.config.bands}x${idx.config.rowsPerBand}`;
    };

    const loose = shape("loose");
    const normal = shape("normal");
    const strict = shape("strict");

    assert.notEqual(loose, normal, "loose and normal must differ");
    assert.notEqual(normal, strict, "normal and strict must differ");
    assert.notEqual(loose, strict, "loose and strict must differ");
  });

  test("the forced mode is the one reported, and auto-tuning is off", () => {
    const entries = corpus(300);
    for (const mode of ["loose", "normal", "strict"]) {
      const idx = buildAutoTunedLshIndex(entries, { use12: true, targetThreshold: 10, forceMode: mode });
      assert.equal(idx.sensitivity, mode);
      assert.equal(idx.autoTuned, false);
    }
  });

  test("forced configs match LSH_CONFIGS for 144-bit hashes", () => {
    const entries = corpus(300);
    const expected = {
      loose:  { bands: 12, rowsPerBand: 1 },
      normal: { bands: 6,  rowsPerBand: 3 },
      strict: { bands: 4,  rowsPerBand: 4 },
    };
    for (const [mode, want] of Object.entries(expected)) {
      const idx = buildAutoTunedLshIndex(entries, { use12: true, targetThreshold: 10, forceMode: mode });
      assert.equal(idx.config.bands, want.bands, `${mode} bands`);
      assert.equal(idx.config.rowsPerBand, want.rowsPerBand, `${mode} rowsPerBand`);
    }
  });

  test("auto still auto-tunes rather than being treated as a forced mode", () => {
    const idx = buildAutoTunedLshIndex(corpus(300), { use12: true, targetThreshold: 10, forceMode: "auto" });
    assert.equal(idx.autoTuned, true);
  });

  test("an unrecognised mode falls back to normal instead of throwing", () => {
    const idx = buildAutoTunedLshIndex(corpus(300), { use12: true, targetThreshold: 10, forceMode: "nonsense" });
    assert.equal(idx.sensitivity, "normal");
  });
});

// ---------------------------------------------------------------------------
// Recall — the property that actually matters
// ---------------------------------------------------------------------------

describe("candidate recall", () => {
  test("an identical hash is always a candidate", () => {
    const entries = corpus(50);
    const twin = entries.get("id7").base12.slice();
    entries.set("twin", { base12: twin, base8: twin.slice(0, 8) });

    const idx = buildLshIndex(entries, { use12: true, sensitivity: "normal" });
    const cands = lshCandidates(idx, "twin", { base12: twin });
    assert.ok(cands.has("id7"), "a byte-identical hash must surface as a candidate");
  });

  test("loose surfaces at least as many candidates as strict", () => {
    const entries = corpus(400);
    const probe = entries.get("id10");

    const nLoose = lshCandidates(
      buildLshIndex(entries, { use12: true, sensitivity: "loose" }), "id10", probe).size;
    const nStrict = lshCandidates(
      buildLshIndex(entries, { use12: true, sensitivity: "strict" }), "id10", probe).size;

    assert.ok(nLoose >= nStrict, `loose (${nLoose}) must not surface fewer than strict (${nStrict})`);
  });

  test("a hash differing by one bit is still found under loose", () => {
    const entries = corpus(60);
    const near = hash(7, { flipByte: 3 });
    entries.set("near", { base12: near, base8: near.slice(0, 8) });

    const idx = buildLshIndex(entries, { use12: true, sensitivity: "loose" });
    const cands = lshCandidates(idx, "near", { base12: near });
    assert.ok(cands.has("id7"), "a 1-bit difference must not be filtered out by loose LSH");
  });

  test("an entry never returns itself", () => {
    const entries = corpus(30);
    const idx = buildLshIndex(entries, { use12: true, sensitivity: "normal" });
    assert.ok(!lshCandidates(idx, "id5", entries.get("id5")).has("id5"));
  });

  test("a missing or empty hash yields no candidates rather than throwing", () => {
    const idx = buildLshIndex(corpus(20), { use12: true, sensitivity: "normal" });
    assert.equal(lshCandidates(idx, "x", {}).size, 0);
    assert.equal(lshCandidates(idx, "x", { base12: new Uint8Array(0) }).size, 0);
  });
});

// ---------------------------------------------------------------------------
// Band construction
// ---------------------------------------------------------------------------

describe("makeLshConfig", () => {
  test("band indices stay inside the hash", () => {
    for (const bits of [64, 144]) {
      for (const sens of ["loose", "normal", "strict"]) {
        const cfg = makeLshConfig(bits, sens);
        for (const band of cfg.bandIndices) {
          for (const i of band) {
            assert.ok(i >= 0 && i < cfg.byteLen, `${bits}/${sens}: index ${i} outside 0..${cfg.byteLen - 1}`);
          }
        }
      }
    }
  });

  test("no band samples the same byte twice", () => {
    for (const bits of [64, 144]) {
      for (const sens of ["loose", "normal", "strict"]) {
        for (const band of makeLshConfig(bits, sens).bandIndices) {
          assert.equal(new Set(band).size, band.length, `${bits}/${sens}: duplicate byte within a band`);
        }
      }
    }
  });

  test("an unknown sensitivity falls back rather than producing an empty config", () => {
    const cfg = makeLshConfig(144, "nonsense");
    assert.ok(cfg.bands > 0 && cfg.rowsPerBand > 0);
  });
});
