/*
 * Drive Dupe Destroyer (DDD) v14.0 — pool.js
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
