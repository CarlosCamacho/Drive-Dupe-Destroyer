/*
 * Drive Dupe Destroyer (DDD) v14.0 — wasm-hash.js
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
// WebAssembly hashing module with pure JS fallback
// Provides 2-3x speedup when WASM is available

// ============================================================================
// Module State
// ============================================================================

let wasmModule = null;
let wasmMemory = null;
let wasmExports = null;
let isWasmReady = false;
let wasmLoadPromise = null;

// Memory layout constants
const POPCOUNT_TABLE_OFFSET = 0;
const INPUT_BUFFER_OFFSET = 0x1000;      // 4KB offset
const OUTPUT_BUFFER_OFFSET = 0x10000;    // 64KB offset
const HASH_BUFFER_1_OFFSET = 0x20000;    // 128KB offset
const HASH_BUFFER_2_OFFSET = 0x20100;    // +256 bytes
const CANDIDATES_OFFSET = 0x21000;       // 132KB offset
const RESULTS_OFFSET = 0x30000;          // 192KB offset

// ============================================================================
// Pure JS Fallback Implementation
// ============================================================================

// Precomputed popcount table
const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, c = 0;
  while (v) { c += v & 1; v >>>= 1; }
  POPCOUNT_TABLE[i] = c;
}

/**
 * Pure JS dHash computation (fallback)
 */
function jsDHash(grayscalePixels, width, height) {
  const srcWidth = width + 1;
  const totalBits = width * height;
  const totalBytes = Math.ceil(totalBits / 8);
  const output = new Uint8Array(totalBytes);
  
  let bitIndex = 0;
  let currentByte = 0;
  let byteIndex = 0;
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * srcWidth;
    
    for (let x = 0; x < width; x++) {
      const g1 = grayscalePixels[rowOffset + x];
      const g2 = grayscalePixels[rowOffset + x + 1];
      
      if (g1 > g2) {
        currentByte |= (1 << (7 - (bitIndex & 7)));
      }
      
      bitIndex++;
      
      if ((bitIndex & 7) === 0) {
        output[byteIndex++] = currentByte;
        currentByte = 0;
      }
    }
  }
  
  if ((bitIndex & 7) !== 0) {
    output[byteIndex] = currentByte;
  }
  
  return output;
}

/**
 * Pure JS Hamming distance (fallback)
 */
function jsHammingDistance(hash1, hash2) {
  const len = Math.min(hash1.length, hash2.length);
  let distance = 0;
  
  for (let i = 0; i < len; i++) {
    distance += POPCOUNT_TABLE[hash1[i] ^ hash2[i]];
  }
  
  return distance;
}

/**
 * Pure JS Hamming distance with threshold (fallback)
 */
function jsHammingDistanceThreshold(hash1, hash2, threshold) {
  const len = Math.min(hash1.length, hash2.length);
  let distance = 0;
  
  for (let i = 0; i < len; i++) {
    distance += POPCOUNT_TABLE[hash1[i] ^ hash2[i]];
    if (distance > threshold) return Infinity;
  }
  
  return distance;
}

/**
 * Pure JS RGB to grayscale (fallback)
 */
function jsRgbToGrayscale(rgbaPixels) {
  const pixelCount = rgbaPixels.length / 4;
  const grayscale = new Uint8Array(pixelCount);
  
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    grayscale[i] = Math.round(
      0.299 * rgbaPixels[offset] +
      0.587 * rgbaPixels[offset + 1] +
      0.114 * rgbaPixels[offset + 2]
    );
  }
  
  return grayscale;
}

/**
 * Pure JS bilinear resize (fallback)
 */
function jsResizeGrayscale(src, srcWidth, srcHeight, dstWidth, dstHeight) {
  const dst = new Uint8Array(dstWidth * dstHeight);
  
  const xRatio = (srcWidth - 1) / dstWidth;
  const yRatio = (srcHeight - 1) / dstHeight;
  
  for (let y = 0; y < dstHeight; y++) {
    const yFloor = Math.floor(y * yRatio);
    const yFrac = y * yRatio - yFloor;
    const yNext = Math.min(yFloor + 1, srcHeight - 1);
    
    for (let x = 0; x < dstWidth; x++) {
      const xFloor = Math.floor(x * xRatio);
      const xFrac = x * xRatio - xFloor;
      const xNext = Math.min(xFloor + 1, srcWidth - 1);
      
      const tl = src[yFloor * srcWidth + xFloor];
      const tr = src[yFloor * srcWidth + xNext];
      const bl = src[yNext * srcWidth + xFloor];
      const br = src[yNext * srcWidth + xNext];
      
      const top = tl + (tr - tl) * xFrac;
      const bottom = bl + (br - bl) * xFrac;
      dst[y * dstWidth + x] = Math.round(top + (bottom - top) * yFrac);
    }
  }
  
  return dst;
}

