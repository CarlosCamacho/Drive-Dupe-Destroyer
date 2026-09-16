/*
 * Drive Dupe Destroyer (DDD) — test/file-list-cache.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// #116: skipping the enumeration is only safe if the cache knows when it must
// NOT be used.
//
// #67 corrected the comment that called the Changes reconcile a "delta scan" —
// it ran after files.list had been paginated across every folder, so it saved
// nothing — and closed on that honest fix, deferring the saving. The saving is
// the easy part. These rules are the part that can quietly corrupt a scan:
// a stale scope does not look like a bug, it looks like the app scanning
// folders you told it not to.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { enumerationScopeKey, applyChangesToList, MAX_AGE_MS } from "../js/fileListCache.js";

const f = (id, parent = "A", over = {}) => ({ id, name: `${id}.jpg`, parents: [parent], size: "1000", ...over });

describe("what invalidates a cached enumeration", () => {
  const base = { folderIds: ["a", "b"], exclusions: new Set(["x"]), recursive: true, maxItems: 0 };

  test("the same scope in a different order is the same scope", () => {
    assert.equal(
      enumerationScopeKey(base),
      enumerationScopeKey({ ...base, folderIds: ["b", "a"], exclusions: new Set(["x"]) }));
  });

  test("adding a folder invalidates", () => {
    assert.notEqual(enumerationScopeKey(base), enumerationScopeKey({ ...base, folderIds: ["a", "b", "c"] }));
  });

  test("changing the EXCLUSIONS invalidates", () => {
    // The one most likely to be forgotten, and the one whose failure looks like
    // the app ignoring an exclusion rather than like a cache bug.
    assert.notEqual(enumerationScopeKey(base), enumerationScopeKey({ ...base, exclusions: new Set() }));
    assert.notEqual(enumerationScopeKey(base), enumerationScopeKey({ ...base, exclusions: new Set(["x", "y"]) }));
  });

  test("turning recursion off invalidates — a flat walk returns a different set", () => {
    assert.notEqual(enumerationScopeKey(base), enumerationScopeKey({ ...base, recursive: false }));
  });

  test("changing the item cap invalidates, because it TRUNCATES the walk", () => {
    // A list collected under a cap of 1,000 is not the answer to a cap of
    // 50,000, and reusing it would silently keep the scan small forever.
    assert.notEqual(enumerationScopeKey(base), enumerationScopeKey({ ...base, maxItems: 1000 }));
  });

  test("but the SIZE LIMITS and TYPE TOGGLES do not appear in the key at all", () => {
    // They are applied after enumeration, so they do not change what the walk
    // returns. Including them would throw the cache away every time somebody
    // moved a slider — and, worse, invites caching the filtered list.
    const key = enumerationScopeKey(base);
    assert.ok(!/minBytes|maxBytes|ext|jpg/i.test(key), `scope key leaks a filter: ${key}`);
  });

  test("exclusions may arrive as a Set or an array", () => {
    assert.equal(
      enumerationScopeKey({ ...base, exclusions: new Set(["x"]) }),
      enumerationScopeKey({ ...base, exclusions: ["x"] }));
  });

  test("the cache expires — a week-old enumeration is not worth trusting", () => {
    assert.equal(MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  });
});

describe("applying changes to a cached list", () => {
  const opts = { visitedFolderIds: new Set(["A", "B"]), exclusions: new Set(["SECRET"]) };

  test("a new file in a visited folder is added", () => {
    const r = applyChangesToList([f("1")], [{ ...f("2"), _changed: true }], opts);
    assert.deepEqual(r.files.map(x => x.id), ["1", "2"]);
    assert.equal(r.added, 1);
  });

  test("a removed file is dropped", () => {
    const r = applyChangesToList([f("1"), f("2")], [{ id: "2", _removed: true }], opts);
    assert.deepEqual(r.files.map(x => x.id), ["1"]);
    assert.equal(r.removed, 1);
  });

  test("a change OUTSIDE the scanned folders is ignored", () => {
    // The Changes API reports the WHOLE Drive. Without this the app pulled in
    // images from anywhere and offered them as delete candidates.
    const r = applyChangesToList([f("1")], [{ ...f("99", "ELSEWHERE"), _changed: true }], opts);
    assert.deepEqual(r.files.map(x => x.id), ["1"]);
    assert.equal(r.outOfScope, 1);
  });

  test("a change inside an EXCLUDED folder is ignored", () => {
    const r = applyChangesToList([f("1")], [{ ...f("99", "SECRET"), _changed: true }], opts);
    assert.deepEqual(r.files.map(x => x.id), ["1"]);
    assert.equal(r.outOfScope, 1);
  });

  test("a file with no parent is ignored rather than added at the root", () => {
    const r = applyChangesToList([f("1")], [{ id: "orphan", parents: [], _changed: true }], opts);
    assert.equal(r.files.length, 1);
  });

  test("a file already in the list is not duplicated", () => {
    const r = applyChangesToList([f("1")], [{ ...f("1"), _changed: true }], opts);
    assert.deepEqual(r.files.map(x => x.id), ["1"]);
    assert.equal(r.added, 0);
  });

  test("a file both changed and removed ends up removed", () => {
    // Drive can report both for one file in a single page of changes; keeping
    // it would resurrect a trashed file as a delete candidate.
    const r = applyChangesToList(
      [f("1")],
      [{ ...f("2"), _changed: true }, { id: "2", _removed: true }],
      opts);
    assert.deepEqual(r.files.map(x => x.id), ["1"]);
  });

  test("the input list is not mutated", () => {
    // scan.js reassigns rather than mutating, and the cached array may be
    // shared with the render path.
    const original = [f("1")];
    applyChangesToList(original, [{ ...f("2"), _changed: true }], opts);
    assert.deepEqual(original.map(x => x.id), ["1"]);
  });

  test("no changes leaves the list exactly as it was", () => {
    const r = applyChangesToList([f("1"), f("2")], [], opts);
    assert.deepEqual(r.files.map(x => x.id), ["1", "2"]);
    assert.equal(r.added, 0);
    assert.equal(r.removed, 0);
  });
});
