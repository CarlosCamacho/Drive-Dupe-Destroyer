/*
 * Drive Dupe Destroyer (DDD) — test/results-model.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The results table's decisions, tested without a DOM (#123).
//
// js/render.js keeps 15 module-level `let`s plus 8 Maps and Sets, and all of
// this used to read them directly -- so which file a group keeps, what the
// table sorts to, and how many bytes a selection frees could only be checked by
// booting the app in a browser and clicking.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  groupSignature, keeperFor, sizeStatsFor, groupSortValue, sortGroups,
  filterBySearch, dropLoneKeepers,
} from "../js/resultsModel.js";
import { DEFAULT_KEEP_RULE } from "../js/keeprule.js";

const F = (id, over = {}) => ({
  id, name: `${id}.jpg`, size: "1000",
  imageMediaMetadata: { width: 800, height: 600 },
  modifiedTime: "2024-01-01T00:00:00Z", createdTime: "2024-01-01T00:00:00Z",
  ...over,
});
const row = (id, groupId, isKeep, size) => ({ file: F(id, { size: String(size) }), groupId, isKeep });

describe("group identity", () => {
  test("is the member ids, order-independent", () => {
    assert.equal(groupSignature([F("b"), F("a"), F("c")]), groupSignature([F("c"), F("a"), F("b")]));
  });

  test("and changes when membership changes, so a pin cannot follow a reshaped group", () => {
    assert.notEqual(groupSignature([F("a"), F("b")]), groupSignature([F("a"), F("b"), F("c")]));
  });
});

describe("who keeps the group", () => {
  const group = [
    F("small", { imageMediaMetadata: { width: 100, height: 100 } }),
    F("big",   { imageMediaMetadata: { width: 900, height: 900 } }),
  ];

  test("with no pin, the keep rule decides", () => {
    const keeper = keeperFor(group, DEFAULT_KEEP_RULE, "", new Map());
    assert.equal(keeper.id, "big", "hires should keep the higher resolution");
  });

  test("a pin overrides the rule", () => {
    const overrides = new Map([[groupSignature(group), "small"]]);
    assert.equal(keeperFor(group, DEFAULT_KEEP_RULE, "", overrides).id, "small");
  });

  test("a pin naming a file no longer in the group is DROPPED, not just ignored", () => {
    // Otherwise it sits there forever overriding nothing, and reappears if the
    // deleted file ever comes back via Undo.
    const overrides = new Map([[groupSignature(group), "deleted-elsewhere"]]);
    const keeper = keeperFor(group, DEFAULT_KEEP_RULE, "", overrides);
    assert.equal(keeper.id, "big");
    assert.equal(overrides.size, 0, "the stale pin should have been removed");
  });

  test("an empty override map is harmless", () => {
    assert.equal(keeperFor(group, DEFAULT_KEEP_RULE, "", undefined).id, "big");
  });
});

describe("reclaimable bytes", () => {
  const rows = [
    row("k1", 1, true, 5000), row("d1", 1, false, 3000), row("d2", 1, false, 2000),
    row("k2", 2, true, 9000), row("d3", 2, false, 1000),
  ];

  test("counts the non-keepers only", () => {
    // The keeper stays, so its bytes are not reclaimable. Summing every row is
    // the "bytes scanned" number #114 replaced.
    assert.equal(sizeStatsFor(rows, new Set()).reclaimable, 3000 + 2000 + 1000);
  });

  test("the selected figure follows the selection", () => {
    assert.equal(sizeStatsFor(rows, new Set(["d1", "d3"])).selected, 4000);
  });

  test("selecting a keeper does not add its bytes", () => {
    // Keepers have no checkbox, but the set is just ids and a stale one could
    // name a file that has since become a keeper via a pin.
    assert.equal(sizeStatsFor(rows, new Set(["k1"])).selected, 0);
  });

  test("a file with no size is counted as unknown, never as zero", () => {
    const withUnknown = [...rows, { file: F("nosize", { size: undefined }), groupId: 3, isKeep: false }];
    const s = sizeStatsFor(withUnknown, new Set());
    assert.equal(s.unknown, 1);
    assert.equal(s.reclaimable, 6000, "an unknown size must not silently count as 0 either");
  });

  test("an empty table is zero, not NaN", () => {
    assert.deepEqual(sizeStatsFor([], new Set()), { reclaimable: 0, selected: 0, unknown: 0 });
  });
});

describe("sorting", () => {
  const built = (id, keepOver, members) => ({
    keepFile: F(id, keepOver), members,
  });
  const g1 = built("beta",  { _path: "/b" }, [F("beta"), F("x", { size: "500" })]);
  const g2 = built("alpha", { _path: "/a" }, [F("alpha"), F("y", { size: "9000" })]);

  test("size sorts on what the group would FREE, not what it weighs", () => {
    // The keeper stays, so its bytes must not count toward the sort key --
    // otherwise a group with one huge keeper outranks one with real waste.
    assert.equal(groupSortValue(g1, "size"), 500);
    assert.equal(groupSortValue(g2, "size"), 9000);
  });

  test("name and folder sort case-insensitively", () => {
    assert.equal(groupSortValue(built("Z", { name: "Zebra.jpg" }, []), "name"), "zebra.jpg");
    assert.equal(groupSortValue(built("z", { _path: "/Photos" }, []), "folder"), "/photos");
  });

  test("no key keeps the order matching produced", () => {
    const arr = [g1, g2];
    sortGroups(arr, null);
    assert.deepEqual(arr.map(b => b.keepFile.id), ["beta", "alpha"]);
  });

  test("ascending and descending are mirrors", () => {
    const asc = [g1, g2]; sortGroups(asc, "name", "asc");
    const desc = [g1, g2]; sortGroups(desc, "name", "desc");
    assert.deepEqual(asc.map(b => b.keepFile.id), ["alpha", "beta"]);
    assert.deepEqual(desc.map(b => b.keepFile.id), ["beta", "alpha"]);
  });

  test("ties break on the keeper id, so the order is reproducible", () => {
    const a = built("aaa", { name: "same.jpg" }, []);
    const b = built("bbb", { name: "same.jpg" }, []);
    const one = [b, a]; sortGroups(one, "name", "desc");
    const two = [a, b]; sortGroups(two, "name", "desc");
    assert.deepEqual(one.map(x => x.keepFile.id), two.map(x => x.keepFile.id),
      "the same input in a different order must sort the same");
  });
});

describe("search", () => {
  const rows = [
    { file: F("a", { name: "holiday.jpg", _path: "/2024" }), groupId: 1, isKeep: true },
    { file: F("b", { name: "IMG_001.jpg", _path: "/2024" }), groupId: 1, isKeep: false },
    { file: F("c", { name: "receipt.png", _path: "/docs" }), groupId: 2, isKeep: true },
    { file: F("d", { name: "scan.png",    _path: "/docs" }), groupId: 2, isKeep: false },
  ];

  test("a group survives WHOLE when any member matches", () => {
    // Matching one file of a pair and hiding its sibling leaves a lone row with
    // nothing to compare against.
    const out = filterBySearch(rows, "holiday");
    assert.deepEqual(out.map(r => r.file.id), ["a", "b"]);
  });

  test("it searches the folder path too", () => {
    assert.deepEqual(filterBySearch(rows, "docs").map(r => r.file.id), ["c", "d"]);
  });

  test("it is case-insensitive and trims", () => {
    assert.equal(filterBySearch(rows, "  IMG_001  ").length, 2);
  });

  test("an empty search returns everything, not nothing", () => {
    assert.equal(filterBySearch(rows, "").length, 4);
    assert.equal(filterBySearch(rows, "   ").length, 4);
  });
});

describe("lone keepers", () => {
  test("a group reduced to just its keeper is dropped", () => {
    const rows = [
      { file: F("k1"), groupId: 1, isKeep: true },
      { file: F("d1"), groupId: 1, isKeep: false },
      { file: F("k2"), groupId: 2, isKeep: true },   // nothing left to compare
    ];
    assert.deepEqual(dropLoneKeepers(rows).map(r => r.file.id), ["k1", "d1"]);
  });
});