// ============================================================================
// WebAssembly Loading
// ============================================================================

/**
 * Load and initialize WebAssembly module
 */
async function loadWasm() {
  if (wasmLoadPromise) return wasmLoadPromise;
  
  wasmLoadPromise = (async () => {
    try {
      // Check if WASM is supported
      if (typeof WebAssembly === 'undefined') {
        console.warn('[WASM] WebAssembly not supported, using JS fallback');
        return false;
      }
      
      // Try to load the WASM module
      const wasmUrl = new URL('./dhash.wasm', import.meta.url);
      const response = await fetch(wasmUrl);
      
      if (!response.ok) {
        console.warn('[WASM] Failed to fetch WASM module, using JS fallback');
        return false;
      }
      
      const wasmBuffer = await response.arrayBuffer();
      
      // Create memory (256KB initial, can grow)
      wasmMemory = new WebAssembly.Memory({ 
        initial: 4,   // 256KB (4 × 64KB pages)
        maximum: 16   // 1MB max
      });
      
      // Instantiate module
      const { instance } = await WebAssembly.instantiate(wasmBuffer, {
        env: {
          memory: wasmMemory,
          abort: (msg, file, line, col) => {
            console.error(`[WASM] Abort: ${msg} at ${file}:${line}:${col}`);
          }
        }
      });
      
      wasmModule = instance;
      wasmExports = instance.exports;
      
      // Initialize popcount table
      if (wasmExports.initPopcountTable) {
        wasmExports.initPopcountTable();
      }
      
      isWasmReady = true;
      console.log('[WASM] WebAssembly hash module loaded successfully');
      return true;
      
    } catch (e) {
      console.warn('[WASM] Failed to load WASM module:', e.message);
      console.log('[WASM] Using pure JavaScript fallback');
      return false;
    }
  })();
  
  return wasmLoadPromise;
}

/**
 * Check if WASM is ready
 */
export function isWasmAvailable() {
  return isWasmReady;
}

/**
 * Initialize WASM module (call early in app startup)
 */
