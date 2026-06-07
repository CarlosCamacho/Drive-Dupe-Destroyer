/*
 * Drive Dupe Destroyer (DDD) v14.0 — worker-hash.js
 *
 * Copyright (c) 2025 Carlos Camacho
 * SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Web Worker for computing perceptual hashes
// Added: crop-resistant center hash, multi-region hashing, color histogram, edge texture histogram

/* global self */

// Reusable OffscreenCanvas pool. Allocating a new OffscreenCanvas + 2D context
// for every hash/region/histogram call (6-10+ per image, across thousands of
// images) is a real source of GC churn. Canvases are keyed by dimensions and
// reused; contexts are created once with willReadFrequently for fast readback.
const _canvasPool = new Map();
function getPooledCtx(w, h) {
  const key = w + "x" + h;
  let entry = _canvasPool.get(key);
  if (!entry) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    entry = { canvas, ctx };
    _canvasPool.set(key, entry);
  } else {
    // Clear any prior contents so stale pixels can't leak between images.
    entry.ctx.clearRect(0, 0, w, h);
  }
  return entry.ctx;
}

function packBits(bits) {
  const byteLen = Math.ceil(bits.length / 8);
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= (1 << (7 - (i & 7)));
  }
  return out;
}

function dhashFromBitmap(bitmap, size) {
  const W = size + 1, H = size;
  const ctx = getPooledCtx(W, H);
  ctx.drawImage(bitmap, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H).data;
  
  const bits = new Array(size * size);
  let k = 0;
  
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i1 = (y * W + x) * 4;
      const i2 = (y * W + (x + 1)) * 4;
      const g1 = 0.299 * img[i1] + 0.587 * img[i1 + 1] + 0.114 * img[i1 + 2];
      const g2 = 0.299 * img[i2] + 0.587 * img[i2 + 1] + 0.114 * img[i2 + 2];
      bits[k++] = g1 > g2 ? 1 : 0;
    }
  }
  
  return packBits(bits);
}

/**
 * Compute dHash for a specific region of a bitmap (for crop detection).
 * Extracts a sub-region, resizes it, and computes the hash.
 */
function dhashFromRegion(bitmap, sx, sy, sw, sh, size) {
  const W = size + 1, H = size;
  const ctx = getPooledCtx(W, H);
  // Draw only the specified region, scaled to hash size
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H).data;
  
  const bits = new Array(size * size);
  let k = 0;
  
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i1 = (y * W + x) * 4;
      const i2 = (y * W + (x + 1)) * 4;
      const g1 = 0.299 * img[i1] + 0.587 * img[i1 + 1] + 0.114 * img[i1 + 2];
      const g2 = 0.299 * img[i2] + 0.587 * img[i2 + 1] + 0.114 * img[i2 + 2];
      bits[k++] = g1 > g2 ? 1 : 0;
    }
  }
  
  return packBits(bits);
}

/**
 * Compute crop-resistant hashes.
 * Strategy: hash the center 60% of the image (crop margins)
 * and hash 4 overlapping quadrants. A cropped version of the original 
 * will share at least one of these regions.
 */
function computeCropHashes(bitmap, size) {
  const w = bitmap.width, h = bitmap.height;
  const regions = [];

  // Center 60% crop
  const cx = Math.round(w * 0.2), cy = Math.round(h * 0.2);
  const cw = Math.round(w * 0.6), ch = Math.round(h * 0.6);
  regions.push({ name: 'center60', sx: cx, sy: cy, sw: cw, sh: ch });

  // Center 80% crop
  const cx2 = Math.round(w * 0.1), cy2 = Math.round(h * 0.1);
  const cw2 = Math.round(w * 0.8), ch2 = Math.round(h * 0.8);
  regions.push({ name: 'center80', sx: cx2, sy: cy2, sw: cw2, sh: ch2 });

  // 4 overlapping quadrants (each 60% of width/height, overlapping at center)
  const qw = Math.round(w * 0.6), qh = Math.round(h * 0.6);
  regions.push({ name: 'topLeft', sx: 0, sy: 0, sw: qw, sh: qh });
  regions.push({ name: 'topRight', sx: w - qw, sy: 0, sw: qw, sh: qh });
  regions.push({ name: 'botLeft', sx: 0, sy: h - qh, sw: qw, sh: qh });
  regions.push({ name: 'botRight', sx: w - qw, sy: h - qh, sw: qw, sh: qh });

  const hashes = [];
  for (const r of regions) {
    if (r.sw < 4 || r.sh < 4) continue; // skip tiny regions
    hashes.push({
      name: r.name,
      hash: dhashFromRegion(bitmap, r.sx, r.sy, r.sw, r.sh, size)
    });
  }
  return hashes;
}

/**
 * Compute a compact color histogram (32 bins: 8R + 8G + 8B + 8 luminance).
 * Normalized to 0-255 per bin. This is crop-independent because color 
 * distribution is approximately preserved across crops.
 */
