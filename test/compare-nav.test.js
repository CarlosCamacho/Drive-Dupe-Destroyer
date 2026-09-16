/*
 * Drive Dupe Destroyer (DDD) — test/compare-nav.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Walking the pairs in the compare view (#129).
//
// js/compare.js is 612 lines with no test or harness of any kind, on the screen
// where a person decides which of two near-identical photographs to destroy.
// The navigation is what these pin, because the set it walks SHRINKS WHILE THE
// VIEW IS OPEN — trashing a file removes it from its group, and a group that
// drops below two members has nothing left to compare.
//
// The keeper is injected, so these tests do not need the keep-rule dropdown.
// The fixture keeper is simply the first member, which makes the expected
// pairing obvious at a glance.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  candidatesIn, pairCount, nextReviewable, anyReviewable, resolvePair, progressLabel,
} from "../js/compareNav.js";

const f = (id) => ({ id, name: `${id}.jpg` });
const keeperFirst = (g) => g[0];
/** Groups of the given sizes: g0 = [a0,a1,...], g1 = [b0,...], … */
const groups = (...sizes) =>
  sizes.map((n, gi) => Array.from({ length: n }, (_, i) => f(`${String.fromCharCode(97 + gi)}${i}`)));

describe("what a group offers", () => {
  test("the keeper is excluded from the candidates", () => {
    const g = groups(3)[0];
    const { keepFile, others } = candidatesIn(g, keeperFirst);
    assert.equal(keepFile.id, "a0");
    assert.deepEqual(others.map(o => o.id), ["a1", "a2"]);
  });

  test("a group of two offers exactly one comparison", () => {
    assert.equal(pairCount(groups(2), 0, keeperFirst), 1);
  });

  test("a group reduced to ONE member offers none — it has nothing to compare against", () => {
    // This is the case that happens live: the user trashes the only duplicate
    // and the group collapses while the modal is still open.
    assert.equal(pairCount(groups(1), 0, keeperFirst), 0);
  });

  test("an empty or missing group offers none rather than throwing", () => {
    assert.equal(pairCount([[]], 0, keeperFirst), 0);
    assert.equal(pairCount([], 5, keeperFirst), 0);
  });
});

describe("finding the next group worth looking at", () => {
  // g0 has pairs, g1 has collapsed to one member, g2 has pairs.
  const gs = groups(3, 1, 2);

  test("forwards, skipping a group that has collapsed", () => {
    assert.equal(nextReviewable(gs, 0, 1, keeperFirst), 0);
    assert.equal(nextReviewable(gs, 1, 1, keeperFirst), 2, "should skip the 1-member group");
  });

  test("backwards, skipping it too", () => {
    assert.equal(nextReviewable(gs, 2, -1, keeperFirst), 2);
    assert.equal(nextReviewable(gs, 1, -1, keeperFirst), 0);
  });

  test("-1 when there is nothing in that direction", () => {
    assert.equal(nextReviewable(gs, 3, 1, keeperFirst), -1);
    assert.equal(nextReviewable(gs, -1, -1, keeperFirst), -1);
  });

  test("anyReviewable is false only when every group has collapsed", () => {
    assert.equal(anyReviewable(gs, keeperFirst), true);
    assert.equal(anyReviewable(groups(1, 1, 1), keeperFirst), false);
    assert.equal(anyReviewable([], keeperFirst), false);
  });
});

