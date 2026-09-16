/*
 * Drive Dupe Destroyer (DDD) — test/crop-geometry.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The crop rectangle, tested without a canvas (#123).
//
// js/crop.js holds 31 module-level `let`s, and all of this arithmetic used to
// read them directly. The only way to check a crop rectangle was to open the
// modal, drag on a canvas and read a `dataset` mirror kept purely so a harness
// could see anything at all — canvas pixels are not inspectable.
//
// Getting this wrong crops the wrong part of somebody's photograph and then
// offers to trash the original, so it is worth testing exhaustively and in
// milliseconds rather than expensively and partially.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  clamp, transformedDimensions, displayScale, isInsideSelection, selectionFromDrag,
  movedSelection, lockedSelection, selectionInSourcePixels, isUsableSelection,
  MIN_SELECTION_PX,
} from "../js/cropGeometry.js";

describe("rotation", () => {
  test("90 and 270 swap width and height; 0 and 180 do not", () => {
    for (const r of [0, 180]) {
      assert.deepEqual(transformedDimensions(6000, 4000, r), { width: 6000, height: 4000 }, `rotation ${r}`);
    }
    for (const r of [90, 270]) {
      assert.deepEqual(transformedDimensions(6000, 4000, r), { width: 4000, height: 6000 }, `rotation ${r}`);
    }
  });

  test("a missing natural size is 0, not NaN", () => {
    // originalImage can be a <canvas> or an un-decoded <img>, neither of which
    // has naturalWidth — and NaN propagates silently into every rectangle.
    assert.deepEqual(transformedDimensions(undefined, undefined, 0), { width: 0, height: 0 });
  });
});

describe("display scale", () => {
  test("shrinks a large image to fit", () => {
    assert.equal(displayScale({ width: 6000, height: 4000, maxWidth: 1200, maxHeight: 800 }), 0.2);
  });

  test("never enlarges a small one past 1:1 before zoom", () => {
    // Blowing a 100x100 image up to fill the panel and then cropping it would
    // return a selection in pixels the original does not have.
    assert.equal(displayScale({ width: 100, height: 100, maxWidth: 1200, maxHeight: 800 }), 1);
  });

  test("zoom multiplies on top", () => {
    assert.equal(displayScale({ width: 100, height: 100, maxWidth: 1200, maxHeight: 800, zoom: 2 }), 2);
    assert.equal(displayScale({ width: 6000, height: 4000, maxWidth: 1200, maxHeight: 800, zoom: 0.5 }), 0.1);
  });

  test("a zero-sized image gives 0 rather than Infinity", () => {
    assert.equal(displayScale({ width: 0, height: 0, maxWidth: 1200, maxHeight: 800 }), 0);
  });
});

describe("dragging out a selection", () => {
  test("dragging down-right", () => {
    assert.deepEqual(selectionFromDrag(10, 20, 110, 220, 500, 500),
      { x: 10, y: 20, width: 100, height: 200 });
  });

  test("dragging UP-LEFT gives the same rectangle, not a negative one", () => {
    // The corners are sorted rather than assumed. A negative width renders as
    // nothing and reads as the drag having failed.
    assert.deepEqual(selectionFromDrag(110, 220, 10, 20, 500, 500),
      { x: 10, y: 20, width: 100, height: 200 });
  });

  test("a drag that leaves the canvas is clamped to it", () => {
    const s = selectionFromDrag(400, 400, 9999, 9999, 500, 480);
    assert.equal(s.x + s.width, 500);
    assert.equal(s.y + s.height, 480);
  });

  test("and clamped on the near side too", () => {
    const s = selectionFromDrag(100, 100, -9999, -9999, 500, 500);
    assert.equal(s.x, 0);
    assert.equal(s.y, 0);
    assert.equal(s.width, 100);
  });
});

describe("moving an existing selection", () => {
  test("follows the pointer", () => {
    const moved = movedSelection({ x: 0, y: 0, width: 50, height: 50 }, 100, 80, 10, 10, 500, 500);
    assert.deepEqual(moved, { x: 90, y: 70, width: 50, height: 50 });
  });

  test("cannot be pushed off any edge", () => {
    const sel = { x: 0, y: 0, width: 50, height: 50 };
    const far = movedSelection(sel, 9999, 9999, 0, 0, 500, 400);
    assert.deepEqual(far, { x: 450, y: 350, width: 50, height: 50 });
    const near = movedSelection(sel, -9999, -9999, 0, 0, 500, 400);
    assert.deepEqual(near, { x: 0, y: 0, width: 50, height: 50 });
  });
});

describe("the fixed-size lock", () => {
  test("a fresh lock is centred", () => {
    const s = lockedSelection({
      targetWidth: 1000, targetHeight: 1000, canvasWidth: 600, canvasHeight: 400,
      sourceWidth: 6000, sourceHeight: 4000,
    });
    assert.deepEqual(s, { x: 250, y: 150, width: 100, height: 100 });
  });

  test("changing the size keeps the existing centre", () => {
    const prev = { x: 100, y: 100, width: 200, height: 200 };   // centre 200,200
    const s = lockedSelection({
      targetWidth: 1000, targetHeight: 1000, canvasWidth: 600, canvasHeight: 400,
      sourceWidth: 6000, sourceHeight: 4000, previous: prev,
    });
    assert.equal(s.x + s.width / 2, 200);
    assert.equal(s.y + s.height / 2, 200);
  });

  test("a lock bigger than the canvas becomes the whole canvas, not an overhang", () => {
    const s = lockedSelection({
      targetWidth: 99999, targetHeight: 99999, canvasWidth: 600, canvasHeight: 400,
      sourceWidth: 6000, sourceHeight: 4000,
    });
    assert.deepEqual(s, { x: 0, y: 0, width: 600, height: 400 });
  });

  test("and a recentred lock still cannot leave the canvas", () => {
    const prev = { x: 590, y: 390, width: 10, height: 10 };   // hard against the corner
    const s = lockedSelection({
      targetWidth: 4000, targetHeight: 2000, canvasWidth: 600, canvasHeight: 400,
      sourceWidth: 6000, sourceHeight: 4000, previous: prev,
    });
    assert.ok(s.x >= 0 && s.y >= 0, `${s.x},${s.y}`);
    assert.ok(s.x + s.width <= 600, `right edge ${s.x + s.width}`);
    assert.ok(s.y + s.height <= 400, `bottom edge ${s.y + s.height}`);
  });
});

describe("what actually gets cropped", () => {
  test("the selection maps back into the source image's pixels", () => {
    // The user selects on a 600x400 canvas; the crop happens on 6000x4000.
    const src = selectionInSourcePixels({ x: 60, y: 40, width: 300, height: 200 }, 600, 400, 6000, 4000);
    assert.deepEqual(src, { x: 600, y: 400, width: 3000, height: 2000 });
  });

  test("a 1:1 canvas is the identity", () => {
    const sel = { x: 7, y: 9, width: 11, height: 13 };
    assert.deepEqual(selectionInSourcePixels(sel, 100, 100, 100, 100),
      { x: 7, y: 9, width: 11, height: 13 });
  });
});

describe("what counts as a usable selection", () => {
  test("the threshold is one number, applied the same way everywhere", () => {
    // crop.js had FOUR copies of this rule and one of them was written `> 10`
    // where the others were `< 10` — they disagreed at exactly 10px.
    assert.equal(isUsableSelection({ width: MIN_SELECTION_PX, height: MIN_SELECTION_PX }), true);
    assert.equal(isUsableSelection({ width: MIN_SELECTION_PX - 1, height: 500 }), false);
    assert.equal(isUsableSelection({ width: 500, height: MIN_SELECTION_PX - 1 }), false);
  });

  test("nothing selected is not usable", () => {
    assert.equal(isUsableSelection(null), false);
    assert.equal(isUsableSelection(undefined), false);
  });
});

describe("clamp", () => {
  test("bounds in both directions and passes values through", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
  });
});

describe("hit testing", () => {
  test("inside, on the edge, and outside", () => {
    const sel = { x: 10, y: 10, width: 100, height: 100 };
    assert.equal(isInsideSelection(sel, 50, 50), true);
    assert.equal(isInsideSelection(sel, 10, 10), true, "top-left corner counts as inside");
    assert.equal(isInsideSelection(sel, 110, 110), true, "bottom-right corner counts as inside");
    assert.equal(isInsideSelection(sel, 9, 50), false);
    assert.equal(isInsideSelection(sel, 111, 50), false);
    assert.equal(isInsideSelection(null, 50, 50), false);
  });
});
