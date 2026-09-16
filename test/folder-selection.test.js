/*
 * Drive Dupe Destroyer (DDD) — test/folder-selection.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// js/folderPicker.js is 443 lines, it is the gate in front of the entire app --
// no scan can start without a folder selection -- and until now it had no test
// or harness of any kind (#124). If it broke, nothing would go red.
//
// The rules here are small and not obvious, and the exclusion set in particular
// is consulted twice for two different purposes: actions.js refuses to trash a
// file whose parent is excluded, and scan.js:962 uses it to keep delta-scan
// changes in scope. A wrong exclusion set does not present as a bug. It
// presents as the app scanning folders you told it not to.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  makeSelection, includeFolder, excludeFolder, forgetFolder,
  clearSelection, selectionSummary,
} from "../js/folderPicker.js";

const F = (id, name = id + " folder") => ({ id, name });
const ids = (m) => [...m.keys()].sort();

describe("folder selection (#124)", () => {
  test("a fresh selection is empty and says so", () => {
    const s = makeSelection();
    assert.equal(s.included.size, 0);
    assert.equal(s.excluded.size, 0);
    assert.equal(selectionSummary(s), "None selected");
  });

  test("including keeps the name, not just the id", () => {
    // The name is what the chips and the scan-history record show. Storing bare
    // ids would leave the sidebar reading "✓ 1a2b3c".
    const s = includeFolder(makeSelection(), F("a", "Holidays"));
    assert.deepEqual([...s.included.values()], [{ id: "a", name: "Holidays" }]);
  });

  test("including a folder removes it from excluded", () => {
    const s = makeSelection();
    excludeFolder(s, F("a"));
    includeFolder(s, F("a"));
    assert.deepEqual(ids(s.included), ["a"]);
    assert.deepEqual(ids(s.excluded), []);
  });

  test("excluding a folder removes it from included", () => {
    const s = makeSelection();
    includeFolder(s, F("a"));
    excludeFolder(s, F("a"));
    assert.deepEqual(ids(s.included), []);
    assert.deepEqual(ids(s.excluded), ["a"]);
  });

  test("a folder is NEVER in both sets — the two consumers would contradict each other", () => {
    const s = makeSelection();
    for (const op of [includeFolder, excludeFolder, includeFolder, excludeFolder, includeFolder]) {
      op(s, F("a"));
      const both = [...s.included.keys()].filter(id => s.excluded.has(id));
      assert.deepEqual(both, [], "id present in both included and excluded");
    }
  });

  test("both operations are idempotent", () => {
    const s = makeSelection();
    includeFolder(s, F("a"));
    includeFolder(s, F("a"));
    excludeFolder(s, F("b"));
    excludeFolder(s, F("b"));
    assert.equal(s.included.size, 1);
    assert.equal(s.excluded.size, 1);
  });

  test("re-including updates the stored name rather than keeping a stale one", () => {
    const s = makeSelection();
    includeFolder(s, F("a", "Old name"));
    includeFolder(s, F("a", "Renamed in Drive"));
    assert.equal(s.included.get("a").name, "Renamed in Drive");
  });

  test("forgetting takes a folder out of whichever set it was in", () => {
    const s = makeSelection();
    includeFolder(s, F("a"));
    excludeFolder(s, F("b"));
    forgetFolder(s, "a");
    forgetFolder(s, "b");
    assert.equal(s.included.size, 0);
    assert.equal(s.excluded.size, 0);
  });

  test("forgetting something never selected is harmless", () => {
    const s = makeSelection();
    forgetFolder(s, "never-seen");
    assert.equal(s.included.size, 0);
    assert.equal(s.excluded.size, 0);
  });

  test("a folder with no id is ignored rather than stored under undefined", () => {
    // getFolderMeta can come back without one; a Map keyed on undefined would
    // then match every other id-less folder.
    const s = makeSelection();
    includeFolder(s, { name: "no id" });
    excludeFolder(s, null);
    excludeFolder(s, undefined);
    assert.equal(s.included.size, 0);
    assert.equal(s.excluded.size, 0);
  });

  test("a missing name becomes an empty string, never undefined", () => {
    const s = includeFolder(makeSelection(), { id: "a" });
    assert.equal(s.included.get("a").name, "");
  });

  test("clearing empties both sets", () => {
    const s = makeSelection();
    includeFolder(s, F("a"));
    excludeFolder(s, F("b"));
    clearSelection(s);
    assert.equal(selectionSummary(s), "None selected");
  });

  describe("the summary line under Folders", () => {
    test("counts each side, and mentions only the sides that have any", () => {
      const s = makeSelection();
      includeFolder(s, F("a"));
      includeFolder(s, F("b"));
      assert.equal(selectionSummary(s), "2 included");
      excludeFolder(s, F("c"));
      assert.equal(selectionSummary(s), "2 included, 1 excluded");
      forgetFolder(s, "a");
      forgetFolder(s, "b");
      assert.equal(selectionSummary(s), "1 excluded");
    });
  });

  describe("what the scan is handed", () => {
    test("included ids and the exclusion set are disjoint after any sequence", () => {
      // app.js passes getIncludedFolderIds() and getExclusions() to runScan as
      // two independent things. If they overlap, a folder is both scanned and
      // skipped, and which one wins depends on ordering inside the scan.
      const s = makeSelection();
      const ops = [
        ["i", "a"], ["i", "b"], ["e", "b"], ["i", "c"], ["e", "a"],
        ["i", "a"], ["f", "c"], ["e", "d"], ["i", "d"],
      ];
      for (const [op, id] of ops) {
        if (op === "i") includeFolder(s, F(id));
        else if (op === "e") excludeFolder(s, F(id));
        else forgetFolder(s, id);
      }
      const inc = new Set(s.included.keys());
      const exc = new Set(s.excluded.keys());
      const overlap = [...inc].filter(id => exc.has(id));
      assert.deepEqual(overlap, [], `both scanned and skipped: ${overlap.join(", ")}`);
      assert.deepEqual([...inc].sort(), ["a", "d"]);
      assert.deepEqual([...exc].sort(), ["b"]);
    });
  });
});
