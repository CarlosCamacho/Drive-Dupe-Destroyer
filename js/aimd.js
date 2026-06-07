/*
 * Drive Dupe Destroyer (DDD) v14.0 — aimd.js
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
// AIMD (Additive Increase / Multiplicative Decrease) concurrency controller
// Feature #10 - adaptive throttle for network and hashing concurrency

export class AIMDController {
  constructor({
    min = 2,
    max = 12,
    initial = 6,
    addStep = 1,
    mulFactor = 0.5,
    onUpdate = null
  } = {}) {
    this.min = min;
    this.max = max;
    this.concurrency = Math.max(min, Math.min(max, initial));
    this.addStep = addStep;
    this.mulFactor = mulFactor;
    this.onUpdate = onUpdate;
    this._successStreak = 0;
    this._lastUpdate = 0;
    // Increase only after N consecutive clean batches to avoid thrashing
    this._streakThreshold = 5;
  }

  /**
   * Call after a successful batch of N items.
   */
  onSuccess(batchSize = 1) {
    this._successStreak += batchSize;
    if (this._successStreak >= this._streakThreshold) {
      this._successStreak = 0;
      const prev = this.concurrency;
      this.concurrency = Math.min(this.max, this.concurrency + this.addStep);
      if (this.concurrency !== prev && this.onUpdate) this.onUpdate(this.concurrency);
    }
  }

  /**
   * Call on 429, timeout, or OOM. Halves concurrency immediately.
   */
  onError(isThrottle = false) {
    this._successStreak = 0;
    const prev = this.concurrency;
    this.concurrency = Math.max(this.min, Math.floor(this.concurrency * this.mulFactor));
    if (this.concurrency !== prev) {
      console.log(`[AIMD] ${isThrottle ? "Throttle" : "Error"} → concurrency ${prev}→${this.concurrency}`);
      if (this.onUpdate) this.onUpdate(this.concurrency);
    }
  }

  get value() { return this.concurrency; }

  reset() {
    this.concurrency = Math.max(this.min, Math.min(this.max, 6));
    this._successStreak = 0;
  }
}
