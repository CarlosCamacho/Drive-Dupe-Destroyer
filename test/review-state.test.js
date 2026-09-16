/*
 * Drive Dupe Destroyer (DDD) — test/review-state.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// How far through the review you got, kept across sessions (#117).
//
// js/resume.js persists the SCAN in detail -- #99 went as far as shrinking
// webViewLink out of the checkpoint because it was writing 125 MB a scan.
// Nothing persisted the REVIEW, which is the part the person does and the part
// that takes an evening. The rules here are small; the one that matters is that
// a judgement made about one folder selection must never leak into another.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  reviewScopeKey, makeReviewState, markDecided, markSkipped, setKeeper,
  statusOf, isReviewed, reviewCounts, pruneToSignatures,
  serializeReviewState, deserializeReviewState,
  UNTOUCHED, DECIDED, SKIPPED,
} from "../js/reviewState.js";

describe("review scope", () => {
  test("is the folder selection, order-independent", () => {
    assert.equal(
      reviewScopeKey({ folderIds: ["b", "a"], exclusions: new Set(["x"]) }),
      reviewScopeKey({ folderIds: ["a", "b"], exclusions: new Set(["x"]) }));
  });

  test("changes when the included folders change", () => {
    assert.notEqual(
      reviewScopeKey({ folderIds: ["a"] }),
      reviewScopeKey({ folderIds: ["a", "b"] }));
  });

  test("and when only the EXCLUSIONS change", () => {
    // Excluding a folder changes which files are in the groups, so a review of
    // the old scope says nothing about the new one.
    assert.notEqual(
      reviewScopeKey({ folderIds: ["a"], exclusions: new Set() }),
      reviewScopeKey({ folderIds: ["a"], exclusions: new Set(["sub"]) }));
  });

  test("accepts exclusions as a Set or an array — getExclusions returns a Set", () => {
    assert.equal(
      reviewScopeKey({ folderIds: ["a"], exclusions: new Set(["x", "y"]) }),
      reviewScopeKey({ folderIds: ["a"], exclusions: ["y", "x"] }));
  });
});

describe("marking groups", () => {
  test("a fresh group is untouched", () => {
    assert.equal(statusOf(makeReviewState(), "sig"), UNTOUCHED);
    assert.equal(isReviewed(makeReviewState(), "sig"), false);
  });

  test("decided and skipped are both 'reviewed', and distinguishable", () => {
    const s = makeReviewState();
    markDecided(s, "a");
    markSkipped(s, "b");
    assert.equal(statusOf(s, "a"), DECIDED);
    assert.equal(statusOf(s, "b"), SKIPPED);
    assert.equal(isReviewed(s, "a"), true);
    assert.equal(isReviewed(s, "b"), true);
  });

  test("deciding after skipping wins — doing something outranks passing over it", () => {
    const s = makeReviewState();
    markSkipped(s, "a");
    markDecided(s, "a");
    assert.equal(statusOf(s, "a"), DECIDED);
  });

  test("counts say how much is left", () => {
    const s = makeReviewState();
    markDecided(s, "a");
    markSkipped(s, "b");
    const c = reviewCounts(s, ["a", "b", "c", "d"]);
    assert.equal(c[DECIDED], 1);
    assert.equal(c[SKIPPED], 1);
    assert.equal(c[UNTOUCHED], 2);
  });
});

describe("keeper pins ride along", () => {
  test("a pin is remembered and can be released", () => {
    const s = makeReviewState();
    setKeeper(s, "sig", "file-1");
    assert.equal(s.keepers.get("sig"), "file-1");
    setKeeper(s, "sig", null);
    assert.equal(s.keepers.has("sig"), false);
  });
});

describe("pruning", () => {
  test("marks for groups that no longer exist are dropped", () => {
    // Without this the store grows forever: every rescan that reshapes a group
    // leaves its old signature behind.
    const s = makeReviewState();
    markDecided(s, "gone");
    markDecided(s, "still-here");
    setKeeper(s, "gone", "f");
    pruneToSignatures(s, ["still-here"]);
    assert.deepEqual([...s.marks.keys()], ["still-here"]);
    assert.equal(s.keepers.size, 0);
  });
});

describe("persistence", () => {
  test("a round trip preserves marks and pins", () => {
    const s = makeReviewState("scope-1");
    markDecided(s, "a");
    markSkipped(s, "b");
    setKeeper(s, "a", "file-9");
    const back = deserializeReviewState(serializeReviewState(s), "scope-1");
    assert.equal(statusOf(back, "a"), DECIDED);
    assert.equal(statusOf(back, "b"), SKIPPED);
    assert.equal(back.keepers.get("a"), "file-9");
  });

  test("a review stored under a DIFFERENT scope is not restored", () => {
    // The whole point of the scope key. Inheriting a judgement about one set of
    // folders into another would mark groups reviewed that were never seen.
    const s = makeReviewState("folders-A");
    markDecided(s, "a");
    const back = deserializeReviewState(serializeReviewState(s), "folders-B");
    assert.equal(statusOf(back, "a"), UNTOUCHED);
    assert.equal(back.scope, "folders-B");
  });

  test("nothing stored yields a usable empty state, not a crash", () => {
    for (const raw of [null, undefined, {}, { scope: "x" }, { scope: "x", marks: "nonsense" }]) {
      const back = deserializeReviewState(raw, "x");
      assert.ok(back.marks instanceof Map, `marks not a Map for ${JSON.stringify(raw)}`);
      assert.ok(back.keepers instanceof Map);
    }
  });

  test("Maps are stored as pairs, because a Map does not survive the trip usefully", () => {
    const s = makeReviewState("x");
    markDecided(s, "a");
    const raw = serializeReviewState(s);
    assert.ok(Array.isArray(raw.marks), "marks should serialise to an array of pairs");
    assert.deepEqual(raw.marks, [["a", DECIDED]]);
  });
});
