/*
 * Drive Dupe Destroyer (DDD) v14.0 — aimd.js
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
