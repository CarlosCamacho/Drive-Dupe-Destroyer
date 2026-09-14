/*
 * Drive Dupe Destroyer (DDD) — test/paths.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Tests for the parent-chain walk in js/paths.js.
//
// The value under test is `complete`, not `path`. A truncated path used to be
// written to the durable IndexedDB cache as though it were correct, and
// `_path` is what folder-priority keep selection reads and what the CSV export
// reports as a file's location — so a walk that gave up early silently changed
// which file the app offered to delete, on every scan thereafter.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { walkParents } from "../js/paths.js";

// A three-level Drive: Hawaii inside 2019 inside Photos inside My Drive.
const TREE = {
  photos:  { id: "photos",  name: "Photos",   parents: ["myDrive"] },
  y2019:   { id: "y2019",   name: "2019",     parents: ["photos"] },
  hawaii:  { id: "hawaii",  name: "Hawaii",   parents: ["y2019"] },
  myDrive: { id: "myDrive", name: "My Drive", parents: [] },
};
const FILE = { id: "img1", name: "beach.jpg", parents: ["hawaii"] };

const serve = (tree = TREE) => async (id) => {
  if (!tree[id]) throw new Error(`no such folder ${id}`);
  return tree[id];
};

// Silence the console.warn the error branch emits, so a passing run is quiet.
const quietly = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

describe("walkParents", () => {
  test("a walk that reaches the root is complete and fully qualified", async () => {
    const out = await walkParents(FILE, serve());
    assert.equal(out.path, "/My Drive/Photos/2019/Hawaii");
    assert.equal(out.complete, true);
  });

  // Regression: this is the case that poisoned the cache. The walk broke out
  // and fell straight through to the caching lines.
  test("a failure mid-walk yields a truncated path marked INCOMPLETE", async () => {
    let calls = 0;
    const flaky = async (id) => {
      calls++;
      if (id === "photos") throw new Error("500 Internal Server Error");
      return TREE[id];
    };

    const out = await quietly(() => walkParents(FILE, flaky));
    assert.equal(out.path, "/2019/Hawaii", "the partial path is still returned for display");
    assert.equal(out.complete, false, "but it must not be presented as trustworthy");
    assert.ok(calls >= 3);
  });

  test("the depth cap also counts as incomplete", async () => {
    const out = await walkParents(FILE, serve(), { maxDepth: 2 });
    assert.equal(out.path, "/2019/Hawaii");
    assert.equal(out.complete, false, "stopping early is not a complete answer");
  });

  test("a walk that ends exactly at the root with no depth to spare is complete", async () => {
    // Four parents to resolve: hawaii, y2019, photos, myDrive.
    const out = await walkParents(FILE, serve(), { maxDepth: 4 });
    assert.equal(out.path, "/My Drive/Photos/2019/Hawaii");
    assert.equal(out.complete, true);
  });

  test("a file with no parents is a complete, empty path", async () => {
    const out = await walkParents({ id: "orphan", name: "x.jpg" }, serve());
    assert.equal(out.path, "/");
    assert.equal(out.complete, true);
  });

  // Regression: an abort that lands during a request used to arrive in the
  // error branch, so pressing Stop persisted a half-finished walk for every
  // file whose parent lookup was in flight.
  test("an AbortError re-throws rather than returning a partial path", async () => {
    const aborting = async (id) => {
      if (id === "y2019") {
        const e = new Error("The user aborted a request.");
        e.name = "AbortError";
        throw e;
      }
      return TREE[id];
    };
    await assert.rejects(() => walkParents(FILE, aborting), /Scan stopped/);
  });

  test("an already-aborted signal re-throws before any request is made", async () => {
    let calls = 0;
    const counting = async (id) => { calls++; return TREE[id]; };
    await assert.rejects(
      () => walkParents(FILE, counting, { signal: { aborted: true } }),
      /Scan stopped/
    );
    assert.equal(calls, 0);
  });

  test("a signal aborted partway through re-throws instead of truncating", async () => {
    const signal = { aborted: false };
    const trip = async (id) => {
      if (id === "y2019") signal.aborted = true;
      return TREE[id];
    };
    await assert.rejects(() => walkParents(FILE, trip, { signal }), /Scan stopped/);
  });

  test("a folder with no name contributes an empty segment, not 'undefined'", async () => {
    const nameless = { ...TREE, y2019: { id: "y2019", parents: ["photos"] } };
    const out = await walkParents(FILE, serve(nameless));
    assert.equal(out.path, "/My Drive/Photos//Hawaii");
    assert.equal(out.complete, true);
  });
});
