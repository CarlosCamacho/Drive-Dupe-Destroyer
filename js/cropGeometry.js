/*
 * Drive Dupe Destroyer (DDD) — cropGeometry.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Noncommercial use only: you may use, copy, modify, and share this
 * software for any noncommercial purpose. Commercial use — including
 * selling it or hosting it as a paid product or service — is NOT permitted.
 * Full terms: see the LICENSE file, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0/
 */
// The crop rectangle, as arithmetic (#123).
//
// js/crop.js holds 31 module-level `let`s -- canvas, ctx, selection, rotation,
// zoomLevel, displayScale, the drag coordinates -- and every one of these
// calculations used to read them directly. That is why the only way to check
// whether a crop rectangle was right was to open the modal, drag on a canvas,
// and read a `dataset` mirror maintained purely for the harness: canvas pixels
// are not inspectable.
//
// None of this needs a canvas. It is rectangles and ratios, and getting it
// wrong crops the wrong part of somebody's photograph and then trashes the
// original, so it is worth being able to test cheaply and exhaustively.

/** Clamp `value` into [min, max]. */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * The source image's dimensions AFTER rotation.
 *
 * At 90 and 270 degrees width and height swap; the crop rectangle is expressed
 * in the rotated frame, so everything downstream depends on this.
 */
export function transformedDimensions(naturalWidth, naturalHeight, rotation) {
  const w = Number(naturalWidth) || 0;
  const h = Number(naturalHeight) || 0;
  const rotated = rotation === 90 || rotation === 270;
  return { width: rotated ? h : w, height: rotated ? w : h };
}

/**
 * How much to shrink the image to fit the modal, times the zoom.
 *
 * Never enlarges past 1 before zoom is applied: blowing a small image up to
 * fill the panel and then cropping it would return a selection in pixels the
 * original does not have.
 */
export function displayScale({ width, height, maxWidth, maxHeight, zoom = 1 }) {
  if (!(width > 0) || !(height > 0)) return 0;
  return Math.min(1, maxWidth / width, maxHeight / height) * zoom;
}

/** Is (x, y) inside the selection? */
export function isInsideSelection(selection, x, y) {
  if (!selection) return false;
  return x >= selection.x && x <= selection.x + selection.width &&
         y >= selection.y && y <= selection.y + selection.height;
}

/**
 * The rectangle a drag from (startX, startY) to (currentX, currentY) describes.
 *
 * Dragging up or left is as valid as down or right, so the corners are sorted
 * rather than assumed, and the end point is clamped to the canvas so a drag
 * that leaves the element does not select outside the image.
 */
export function selectionFromDrag(startX, startY, currentX, currentY, canvasWidth, canvasHeight) {
  const cx = clamp(currentX, 0, canvasWidth);
  const cy = clamp(currentY, 0, canvasHeight);
  return {
    x: Math.min(startX, cx),
    y: Math.min(startY, cy),
    width: Math.abs(cx - startX),
    height: Math.abs(cy - startY),
  };
}

/**
 * Move an existing selection by a drag, without letting it leave the canvas.
 */
export function movedSelection(selection, x, y, dragOffsetX, dragOffsetY, canvasWidth, canvasHeight) {
  return {
    ...selection,
    x: clamp(x - dragOffsetX, 0, canvasWidth - selection.width),
    y: clamp(y - dragOffsetY, 0, canvasHeight - selection.height),
  };
}

/**
 * A selection of a fixed size in SOURCE pixels, placed on the display canvas.
 *
 * Keeps the centre of any existing selection, so changing the locked size
 * adjusts the box in place rather than throwing the user back to the middle of
 * the image. The size is capped at the canvas: a 4000px lock on a 675px canvas
 * means the whole canvas, not a rectangle hanging off the edge.
 */
export function lockedSelection({ targetWidth, targetHeight, canvasWidth, canvasHeight,
                                  sourceWidth, sourceHeight, previous = null }) {
  const scaleX = canvasWidth / sourceWidth;
  const scaleY = canvasHeight / sourceHeight;
  const width = Math.min(targetWidth * scaleX, canvasWidth);
  const height = Math.min(targetHeight * scaleY, canvasHeight);

  if (!previous) {
    return {
      x: Math.max(0, (canvasWidth - width) / 2),
      y: Math.max(0, (canvasHeight - height) / 2),
      width, height,
    };
  }
  const centerX = previous.x + previous.width / 2;
  const centerY = previous.y + previous.height / 2;
  return {
    x: clamp(centerX - width / 2, 0, Math.max(0, canvasWidth - width)),
    y: clamp(centerY - height / 2, 0, Math.max(0, canvasHeight - height)),
    width, height,
  };
}

/**
 * A selection as FRACTIONS of the canvas, which is how it is remembered (#77).
 *
 * Fractions rather than pixels because the point is to reuse the area on the
 * NEXT image, which is a different size -- and on the same image after a zoom
 * or a rotate, which changes the canvas.
 */
export function areaToFractions(selection, canvasWidth, canvasHeight) {
  if (!selection || !(canvasWidth > 0) || !(canvasHeight > 0)) return null;
  return {
    x: selection.x / canvasWidth,
    y: selection.y / canvasHeight,
    w: selection.width / canvasWidth,
    h: selection.height / canvasHeight,
  };
}

/**
 * Put a remembered area back onto whatever canvas is now showing.
 *
 * Clamped rather than rejected when it does not fit: a 16:9 area reused on a
 * 4:3 photo should give the nearest sensible rectangle to adjust, not nothing
 * at all. The 10px floor keeps a degenerate area from coming back as an
 * invisible selection that leaves the Crop button mysteriously disabled.
 */
export function fractionsToArea(area, canvasWidth, canvasHeight) {
  if (!area || !(canvasWidth > 0) || !(canvasHeight > 0)) return null;
  const width = Math.min(canvasWidth, Math.max(10, area.w * canvasWidth));
  const height = Math.min(canvasHeight, Math.max(10, area.h * canvasHeight));
  return {
    x: Math.max(0, Math.min(canvasWidth - width, area.x * canvasWidth)),
    y: Math.max(0, Math.min(canvasHeight - height, area.y * canvasHeight)),
    width, height,
  };
}

/** The selection in the SOURCE image's pixels, which is what gets cropped. */
export function selectionInSourcePixels(selection, canvasWidth, canvasHeight, sourceWidth, sourceHeight) {
  if (!selection) return null;
  return {
    x: Math.round(selection.x * (sourceWidth / canvasWidth)),
    y: Math.round(selection.y * (sourceHeight / canvasHeight)),
    width: Math.round(selection.width * (sourceWidth / canvasWidth)),
    height: Math.round(selection.height * (sourceHeight / canvasHeight)),
  };
}

/** Too small to be a deliberate crop — the threshold the Crop button uses. */
export const MIN_SELECTION_PX = 10;

export function isUsableSelection(selection) {
  return !!selection && selection.width >= MIN_SELECTION_PX && selection.height >= MIN_SELECTION_PX;
}