describe("resolving a requested pair", () => {
  const gs = groups(3, 2);   // g0: a0 keeper + a1,a2   g1: b0 keeper + b1

  test("an in-range request resolves to the keeper and the right sibling", () => {
    const r = resolvePair(gs, 0, 1, keeperFirst);
    assert.equal(r.status, "ok");
    assert.equal(r.keepFile.id, "a0");
    assert.equal(r.other.id, "a2");
  });

  test("running off the end of a group rolls into the next one", () => {
    const r = resolvePair(gs, 0, 2, keeperFirst);   // g0 has only 2 pairs
    assert.equal(r.status, "ok");
    assert.equal(r.groupIndex, 1);
    assert.equal(r.pairIndex, 0);
    assert.equal(r.other.id, "b1");
  });

  test("running off the start lands on the LAST pair of the previous group", () => {
    // Not its first. Stepping back must not skip the members you just walked
    // forward through.
    const r = resolvePair(gs, 1, -1, keeperFirst);
    assert.equal(r.status, "ok");
    assert.equal(r.groupIndex, 0);
    assert.equal(r.pairIndex, 1, "should land on the last pair of g0, not the first");
    assert.equal(r.other.id, "a2");
  });

  test("rolling forward SKIPS a group that collapsed mid-review", () => {
    const withHole = groups(2, 1, 2);
    const r = resolvePair(withHole, 0, 1, keeperFirst);
    assert.equal(r.status, "ok");
    assert.equal(r.groupIndex, 2, "the 1-member group must not be shown");
  });

  test("rolling backward skips it too", () => {
    const withHole = groups(2, 1, 2);
    const r = resolvePair(withHole, 2, -1, keeperFirst);
    assert.equal(r.status, "ok");
    assert.equal(r.groupIndex, 0);
  });

  test("past the last group reports at-end rather than a wrong pair", () => {
    assert.equal(resolvePair(gs, 1, 5, keeperFirst).status, "at-end");
  });

  test("before the first group reports at-start", () => {
    assert.equal(resolvePair(gs, 0, -1, keeperFirst).status, "at-start");
  });

  test("nothing reviewable anywhere reports empty, so the view closes", () => {
    assert.equal(resolvePair(groups(1, 1), 0, 0, keeperFirst).status, "empty");
    assert.equal(resolvePair([], 0, 0, keeperFirst).status, "empty");
  });

  test("an out-of-range pair index inside a live group is clamped, not dropped", () => {
    const single = groups(2);
    const r = resolvePair(single, 0, 0, keeperFirst);
    assert.equal(r.status, "ok");
    assert.equal(r.pairIndex, 0);
  });

  test("every resolved pair really is keeper-versus-other, never the keeper twice", () => {
    // The failure this guards is showing a file against itself, which reads as
    // "these are identical" on the screen that decides a deletion.
    const gs2 = groups(4, 3, 2);
    for (let gi = 0; gi < gs2.length; gi++) {
      for (let pi = 0; pi < 5; pi++) {
        const r = resolvePair(gs2, gi, pi, keeperFirst);
        if (r.status !== "ok") continue;
        assert.notEqual(r.keepFile.id, r.other.id, `group ${gi} pair ${pi} compared a file with itself`);
        assert.ok(gs2[r.groupIndex].some(x => x.id === r.other.id), "the other file must be in the group");
      }
    }
  });

  test("walking forward from the start visits every candidate exactly once", () => {
    // The off-by-one that skips a group is silent: the user simply never sees
    // those files, and never knows.
    const gs3 = groups(3, 2, 4);
    const seen = [];
    let gi = 0, pi = 0;
    for (let step = 0; step < 50; step++) {
      const r = resolvePair(gs3, gi, pi, keeperFirst);
      if (r.status !== "ok") break;
      seen.push(`${r.groupIndex}:${r.other.id}`);
      gi = r.groupIndex; pi = r.pairIndex + 1;
    }
    const expected = [];
    gs3.forEach((g, i) => g.slice(1).forEach(o => expected.push(`${i}:${o.id}`)));
    assert.deepEqual(seen, expected);
  });
});

describe("the progress label", () => {
  test("counts REVIEWABLE groups, not raw indices", () => {
    // g1 has collapsed, so g2 is the second reviewable group, not the third.
    const gs = groups(3, 1, 2);
    assert.equal(progressLabel(gs, 0, 0, keeperFirst), "Group 1 of 2 · pair 1 of 2");
    assert.equal(progressLabel(gs, 2, 0, keeperFirst), "Group 2 of 2");
  });

  test("the pair part is dropped when there is only one comparison", () => {
    assert.equal(progressLabel(groups(2), 0, 0, keeperFirst), "Group 1 of 1");
  });

  test("the numbers do not jump when a group empties", () => {
    const before = progressLabel(groups(2, 2, 2), 2, 0, keeperFirst);
    const after = progressLabel(groups(1, 2, 2), 2, 0, keeperFirst);
    assert.equal(before, "Group 3 of 3");
    assert.equal(after, "Group 2 of 2", "emptying an earlier group renumbers, it does not leave a hole");
  });
});