export async function initWasm() {
  return loadWasm();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute dHash from grayscale pixels
 * @param {Uint8Array} grayscalePixels - Grayscale pixel data (width+1 × height)
 * @param {number} width - Hash width (8 or 12)
 * @param {number} height - Hash height (8 or 12)
 * @returns {Uint8Array} - Hash bytes
 */
export function computeDHash(grayscalePixels, width, height) {
  if (isWasmReady && wasmExports?.computeDHash) {
    try {
      const srcWidth = width + 1;
      const pixelCount = srcWidth * height;
      
      // Copy input to WASM memory
      const inputView = new Uint8Array(wasmMemory.buffer, INPUT_BUFFER_OFFSET, pixelCount);
      inputView.set(grayscalePixels.subarray(0, pixelCount));
      
      // Compute hash
      const hashLength = wasmExports.computeDHash(
        INPUT_BUFFER_OFFSET,
        width,
        height,
        OUTPUT_BUFFER_OFFSET
      );
      
      // Copy result from WASM memory
      const outputView = new Uint8Array(wasmMemory.buffer, OUTPUT_BUFFER_OFFSET, hashLength);
      return new Uint8Array(outputView);
      
    } catch (e) {
      console.warn('[WASM] computeDHash failed, falling back to JS:', e.message);
    }
  }
  
  return jsDHash(grayscalePixels, width, height);
}

/**
 * Compute Hamming distance between two hashes
 * @param {Uint8Array} hash1 
 * @param {Uint8Array} hash2 
 * @returns {number} - Hamming distance
 */
export function hammingDistance(hash1, hash2) {
  if (isWasmReady && wasmExports?.hammingDistance) {
    try {
      const length = Math.min(hash1.length, hash2.length);
      
      // Copy hashes to WASM memory
      const view1 = new Uint8Array(wasmMemory.buffer, HASH_BUFFER_1_OFFSET, length);
      const view2 = new Uint8Array(wasmMemory.buffer, HASH_BUFFER_2_OFFSET, length);
      view1.set(hash1.subarray(0, length));
      view2.set(hash2.subarray(0, length));
      
      return wasmExports.hammingDistance(
        HASH_BUFFER_1_OFFSET,
        HASH_BUFFER_2_OFFSET,
        length
      );
      
    } catch (e) {
      console.warn('[WASM] hammingDistance failed, falling back to JS:', e.message);
    }
  }
  
  return jsHammingDistance(hash1, hash2);
}

/**
 * Compute Hamming distance with early exit threshold
 * @param {Uint8Array} hash1 
 * @param {Uint8Array} hash2 
 * @param {number} threshold 
 * @returns {number} - Distance if <= threshold, otherwise Infinity
 */
export function hammingDistanceThreshold(hash1, hash2, threshold) {
  if (isWasmReady && wasmExports?.hammingDistanceThreshold) {
    try {
      const length = Math.min(hash1.length, hash2.length);
      
      const view1 = new Uint8Array(wasmMemory.buffer, HASH_BUFFER_1_OFFSET, length);
      const view2 = new Uint8Array(wasmMemory.buffer, HASH_BUFFER_2_OFFSET, length);
      view1.set(hash1.subarray(0, length));
      view2.set(hash2.subarray(0, length));
      
      const result = wasmExports.hammingDistanceThreshold(
        HASH_BUFFER_1_OFFSET,
        HASH_BUFFER_2_OFFSET,
        length,
        threshold
      );
      
      return result === 0xFFFFFFFF ? Infinity : result;
      
    } catch (e) {
      console.warn('[WASM] hammingDistanceThreshold failed, falling back to JS:', e.message);
    }
  }
  
  return jsHammingDistanceThreshold(hash1, hash2, threshold);
}

/**
 * Batch compare one hash against multiple candidates
 * @param {Uint8Array} baseHash - The hash to compare against
 * @param {Uint8Array[]} candidateHashes - Array of candidate hashes
 * @param {number} threshold - Maximum distance threshold
 * @returns {Array<{index: number, distance: number}>} - Matches within threshold
 */
export function batchCompare(baseHash, candidateHashes, threshold) {
  if (isWasmReady && wasmExports?.batchCompare && candidateHashes.length > 10) {
    try {
      const hashLength = baseHash.length;
      const candidateCount = candidateHashes.length;
      
      // Copy base hash
      const baseView = new Uint8Array(wasmMemory.buffer, HASH_BUFFER_1_OFFSET, hashLength);
      baseView.set(baseHash);
      
      // Copy candidate hashes
      const candidatesView = new Uint8Array(
        wasmMemory.buffer, 
        CANDIDATES_OFFSET, 
        hashLength * candidateCount
      );
      for (let i = 0; i < candidateCount; i++) {
        candidatesView.set(candidateHashes[i], i * hashLength);
      }
      
      // Run batch compare
      wasmExports.batchCompare(
        HASH_BUFFER_1_OFFSET,
        CANDIDATES_OFFSET,
        hashLength,
        candidateCount,
        threshold,
        RESULTS_OFFSET
      );
      
      // Read results
      const resultsView = new Uint32Array(wasmMemory.buffer, RESULTS_OFFSET, candidateCount);
      const matches = [];
      
      for (let i = 0; i < candidateCount; i++) {
        const dist = resultsView[i];
        if (dist !== 0xFFFFFFFF) {
          matches.push({ index: i, distance: dist });
        }
      }
      
      return matches;
      
    } catch (e) {
      console.warn('[WASM] batchCompare failed, falling back to JS:', e.message);
    }
  }
  
  // JS fallback
  const matches = [];
  for (let i = 0; i < candidateHashes.length; i++) {
    const dist = jsHammingDistanceThreshold(baseHash, candidateHashes[i], threshold);
    if (dist !== Infinity) {
      matches.push({ index: i, distance: dist });
    }
  }
  return matches;
}

/**
 * Convert RGBA pixels to grayscale
 * @param {Uint8Array|Uint8ClampedArray} rgbaPixels - RGBA pixel data
 * @returns {Uint8Array} - Grayscale pixels
 */
export function rgbToGrayscale(rgbaPixels) {
  if (isWasmReady && wasmExports?.rgbToGrayscale) {
    try {
      const pixelCount = rgbaPixels.length / 4;
      const inputSize = pixelCount * 4;
      
      // Copy input
      const inputView = new Uint8Array(wasmMemory.buffer, INPUT_BUFFER_OFFSET, inputSize);
      inputView.set(rgbaPixels);
      
      // Convert
      wasmExports.rgbToGrayscale(INPUT_BUFFER_OFFSET, OUTPUT_BUFFER_OFFSET, pixelCount);
      
      // Copy output
      const outputView = new Uint8Array(wasmMemory.buffer, OUTPUT_BUFFER_OFFSET, pixelCount);
      return new Uint8Array(outputView);
      
    } catch (e) {
      console.warn('[WASM] rgbToGrayscale failed, falling back to JS:', e.message);
    }
  }
  
  return jsRgbToGrayscale(rgbaPixels);
}

/**
 * Resize grayscale image
 * @param {Uint8Array} src - Source grayscale pixels
 * @param {number} srcWidth 
 * @param {number} srcHeight 
 * @param {number} dstWidth 
 * @param {number} dstHeight 
 * @returns {Uint8Array} - Resized grayscale pixels
 */
export function resizeGrayscale(src, srcWidth, srcHeight, dstWidth, dstHeight) {
  if (isWasmReady && wasmExports?.resizeGrayscale) {
    try {
      const srcSize = srcWidth * srcHeight;
      const dstSize = dstWidth * dstHeight;
      
      // Copy source
      const srcView = new Uint8Array(wasmMemory.buffer, INPUT_BUFFER_OFFSET, srcSize);
      srcView.set(src);
      
      // Resize
      wasmExports.resizeGrayscale(
        INPUT_BUFFER_OFFSET,
        srcWidth, srcHeight,
        OUTPUT_BUFFER_OFFSET,
        dstWidth, dstHeight
      );
      
      // Copy output
      const dstView = new Uint8Array(wasmMemory.buffer, OUTPUT_BUFFER_OFFSET, dstSize);
      return new Uint8Array(dstView);
      
    } catch (e) {
      console.warn('[WASM] resizeGrayscale failed, falling back to JS:', e.message);
    }
  }
  
  return jsResizeGrayscale(src, srcWidth, srcHeight, dstWidth, dstHeight);
}

/**
 * Complete dHash pipeline: RGBA → resize → grayscale → hash
 * @param {Uint8Array|Uint8ClampedArray} rgbaPixels - Source RGBA pixels
 * @param {number} srcWidth - Source width
 * @param {number} srcHeight - Source height
 * @param {number} hashSize - Hash dimension (8 or 12)
 * @returns {Uint8Array} - Hash bytes
 */
export function computeDHashFromRGBA(rgbaPixels, srcWidth, srcHeight, hashSize = 12) {
  // Convert to grayscale
  const grayscale = rgbToGrayscale(rgbaPixels);
  
  // Resize to hash dimensions (width+1 for gradient)
  const resized = resizeGrayscale(
    grayscale, 
    srcWidth, 
    srcHeight, 
    hashSize + 1, 
    hashSize
  );
  
  // Compute hash
  return computeDHash(resized, hashSize, hashSize);
}

// ============================================================================
// Diagnostics
// ============================================================================

/**
 * Get WASM module status
 */
export function getWasmStatus() {
  return {
    available: isWasmReady,
    memorySize: wasmMemory ? wasmMemory.buffer.byteLength : 0,
    exports: wasmExports ? Object.keys(wasmExports) : []
  };
}

/**
 * Benchmark WASM vs JS performance
 */
export async function benchmarkWasm(iterations = 1000) {
  // Generate test data
  const testHash1 = new Uint8Array(18);
  const testHash2 = new Uint8Array(18);
  for (let i = 0; i < 18; i++) {
    testHash1[i] = Math.floor(Math.random() * 256);
    testHash2[i] = Math.floor(Math.random() * 256);
  }
  
  // Benchmark JS
  const jsStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    jsHammingDistance(testHash1, testHash2);
  }
  const jsTime = performance.now() - jsStart;
  
  // Benchmark WASM (if available)
  let wasmTime = null;
  if (isWasmReady) {
    const wasmStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      hammingDistance(testHash1, testHash2);
    }
    wasmTime = performance.now() - wasmStart;
  }
  
  return {
    iterations,
    jsTimeMs: jsTime.toFixed(2),
    wasmTimeMs: wasmTime?.toFixed(2) || 'N/A',
    speedup: wasmTime ? (jsTime / wasmTime).toFixed(2) + 'x' : 'N/A'
  };
}