function computeColorHistogram(bitmap) {
  const S = 64; // sample at small size for speed
  const ctx = getPooledCtx(S, S);
  ctx.drawImage(bitmap, 0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S).data;
  
  const BINS = 8;
  const rHist = new Float32Array(BINS);
  const gHist = new Float32Array(BINS);
  const bHist = new Float32Array(BINS);
  const lHist = new Float32Array(BINS);
  const totalPixels = S * S;
  
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    
    rHist[Math.min(Math.floor(r / 32), BINS - 1)]++;
    gHist[Math.min(Math.floor(g / 32), BINS - 1)]++;
    bHist[Math.min(Math.floor(b / 32), BINS - 1)]++;
    lHist[Math.min(Math.floor(lum / 32), BINS - 1)]++;
  }
  
  // Normalize to 0-255
  const out = new Uint8Array(BINS * 4);
  for (let i = 0; i < BINS; i++) {
    out[i]            = Math.round((rHist[i] / totalPixels) * 255);
    out[BINS + i]     = Math.round((gHist[i] / totalPixels) * 255);
    out[BINS * 2 + i] = Math.round((bHist[i] / totalPixels) * 255);
    out[BINS * 3 + i] = Math.round((lHist[i] / totalPixels) * 255);
  }
  
  return out;
}

/**
 * Compute edge-direction texture histogram using Sobel operator.
 * This captures structural/texture information that survives cropping
 * but is NOT fooled by images that merely share similar colors.
 * 
 * Returns: Uint8Array of 14 bins:
 *   [0-5]  = edge direction histogram (6 angle bins, 0-PI)
 *   [6-9]  = edge strength histogram (4 magnitude bins)
 *   [10-13] = spatial edge density per quadrant (4 quadrants)
 * 
 * Combined with the color histogram, this gives a much more robust 
 * fingerprint than color alone, dramatically reducing false positives
 * on "different images with similar colors."
 */
function computeEdgeTextureHistogram(bitmap) {
  const S = 64;
  const ctx = getPooledCtx(S, S);
  ctx.drawImage(bitmap, 0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S).data;
  
  // Convert to grayscale
  const gray = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    const idx = i * 4;
    gray[i] = 0.299 * img[idx] + 0.587 * img[idx + 1] + 0.114 * img[idx + 2];
  }
  
  // Sobel edge detection
  const DIR_BINS = 6;   // 0-PI in 30° increments
  const MAG_BINS = 4;   // edge strength bins
  const dirHist = new Float32Array(DIR_BINS);
  const magHist = new Float32Array(MAG_BINS);
  // Spatial density: count edges per quadrant
  const quadDensity = new Float32Array(4); // TL, TR, BL, BR
  let totalEdgePoints = 0;
  
  const halfS = S / 2;
  
  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      // Sobel Gx
      const gx = 
        -gray[(y-1)*S + (x-1)] + gray[(y-1)*S + (x+1)]
        -2*gray[y*S + (x-1)]   + 2*gray[y*S + (x+1)]
        -gray[(y+1)*S + (x-1)] + gray[(y+1)*S + (x+1)];
      // Sobel Gy
      const gy = 
        -gray[(y-1)*S + (x-1)] - 2*gray[(y-1)*S + x] - gray[(y-1)*S + (x+1)]
        +gray[(y+1)*S + (x-1)] + 2*gray[(y+1)*S + x] + gray[(y+1)*S + (x+1)];
      
      const mag = Math.sqrt(gx * gx + gy * gy);
      
      // Only count significant edges (threshold ~30 on 0-255 scale)
      if (mag < 30) continue;
      totalEdgePoints++;
      
      // Edge direction: atan2 → [0, PI) (edges have 180° symmetry)
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      const dirBin = Math.min(Math.floor(angle / Math.PI * DIR_BINS), DIR_BINS - 1);
      dirHist[dirBin]++;
      
      // Edge magnitude bin
      const magBin = Math.min(Math.floor(mag / 200 * MAG_BINS), MAG_BINS - 1);
      magHist[magBin]++;
      
      // Quadrant
      const qi = (y < halfS ? 0 : 2) + (x < halfS ? 0 : 1);
      quadDensity[qi]++;
    }
  }
  
  // Normalize all histograms
  const out = new Uint8Array(DIR_BINS + MAG_BINS + 4);
  
  if (totalEdgePoints > 0) {
    for (let i = 0; i < DIR_BINS; i++) {
      out[i] = Math.round((dirHist[i] / totalEdgePoints) * 255);
    }
    for (let i = 0; i < MAG_BINS; i++) {
      out[DIR_BINS + i] = Math.round((magHist[i] / totalEdgePoints) * 255);
    }
    for (let i = 0; i < 4; i++) {
      out[DIR_BINS + MAG_BINS + i] = Math.round((quadDensity[i] / totalEdgePoints) * 255);
    }
  }
  
  return out;
}

