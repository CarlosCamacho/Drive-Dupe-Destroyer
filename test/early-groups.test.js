/*
 * Drive Dupe Destroyer (DDD) — test/early-groups.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Live results during hashing (earlyGroups.js).
//
// The contract that matters: every early group is a SUBSET of the group the
// matcher later produces for the same files. The live table relies on it to
// replace an early group with the matcher's instead of listing files twice,
// and the user may delete from an early group before the matcher has run.
// So these tests check the grouper against the real matcher, not just itself.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { exactGroupsForLive, makeEarlyGrouper } from "../js/earlyGroups.js";
import { runMatching } from "../js/matcher.js";
import { aspectRatioCompatible } from "../js/distance.js";

const hash = (seed) => {
  const b12 = new Uint8Array(18);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < 18; i++) { x = (x * 1103515245 + 12345) >>> 0; b12[i] = x >>> 24; }
  return b12;
};
const entry = (seed) => ({ base12: hash(seed), base8: hash(seed).slice(0, 8), variants: [] });
const file = (id, w = 400, h = 300) => ({ id, name: `${id}.jpg`, imageMediaMetadata: { width: w, height: h } });
const key = (e) => Array.from(e.base12).join(",");

describe("makeEarlyGrouper", () => {
  test("groups files whose hash is identical, as soon as the second arrives", () => {
    const g = makeEarlyGrouper();
    assert.equal(g.add(file("a"), entry(1)), null);
    assert.equal(g.add(file("b"), entry(2)), null);
    const hit = g.add(file("c"), entry(1));
    assert.deepEqual(hit.group.map(f => f.id), ["a", "c"]);
    assert.equal(hit.key, `hash:${key(entry(1))}`);
    // A third copy re-emits the grown group under the same key.
    const again = g.add(file("d"), entry(1));
    assert.deepEqual(again.group.map(f => f.id), ["a", "c", "d"]);
    assert.equal(again.key, hit.key);
  });

  test("ignores files with no hash and repeats of the same file", () => {
    const g = makeEarlyGrouper();
    assert.equal(g.add(file("a"), { base12: null }), null);
    g.add(file("a"), entry(1));
    assert.equal(g.add(file("a"), entry(1)), null);
  });

  test("honours a rejected identical pair, as the matcher does", () => {
    const e = entry(7);
    const g = makeEarlyGrouper({ rejectedKeys: new Set([`${key(e)}|${key(e)}`]) });
    g.add(file("a"), e);
    assert.equal(g.add(file("b"), entry(7)), null);
  });

  test("honours the aspect pre-filter", () => {
    const g = makeEarlyGrouper({ compatible: (a, b) => aspectRatioCompatible(a, b, 5) });
    g.add(file("a", 400, 300), entry(3));
    assert.equal(g.add(file("b", 400, 100), entry(3)), null);
  });

  test("a hashed MD5 representative brings its unhashed copies with it", () => {
    const rep = { ...file("r"), md5Checksum: "m" };
    const copy = { ...file("r2"), md5Checksum: "m" };
    const { groups, siblings } = exactGroupsForLive([[rep, copy]]);
    assert.deepEqual(groups.map(x => x.key), ["md5:m"]);
    const g = makeEarlyGrouper({ siblings });
    g.add(rep, entry(9));
    const hit = g.add(file("x"), entry(9));
    assert.deepEqual(hit.group.map(f => f.id).sort(), ["r", "r2", "x"]);
  });
});

describe("early groups are subsets of the matcher's groups", () => {
  test("on a mixed library", async () => {
    // Identical pairs, a near pair the early pass cannot see, and singletons.
    const files = [];
    const entries = new Map();
    const add = (id, e) => { files.push(file(id)); entries.set(id, e); };
    add("a1", entry(1)); add("a2", entry(1)); add("a3", entry(1));
    add("b1", entry(2)); add("b2", entry(2));
    const near = entry(3); near.base12 = Uint8Array.from(near.base12); near.base12[0] ^= 1;
    add("c1", entry(3)); add("c2", near);
    for (let i = 10; i < 40; i++) add(`s${i}`, entry(i));

    const g = makeEarlyGrouper();
    const live = new Map();
    for (const f of files) {
      const hit = g.add(f, entries.get(f.id));
      if (hit) live.set(hit.key, hit.group.map(x => x.id));
    }
    assert.equal(live.size, 2, "the two identical clusters, and not the near pair");

    const { groups } = await runMatching({ entries, hamThresh: 10 });
    for (const early of live.values()) {
      const container = groups.find(gr => early.every(id => gr.includes(id)));
      assert.ok(container, `early group ${early} is inside one matcher group`);
    }
  });
});
