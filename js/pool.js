/*
 * Drive Dupe Destroyer (DDD) v14.0 — pool.js
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
// Memory pooling for hash arrays to reduce GC pressure

/**
 * Object pool for reusable typed arrays
 */
class TypedArrayPool {
  constructor(ArrayType, defaultSize) {
    this.ArrayType = ArrayType;
    this.defaultSize = defaultSize;
    this.pool = [];
    this.allocated = 0;
    this.reused = 0;
  }

  acquire(size = this.defaultSize) {
    if (this.pool.length > 0) {
      const arr = this.pool.pop();
      if (arr.length === size) {
        this.reused++;
        return arr;
      }
    }
    this.allocated++;
    return new this.ArrayType(size);
  }

  release(arr) {
    if (!arr || arr.length === 0) return;
    if (this.pool.length < 500) {
      arr.fill(0);
      this.pool.push(arr);
    }
  }

  clear() {
    this.pool = [];
  }

  getStats() {
    return {
      allocated: this.allocated,
      reused: this.reused,
      pooled: this.pool.length,
      reuseRate: this.allocated > 0 
        ? ((this.reused / (this.allocated + this.reused)) * 100).toFixed(1) + '%' 
        : '0%'
    };
  }
}

// Global pools for common hash sizes
export const hash8Pool = new TypedArrayPool(Uint8Array, 8);
export const hash18Pool = new TypedArrayPool(Uint8Array, 18);

export function acquireHashArray(bytes) {
  if (bytes === 8) return hash8Pool.acquire(8);
  if (bytes === 18) return hash18Pool.acquire(18);
  return new Uint8Array(bytes);
}

export function releaseHashArray(arr) {
  if (!arr) return;
  if (arr.length === 8) hash8Pool.release(arr);
  else if (arr.length === 18) hash18Pool.release(arr);
}

export function getPoolStats() {
  return {
    hash8: hash8Pool.getStats(),
    hash18: hash18Pool.getStats(),
  };
}

export function clearAllPools() {
  hash8Pool.clear();
  hash18Pool.clear();
}
