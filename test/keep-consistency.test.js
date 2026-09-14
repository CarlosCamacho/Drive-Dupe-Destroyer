/*
 * Drive Dupe Destroyer (DDD) — test/keep-consistency.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The keeper must be decided in exactly ONE place.
//
// compare.js used to carry a private copy, chooseKeepIndexLocal, that had
// drifted from common.js in four ways. On the same group it picked a different
// file in all four cases — and because the compare view then hard-coded the
// LEFT pane as the keeper, the file the rest of the app wanted kept landed on
// the right, where the "deleting the KEEP file" warning is disabled.
//
// The first test here is a source-level guard: no second implementation. The
// rest pin the four behaviours the copy got wrong, so a reintroduced copy would
// have to get them right to pass.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chooseKeepIndex, DEFAULT_KEEP_RULE } from "../js/common.js";

const JS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "js");

describe("one keeper decision, shared", () => {
  test("no module reimplements the keep rules privately", () => {
    // The giveaway is a local function whose name shadows the shared one, or a
    // second switch over the keep-rule names.
    const offenders = [];
    for (const f of ["compare.js", "render.js", "exporter.js", "crop.js", "scan.js", "queue.js"]) {
      const src = readFileSync(join(JS_DIR, f), "utf8");
      // Strip comments so the explanatory note in compare.js does not trip this.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/function\s+chooseKeepIndex\w+/.test(code)) offenders.push(`${f}: private chooseKeepIndex* function`);
      if (/case\s+["']hires["']\s*:/.test(code))       offenders.push(`${f}: its own switch over keep rules`);
    }
    assert.deepEqual(offenders, [], "the keeper is decided in common.js only");
  });

  test("compare.js imports the shared decision", () => {
    const src = readFileSync(join(JS_DIR, "compare.js"), "utf8");
    assert.match(src, /import\s*\{[^}]*chooseKeepIndex[^}]*\}\s*from\s*["']\.\/common\.js["']/);
  });

  // Regression 1: the copy's res() fell back to the byte count, so a pixel
  // count was compared against a byte count.
  test("hires prefers known dimensions over a merely larger file", () => {
    const group = [
      { id: "a", name: "IMG_0001.jpg", size: "95000", imageMediaMetadata: { width: 800, height: 600 },
        createdTime: "2019-01-01T00:00:00Z", modifiedTime: "2019-01-01T00:00:00Z" },
      // 5,000,000 bytes "beats" 480,000 pixels only if you compare the two.
      { id: "b", name: "thumb-copy.tif", size: "5000000",
        createdTime: "2020-01-01T00:00:00Z", modifiedTime: "2020-01-01T00:00:00Z" },
    ];
    assert.equal(chooseKeepIndex(group, "hires"), 0, "the file whose resolution we know is the better-evidenced keeper");
  });

  // Regression 2: the copy matched the priority term against parents[0] (an
  // opaque Drive ID) and against the file's own name.
  test("folderPriority matches the folder path, not the file name", () => {
    const group = [
      { id: "a", name: "sunset.jpg", _path: "/My Drive/Screenshots", parents: ["0Boriginals123"],
        size: "100", createdTime: "2019-01-01T00:00:00Z", modifiedTime: "2019-01-01T00:00:00Z" },
      { id: "b", name: "originals-backup.jpg", _path: "/My Drive/Downloads", parents: ["0Bxyz"],
        size: "100", createdTime: "2020-01-01T00:00:00Z", modifiedTime: "2020-01-01T00:00:00Z" },
    ];
    // Neither path contains "originals", so neither ranks -- and the tie-break,
    // not a spurious name or ID match, decides.
    const keep = group[chooseKeepIndex(group, "folderPriority", "originals")];
    assert.notEqual(keep.name, "originals-backup.jpg", "a file NAME containing the term must not win the folder rule");

    // And when a real path does contain it, that file wins.
    const real = [
      { ...group[0], _path: "/My Drive/Screenshots" },
      { ...group[1], name: "b.jpg", _path: "/My Drive/Originals/2020" },
    ];
    assert.equal(chooseKeepIndex(real, "folderPriority", "originals"), 1);
  });

  // Regression 3: the copy fell through its switch and kept index 0.
  test("an unrecognised keep rule still applies the deterministic tie-break", () => {
    const group = [
      { id: "zzz", name: "late.jpg",  size: "100", createdTime: "2024-01-01T00:00:00Z", modifiedTime: "2024-01-01T00:00:00Z" },
      { id: "aaa", name: "early.jpg", size: "100", createdTime: "2011-01-01T00:00:00Z", modifiedTime: "2011-01-01T00:00:00Z" },
    ];
    assert.equal(group[chooseKeepIndex(group, "typo-rule")].name, "early.jpg",
      "the earliest upload is the most likely original");
  });

  // Regression 4: no tie-break meant group order decided, and group order comes
  // from union-find iteration, which is not stable between runs.
  test("a genuine tie resolves the same way whatever the group order", () => {
    const a = { id: "zzz", name: "copy.jpg",     size: "500", createdTime: "2022-06-01T00:00:00Z", modifiedTime: "2022-06-01T00:00:00Z" };
    const b = { id: "aaa", name: "original.jpg", size: "500", createdTime: "2015-03-01T00:00:00Z", modifiedTime: "2015-03-01T00:00:00Z" };
    const forward = [a, b], backward = [b, a];
    assert.equal(forward[chooseKeepIndex(forward, "largest")].name, "original.jpg");
    assert.equal(backward[chooseKeepIndex(backward, "largest")].name, "original.jpg");
  });

  test("DEFAULT_KEEP_RULE is a rule the comparator actually knows", () => {
    const group = [
      { id: "a", name: "small.jpg", size: "100", imageMediaMetadata: { width: 100, height: 100 },
        createdTime: "2019-01-01T00:00:00Z", modifiedTime: "2019-01-01T00:00:00Z" },
      { id: "b", name: "big.jpg",   size: "100", imageMediaMetadata: { width: 900, height: 900 },
        createdTime: "2020-01-01T00:00:00Z", modifiedTime: "2020-01-01T00:00:00Z" },
    ];
    assert.equal(chooseKeepIndex(group, DEFAULT_KEEP_RULE), 1, "the default must not be a no-op");
  });
});