function transformBitmap(bitmap, rotateDeg, flipH, flipV) {
  const w = bitmap.width, h = bitmap.height;
  const swap = rotateDeg === 90 || rotateDeg === 270;
  const cw = swap ? h : w;
  const ch = swap ? w : h;
  
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rotateDeg * Math.PI / 180);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(bitmap, -w / 2, -h / 2);
  
  return canvas.transferToImageBitmap();
}


// ============================================================================
// pHash - DCT-based perceptual hash (Feature #7)
// ============================================================================

function dct1d(v) {
  const N = v.length;
  const out = new Float32Array(N);
  const pi_N = Math.PI / N;
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += v[n] * Math.cos(pi_N * (n + 0.5) * k);
    out[k] = s;
  }
  return out;
}

function dct2d(data, N) {
  const tmp = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    const d = dct1d(data.slice(r * N, r * N + N));
    for (let c = 0; c < N; c++) tmp[r * N + c] = d[c];
  }
  const out = new Float32Array(N * N);
  for (let c = 0; c < N; c++) {
    const col = new Float32Array(N);
    for (let r = 0; r < N; r++) col[r] = tmp[r * N + c];
    const d = dct1d(col);
    for (let r = 0; r < N; r++) out[r * N + c] = d[r];
  }
  return out;
}

function computePHash(bitmap) {
  const SIZE = 32;
  const ctx = getPooledCtx(SIZE, SIZE);
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const img = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const idx = i * 4;
    gray[i] = 0.299 * img[idx] + 0.587 * img[idx + 1] + 0.114 * img[idx + 2];
  }
  const dct = dct2d(gray, SIZE);
  const FREQ = 8;
  const freqs = new Float32Array(FREQ * FREQ);
  for (let r = 0; r < FREQ; r++)
    for (let c = 0; c < FREQ; c++)
      freqs[r * FREQ + c] = dct[r * SIZE + c];
  let sum = 0;
  for (let i = 1; i < freqs.length; i++) sum += freqs[i];
  const mean = sum / (freqs.length - 1);
  const bits = new Uint8Array(8);
  for (let i = 1; i < 64; i++)
    if (freqs[i] > mean) bits[(i - 1) >> 3] |= 1 << (7 - ((i - 1) & 7));
  return bits;
}

// ============================================================================
// Message handler - v11.0 (pHash + rotation variants)
// ============================================================================

self.onmessage = async (ev) => {
  const { id, bitmap, withVariants, withCropDetect, withColorMatch, withPHash, withRotation } = ev.data;

  try {
    const base8 = dhashFromBitmap(bitmap, 8);
    const base12 = dhashFromBitmap(bitmap, 12);

    const variants = [];

    if (withVariants) {
      // Standard flip variants
      const flipTransforms = [
        { rotateDeg: 0, flipH: true, flipV: false },
        { rotateDeg: 0, flipH: false, flipV: true },
      ];
      for (const t of flipTransforms) {
        const b2 = transformBitmap(bitmap, t.rotateDeg, t.flipH, t.flipV);
        variants.push({ base8: dhashFromBitmap(b2, 8), base12: dhashFromBitmap(b2, 12) });
        try { b2.close(); } catch {}
      }
    }

    // Rotation variants (Feature #16) - explicit 90/180/270
    if (withRotation) {
      for (const deg of [90, 180, 270]) {
        const b2 = transformBitmap(bitmap, deg, false, false);
        variants.push({ base8: dhashFromBitmap(b2, 8), base12: dhashFromBitmap(b2, 12) });
        try { b2.close(); } catch {}
      }
    }

    // pHash (Feature #7)
    let pHashBits = null;
    if (withPHash) {
      pHashBits = computePHash(bitmap);
    }

    // Crop detection hashes
    let cropHashes = null;
    if (withCropDetect) {
      cropHashes = computeCropHashes(bitmap, 12).map(ch => ({ name: ch.name, hash: ch.hash }));
    }

    // Color + edge histograms
    let colorHist = null;
    let edgeHist = null;
    if (withColorMatch) {
      colorHist = computeColorHistogram(bitmap);
      edgeHist = computeEdgeTextureHistogram(bitmap);
    }

    const transferList = [
      base8.buffer, base12.buffer,
      ...variants.flatMap(v => [v.base8.buffer, v.base12.buffer])
    ];
    if (cropHashes) for (const ch of cropHashes) transferList.push(ch.hash.buffer);
    if (colorHist) transferList.push(colorHist.buffer);
    if (edgeHist)  transferList.push(edgeHist.buffer);
    if (pHashBits) transferList.push(pHashBits.buffer);

    self.postMessage({ id, ok: true, base8, base12, variants, cropHashes, colorHist, edgeHist, pHashBits }, transferList);
  } catch (e) {
    self.postMessage({ id, ok: false, error: e?.message || String(e) });
  } finally {
    try { bitmap.close(); } catch {}
  }
};
