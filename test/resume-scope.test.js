/*
 * Drive Dupe Destroyer (DDD) — test/resume-scope.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// A saved resume point is only taken by the scan it belongs to.
//
// A resume carries its own folder frontier and the files it had collected,
// and the scan follows those instead of the selection it is given. Accepting
// "Resume" and then changing the folders scanned the OLD folders, and files
// collected from a folder excluded since were offered for deletion.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resumeMatchesScope } from "../js/resume.js";

const saved = {
  folderIds: ["a", "b"],
  exclusions: ["x"],
  options: { recursive: true, maxItems: 0 },
};
const now = { folderIds: ["b", "a"], exclusions: new Set(["x"]), recursive: true, maxItems: 0 };

describe("resumeMatchesScope", () => {
  test("the same scan, in any order, matches", () => {
    assert.equal(resumeMatchesScope(saved, now), true);
  });
  test("a different folder selection does not", () => {
    assert.equal(resumeMatchesScope(saved, { ...now, folderIds: ["a", "c"] }), false);
    assert.equal(resumeMatchesScope(saved, { ...now, folderIds: ["a"] }), false);
  });
  test("a folder excluded since does not", () => {
    assert.equal(resumeMatchesScope(saved, { ...now, exclusions: new Set(["x", "y"]) }), false);
  });
  test("a different depth or item limit does not", () => {
    assert.equal(resumeMatchesScope(saved, { ...now, recursive: false }), false);
    assert.equal(resumeMatchesScope(saved, { ...now, maxItems: 1000 }), false);
  });
  test("nothing saved matches nothing", () => {
    assert.equal(resumeMatchesScope(null, now), false);
  });
});
