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
// entirely, so pixels would land somewhere arbitrary. This pins the mapping —
// crop.js holds it in a DOM-bound module, so the arithmetic is reproduced here
// and asserted against the source so it cannot drift silently.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CROP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "js", "crop.js"), "utf8");

// Mirrors rememberCurrentArea / applyRememberedArea in crop.js.
const capture = (sel, cw, ch) => ({ x: sel.x / cw, y: sel.y / ch, w: sel.width / cw, h: sel.height / ch });

function apply(area, cw, ch) {
  const w = Math.min(cw, Math.max(10, area.w * cw));
  const h = Math.min(ch, Math.max(10, area.h * ch));
  const x = Math.max(0, Math.min(cw - w, area.x * cw));
  const y = Math.max(0, Math.min(ch - h, area.y * ch));
  return { x, y, width: w, height: h };
}

describe("remembered crop area", () => {
  test("crop.js really does store fractions, not pixels", () => {
    assert.match(CROP, /x:\s*selection\.x\s*\/\s*canvas\.width/);
    assert.match(CROP, /w:\s*selection\.width\s*\/\s*canvas\.width/);
    assert.match(CROP, /lastArea\.x\s*\*\s*canvas\.width/);
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

  test("tiny selections are not remembered at all", () => {
    // crop.js refuses to store anything under 10px, so a stray click does not
    // become the area every subsequent image inherits.
    assert.match(CROP, /selection\.width\s*<\s*10\s*\|\|\s*selection\.height\s*<\s*10\)\s*return;/);
  });

  test("the locked fixed-size feature keeps priority over a remembered area", () => {
    // Both want to own the selection; the explicit one wins.
    assert.match(CROP, /if \(isLocked\) return false;/);
  });
});
