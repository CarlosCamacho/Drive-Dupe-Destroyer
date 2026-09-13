/*
 * Drive Dupe Destroyer (DDD) — test/exporter.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The CSV/JSON export rows.
//
// This is a record people act on: the README presents export as "records before
// cleanup", and the JSON is the obvious thing to script a bulk delete against.
// A row labelled DUPLICATE that is actually the keeper costs someone an
// original, so the labelling is worth pinning down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildExportItems } from "../js/exporter.js";

/** Hash entries are Uint8Array; equal arrays mean distance 0. */
function entry(bytes) {
  return { base8: new Uint8Array(bytes.slice(0, 8)), base12: new Uint8Array(bytes) };
}

const SAME = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const NEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19]; // 1 byte differs
const FAR  = [255, 254, 253, 252, 251, 250, 249, 248, 247, 246, 245, 244, 243, 242, 241, 240, 239, 238];

function file(id, { w, h, size, md5, path } = {}) {
  const f = { id, name: `${id}.jpg`, size: String(size ?? 1000) };
  if (w && h) f.imageMediaMetadata = { width: w, height: h };
  if (md5) f.md5Checksum = md5;
  if (path) f._path = path;
  return f;
}

describe("buildExportItems", () => {
  // Regression: keepIdx came from `g.findIndex(f => f._isKeep)`, and nothing in
  // the codebase ever set _isKeep. findIndex returned -1, fi starts at 0, so
  // `fi === keepIdx` was never true -- every row exported as DUPLICATE,
  // including the file the app had decided to keep.
  test("exactly one row per group is marked KEEP", () => {
    const groups = [[
      file("big", { w: 4000, h: 3000 }),
      file("small", { w: 800, h: 600 }),
    ]];
    const items = buildExportItems(groups, new Map(), new Map(), { keepRule: "hires" });

    const keeps = items.filter(i => i.role === "KEEP");
    assert.equal(keeps.length, 1, "a group must nominate exactly one keeper");
    assert.equal(keeps[0].name, "big.jpg", "and it must be the one the keep rule picks");
    assert.equal(items.filter(i => i.role === "DUPLICATE").length, 1);
  });

  test("the KEEP row agrees with chooseKeepIndex for every rule", () => {
    const groups = [[
      file("older", { w: 100, h: 100, size: 10 }),
      file("bigger", { w: 100, h: 100, size: 9999 }),
    ]];
    const largest = buildExportItems(groups, new Map(), new Map(), { keepRule: "largest" });
    assert.equal(largest.find(i => i.role === "KEEP").name, "bigger.jpg");

    const smallest = buildExportItems(groups, new Map(), new Map(), { keepRule: "smallest" });
    assert.equal(smallest.find(i => i.role === "KEEP").name, "older.jpg");
  });

  test("folderPriority works, which needs _path resolved from pathMap first", () => {
    const groups = [[file("a"), file("b")]];
    const pathMap = new Map([["a", "/My Drive/Downloads"], ["b", "/My Drive/Originals"]]);
    const items = buildExportItems(groups, pathMap, new Map(), {
      keepRule: "folderPriority",
      folderPriority: "originals",
    });
    assert.equal(items.find(i => i.role === "KEEP").name, "b.jpg");
  });

  // Regression: similarityPct read f._matchDist, never assigned, so it was
  // always null -- the export carried no similarity information at all.
  describe("similarityPct", () => {
    test("the keep file itself is 100", () => {
      const groups = [[file("a", { w: 10, h: 10 }), file("b", { w: 5, h: 5 })]];
      const idToEntry = new Map([["a", entry(SAME)], ["b", entry(NEAR)]]);
      const items = buildExportItems(groups, new Map(), idToEntry, { keepRule: "hires" });
      assert.equal(items.find(i => i.role === "KEEP").similarityPct, 100);
    });

    test("a near-identical duplicate scores high, a distant one low", () => {
      const groups = [[file("keep", { w: 10, h: 10 }), file("near", { w: 5, h: 5 })]];
      const near = buildExportItems(groups, new Map(),
        new Map([["keep", entry(SAME)], ["near", entry(NEAR)]]), { keepRule: "hires" });
      const nearPct = near.find(i => i.role === "DUPLICATE").similarityPct;

      const farGroups = [[file("keep", { w: 10, h: 10 }), file("far", { w: 5, h: 5 })]];
      const far = buildExportItems(farGroups, new Map(),
        new Map([["keep", entry(SAME)], ["far", entry(FAR)]]), { keepRule: "hires" });
      const farPct = far.find(i => i.role === "DUPLICATE").similarityPct;

      assert.ok(nearPct !== null && farPct !== null, "both must produce a number, not null");
      assert.ok(nearPct > farPct, `near (${nearPct}) must score above far (${farPct})`);
    });

    // Regression: the old code hardcoded /144, the 12x12 dHash bit count. The
    // #dhashSize setting also offers 8x8 (64 bits), where that formula reports
    // roughly 2.25x the true similarity.
    test("honours bitsCount rather than assuming 144", () => {
      const groups = [[file("keep", { w: 10, h: 10 }), file("dupe", { w: 5, h: 5 })]];
      const idToEntry = new Map([["keep", entry(SAME)], ["dupe", entry(FAR)]]);

      const at144 = buildExportItems(groups, new Map(), idToEntry, { keepRule: "hires", bitsCount: 144 });
      const at64  = buildExportItems(groups, new Map(), idToEntry, { keepRule: "hires", bitsCount: 64 });

      const p144 = at144.find(i => i.role === "DUPLICATE").similarityPct;
      const p64  = at64.find(i => i.role === "DUPLICATE").similarityPct;
      assert.notEqual(p144, p64, "a different bit count must produce a different percentage");
    });

    test("byte-identical files are 100 even with no hash entry", () => {
      // The MD5 fast path deliberately skips hashing exact duplicates, so they
      // reach the export with no entry to measure.
      const groups = [[file("a", { md5: "abc123" }), file("b", { md5: "abc123" })]];
      const items = buildExportItems(groups, new Map(), new Map(), { keepRule: "largest" });
      const dupe = items.find(i => i.role === "DUPLICATE");
      assert.equal(dupe.similarityPct, 100);
      assert.equal(dupe.matchType, "exact-md5");
    });

    test("stays null when there is genuinely nothing to compare", () => {
      const groups = [[file("a"), file("b")]];
      const items = buildExportItems(groups, new Map(), new Map(), { keepRule: "largest" });
      assert.equal(items.find(i => i.role === "DUPLICATE").similarityPct, null);
    });
  });

  test("carries the folder path and numbers groups from 1", () => {
    const groups = [[file("a"), file("b")], [file("c"), file("d")]];
    const pathMap = new Map([["a", "/My Drive/Photos"]]);
    const items = buildExportItems(groups, pathMap, new Map(), {});
    assert.equal(items.find(i => i.id === "a").path, "/My Drive/Photos");
    assert.deepEqual([...new Set(items.map(i => i.group))], [1, 2]);
  });

  test("empty input produces no rows rather than throwing", () => {
    assert.deepEqual(buildExportItems([], new Map(), new Map(), {}), []);
  });
});
