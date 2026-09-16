/*
 * Drive Dupe Destroyer (DDD) — test/crop-area.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The remembered crop area (#77): crop the same region out of image after image
// without reselecting it.
//
// The area is stored as FRACTIONS of the displayed image, never pixels. The
// canvas is scaled to fit the window and the next image may be a different size
// entirely, so pixels would land somewhere arbitrary.
//
// This file used to REPRODUCE that arithmetic and then regex the source to
// check the copy still matched, because crop.js held it in a DOM-bound module.
// That is the workaround #123 exists to remove: the mapping now lives in
// js/cropGeometry.js as plain functions over numbers, so these tests call the
// real code instead of a copy of it that could drift.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { areaToFractions, fractionsToArea, isUsableSelection, MIN_SELECTION_PX } from "../js/cropGeometry.js";

const CROP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "js", "crop.js"), "utf8");

// The real functions, not a copy of them.
const capture = areaToFractions;
const apply = fractionsToArea;

describe("remembered crop area", () => {
  test("it really does store fractions, not pixels", () => {
    // No longer a regex over crop.js: the function is right here.
    const area = capture({ x: 250, y: 100, width: 500, height: 200 }, 1000, 400);
    assert.deepEqual(area, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    for (const v of Object.values(area)) {
      assert.ok(v >= 0 && v <= 1, `${v} is not a fraction`);
    }
  });

  test("and refuses to store anything without a canvas to be a fraction OF", () => {
    assert.equal(capture({ x: 0, y: 0, width: 10, height: 10 }, 0, 0), null);
    assert.equal(capture(null, 100, 100), null);
  });

  // The case the feature is for: a run of same-size pictures.
  test("the same rectangle comes back exactly on an identically sized image", () => {
    const sel = { x: 120, y: 80, width: 400, height: 300 };
    const back = apply(capture(sel, 1000, 750), 1000, 750);
    assert.deepEqual(back, { x: 120, y: 80, width: 400, height: 300 });
  });

  test("it survives the canvas being scaled to a different zoom", () => {
    // Same picture, canvas half the size because the window is smaller.
    const sel = { x: 200, y: 100, width: 400, height: 200 };
    const area = capture(sel, 800, 600);
    const back = apply(area, 400, 300);
    assert.deepEqual(back, { x: 100, y: 50, width: 200, height: 100 });
  });

  test("on a differently sized image it maps to the same PART of the picture", () => {
    const sel = { x: 250, y: 0, width: 500, height: 500 };   // middle half, top edge
    const area = capture(sel, 1000, 1000);
    const back = apply(area, 400, 400);
    assert.deepEqual(back, { x: 100, y: 0, width: 200, height: 200 });
  });

  test("an area wider than the new image is clamped, not discarded", () => {
    // A 16:9 selection reused on a narrow portrait canvas.
    const area = { x: 0.1, y: 0.1, w: 1.5, h: 0.4 };
    const back = apply(area, 500, 900);
    assert.equal(back.width, 500, "clamped to the canvas");
    assert.equal(back.x, 0, "and pulled back inside it");
    assert.ok(back.x + back.width <= 500);
  });

  test("an area near the far edge stays inside the new canvas", () => {
    const area = { x: 0.95, y: 0.95, w: 0.2, h: 0.2 };
    const back = apply(area, 1000, 1000);
    assert.ok(back.x + back.width <= 1000, `right edge ${back.x + back.width}`);
    assert.ok(back.y + back.height <= 1000, `bottom edge ${back.y + back.height}`);
  });

  test("a degenerate area still yields something adjustable rather than nothing", () => {
    const back = apply({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 1000, 1000);
    assert.ok(back.width >= 10 && back.height >= 10, "at least the minimum selectable size");
  });

  test("tiny selections are not usable, so a stray click cannot become the remembered area", () => {
    // One threshold, named once, rather than four copies of `< 10` -- one of
    // which was written `> 10` and disagreed at exactly 10px (#123).
    assert.equal(isUsableSelection({ x: 0, y: 0, width: 9, height: 100 }), false);
    assert.equal(isUsableSelection({ x: 0, y: 0, width: 100, height: 9 }), false);
    assert.equal(isUsableSelection({ x: 0, y: 0, width: MIN_SELECTION_PX, height: MIN_SELECTION_PX }), true);
    assert.equal(isUsableSelection(null), false);
    // And crop.js still guards the store with it.
    assert.match(CROP, /if \(!isUsableSelection\(selection\)\) return;/);
  });

  test("the locked fixed-size feature keeps priority over a remembered area", () => {
    // Both want to own the selection; the explicit one wins.
    assert.match(CROP, /if \(isLocked\) return false;/);
  });
});
