/*
 * Drive Dupe Destroyer (DDD) v14.0 — phash.js
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
// DCT-based perceptual hash (pHash) - Feature #7
// Orthogonal to dHash: captures low-frequency structure rather than local gradients.
// Catches brightness shifts, gamma corrections, JPEG<->PNG conversions.

/**
 * Compute DCT-II on a 1D array (in-place, returns new array)
 * Using the standard formula for a length-N DCT
 */
function dct1d(v) {
  const N = v.length;
  const out = new Float32Array(N);
  const pi_over_N = Math.PI / N;
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) {
      s += v[n] * Math.cos(pi_over_N * (n + 0.5) * k);
    }
    out[k] = s;
  }
  return out;
}

/**
 * Compute 2D DCT by separable 1D DCT on rows then columns
 * Works on a flat NxN Float32Array
 */
function dct2d(data, N) {
  const tmp = new Float32Array(N * N);
  // DCT on rows
  for (let r = 0; r < N; r++) {
    const row = data.slice(r * N, r * N + N);
    const d = dct1d(row);
    for (let c = 0; c < N; c++) tmp[r * N + c] = d[c];
  }
  const out = new Float32Array(N * N);
  // DCT on columns
  for (let c = 0; c < N; c++) {
    const col = new Float32Array(N);
    for (let r = 0; r < N; r++) col[r] = tmp[r * N + c];
    const d = dct1d(col);
    for (let r = 0; r < N; r++) out[r * N + c] = d[r];
  }
  return out;
}

/**
 * Compute pHash from an ImageBitmap.
 * Returns Uint8Array of 8 bytes (64 bits).
 * Algorithm:
 *  1. Downscale to 32×32 grayscale
 *  2. 2D DCT
 *  3. Take top-left 8×8 (low frequencies, skip DC component)
 *  4. Compute mean of those 63 values (excluding DC [0,0])
 *  5. Hash bit = 1 if value > mean
 */
export function computePHash(bitmap) {
  const SIZE = 32;
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const img = ctx.getImageData(0, 0, SIZE, SIZE).data;

  // Convert to grayscale float
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const idx = i * 4;
    gray[i] = 0.299 * img[idx] + 0.587 * img[idx + 1] + 0.114 * img[idx + 2];
  }

  const dct = dct2d(gray, SIZE);

  // Extract top-left 8×8 block (low frequencies)
  const FREQ = 8;
  const freqs = new Float32Array(FREQ * FREQ);
  for (let r = 0; r < FREQ; r++) {
    for (let c = 0; c < FREQ; c++) {
      freqs[r * FREQ + c] = dct[r * SIZE + c];
    }
  }

  // Mean excluding DC component (index 0)
  let sum = 0;
  for (let i = 1; i < freqs.length; i++) sum += freqs[i];
  const mean = sum / (freqs.length - 1);

  // Build 64-bit hash (skip DC at index 0, use indices 1..63)
  const bits = new Uint8Array(8);
  for (let i = 1; i < 64; i++) {
    if (freqs[i] > mean) {
      bits[(i - 1) >> 3] |= 1 << (7 - ((i - 1) & 7));
    }
  }

  return bits;
}

/**
 * Hamming distance between two pHash Uint8Arrays (8 bytes each)
 */
export function pHashDistance(a, b) {
  if (!a || !b || a.length !== 8 || b.length !== 8) return Infinity;
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    let x = a[i] ^ b[i];
    while (x) { dist += x & 1; x >>>= 1; }
  }
  return dist;
}

/**
 * Convert pHash distance to equivalent dHash-scale threshold fraction.
 * pHash is 64 bits; dHash12 is 144 bits.
 * Normalize so callers can use a single threshold.
 */
export function pHashNormalized(dist) {
  return dist / 64;
}
