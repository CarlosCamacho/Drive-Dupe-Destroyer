/*
 * Drive Dupe Destroyer (DDD) v14.0 — lsh.js
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
// Locality-Sensitive Hashing with adaptive band configuration
// Significantly reduces O(n²) comparisons for large datasets

/**
 * Configuration for LSH based on hash size and expected threshold
 * More bands = more candidates but fewer false negatives
 * More rows per band = fewer candidates but potentially miss near-matches
 */
const LSH_CONFIGS = {
  // For 64-bit hash (8 bytes) - 8x8 dHash
  64: {
    loose:  { bands: 8, rowsPerBand: 1 },   // threshold ~20
    normal: { bands: 4, rowsPerBand: 2 },   // threshold ~10
    strict: { bands: 2, rowsPerBand: 4 },   // threshold ~5
  },
  // For 144-bit hash (18 bytes) - 12x12 dHash  
  144: {
    loose:  { bands: 12, rowsPerBand: 1 },  // threshold ~20
    normal: { bands: 6, rowsPerBand: 3 },   // threshold ~10
    strict: { bands: 4, rowsPerBand: 4 },   // threshold ~5
  }
};

/**
 * Convert bytes to hex string (cached for performance)
 */
const hexCache = new Map();
function bytesToHex(bytes) {
  // Create a stable key for caching
  const key = bytes.join(',');
  if (hexCache.has(key)) return hexCache.get(key);
  
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] >>> 4).toString(16) + (bytes[i] & 0xF).toString(16);
  }
  
  // Limit cache size
  if (hexCache.size > 100000) hexCache.clear();
  hexCache.set(key, hex);
  
  return hex;
}

/**
 * Generate deterministic, well-distributed byte indices for bands.
 *
 * The previous formula `((offset + r) * prime) % byteLen` clustered around low
 * indices: for the 144-bit/normal config it only ever sampled ~10 of 18 bytes
 * and repeated some bytes across most bands, so differences in the unsampled
 * bytes produced no candidates → missed (false-negative) matches.
 *
 * This version walks a fixed stride (coprime with byteLen where possible) so
 * the union of all band indices covers every byte, and picks distinct bytes
 * within each band (sampling without replacement) for stronger band keys.
 */
function generateBandIndices(byteLen, numBands, rowsPerBand) {
  const bands = [];

  // Choose a stride that is coprime with byteLen so repeated stepping visits
  // every index before repeating. Fall back to 1 if none found.
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  let stride = 1;
  for (const cand of [7, 5, 11, 13, 3, 17, 19, 23]) {
    if (cand < byteLen && gcd(cand, byteLen) === 1) { stride = cand; break; }
  }

  let cursor = 0;
  for (let b = 0; b < numBands; b++) {
    const indices = [];
    const usedInBand = new Set();
    for (let r = 0; r < rowsPerBand; r++) {
      // Advance until we find an index not already used in THIS band, so a
      // band never hashes the same byte twice (which would weaken the key).
      let guard = 0;
      let idx = cursor % byteLen;
      while (usedInBand.has(idx) && guard < byteLen) {
        cursor = (cursor + 1) % byteLen;
        idx = cursor % byteLen;
        guard++;
      }
      usedInBand.add(idx);
      indices.push(idx);
      cursor = (cursor + stride) % byteLen;
    }
    bands.push(indices);
  }

  return bands;
}

/**
 * Generate band keys for a hash
 */
function getBandKeys(hashBytes, bandIndices) {
  const keys = new Array(bandIndices.length);
  
  for (let b = 0; b < bandIndices.length; b++) {
    const indices = bandIndices[b];
    const bandBytes = new Uint8Array(indices.length);
    
    for (let i = 0; i < indices.length; i++) {
      bandBytes[i] = hashBytes[indices[i] % hashBytes.length];
    }
    
    keys[b] = bytesToHex(bandBytes);
  }
  
  return keys;
}

/**
 * Create LSH tables configuration
 * @param {number} bitsCount - Number of bits in hash (64 or 144)
 * @param {string} sensitivity - 'loose', 'normal', or 'strict'
 */
export function makeLshConfig(bitsCount, sensitivity = 'normal') {
  const byteLen = Math.ceil(bitsCount / 8);
  const config = LSH_CONFIGS[bitsCount]?.[sensitivity] || LSH_CONFIGS[144].normal;
  
  return {
    byteLen,
    bitsCount,
    bands: config.bands,
    rowsPerBand: config.rowsPerBand,
    bandIndices: generateBandIndices(byteLen, config.bands, config.rowsPerBand)
  };
}

/**
 * Build LSH index from entries
 * @param {Map} entriesById - Map of id -> {base8, base12, variants}
 * @param {Object} options - Configuration options
 */
export function buildLshIndex(entriesById, { use12 = true, sensitivity = 'normal' } = {}) {
  const bitsCount = use12 ? 144 : 64;
  const config = makeLshConfig(bitsCount, sensitivity);
  
  // Create hash tables for each band
  const tables = new Array(config.bands);
  for (let i = 0; i < config.bands; i++) {
    tables[i] = new Map();
  }
  
  // Index all entries
  let indexed = 0;
  for (const [id, entry] of entriesById.entries()) {
    const h = use12 ? entry.base12 : entry.base8;
    if (!h || h.length === 0) continue;
    
    const keys = getBandKeys(h, config.bandIndices);
    
    for (let b = 0; b < config.bands; b++) {
      const key = keys[b];
      let bucket = tables[b].get(key);
      if (!bucket) {
        bucket = [];
        tables[b].set(key, bucket);
      }
      bucket.push(id);
    }
    
    indexed++;
  }
  
  return {
    tables,
    config,
    use12,
    indexed,
    sensitivity
  };
}

/**
 * Find candidate matches for an entry using LSH
 * Returns a Set of candidate IDs that share at least one band
 */
export function lshCandidates(index, id, entry) {
  const h = index.use12 ? entry.base12 : entry.base8;
  if (!h || h.length === 0) return new Set();
  
  const keys = getBandKeys(h, index.config.bandIndices);
  const candidates = new Set();
  
  for (let b = 0; b < index.tables.length; b++) {
    const bucket = index.tables[b].get(keys[b]);
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        const otherId = bucket[i];
        if (otherId !== id) {
          candidates.add(otherId);
        }
      }
    }
  }
  
  return candidates;
}

/**
 * Multi-probe LSH - also check nearby buckets for better recall
 * This catches near-matches that differ by 1 bit in a band
 */
export function lshCandidatesMultiProbe(index, id, entry, probeCount = 2) {
  const h = index.use12 ? entry.base12 : entry.base8;
  if (!h || h.length === 0) return new Set();
  
  const keys = getBandKeys(h, index.config.bandIndices);
  const candidates = new Set();
  
  // Standard lookup
  for (let b = 0; b < index.tables.length; b++) {
    const bucket = index.tables[b].get(keys[b]);
    if (bucket) {
      for (const otherId of bucket) {
        if (otherId !== id) candidates.add(otherId);
      }
    }
  }
  
  // Multi-probe: check buckets with 1-bit differences
  if (probeCount > 0) {
    for (let b = 0; b < index.config.bandIndices.length; b++) {
      const indices = index.config.bandIndices[b];
      
      // Try flipping bits in the band
      for (let byteIdx = 0; byteIdx < indices.length && probeCount > 0; byteIdx++) {
        const hashIdx = indices[byteIdx] % h.length;
        
        for (let bit = 0; bit < 8 && probeCount > 0; bit++) {
          // Create modified band bytes
          const modifiedBytes = new Uint8Array(indices.length);
          for (let i = 0; i < indices.length; i++) {
            modifiedBytes[i] = h[indices[i] % h.length];
          }
          modifiedBytes[byteIdx] ^= (1 << bit);
          
          const probeKey = bytesToHex(modifiedBytes);
          const probeBucket = index.tables[b].get(probeKey);
          
          if (probeBucket) {
            for (const otherId of probeBucket) {
              if (otherId !== id) candidates.add(otherId);
            }
          }
        }
      }
    }
  }
  
  return candidates;
}

/**
 * Get statistics about the LSH index
 */
export function lshStats(index) {
  let totalBuckets = 0;
  let totalEntries = 0;
  let maxBucketSize = 0;
  let singletons = 0;
  
  for (const table of index.tables) {
    totalBuckets += table.size;
    for (const bucket of table.values()) {
      totalEntries += bucket.length;
      maxBucketSize = Math.max(maxBucketSize, bucket.length);
      if (bucket.length === 1) singletons++;
    }
  }
  
  const avgBucketSize = totalBuckets > 0 ? totalEntries / totalBuckets : 0;
  
  // Estimate collision rate
  const expectedComparisons = index.indexed * (index.indexed - 1) / 2;
  const estimatedCandidates = totalEntries * avgBucketSize / 2;
  const reductionFactor = expectedComparisons > 0 
    ? (1 - estimatedCandidates / expectedComparisons) * 100 
    : 0;
  
  return {
    tables: index.tables.length,
    bands: index.config.bands,
    rowsPerBand: index.config.rowsPerBand,
    indexed: index.indexed,
    totalBuckets,
    avgBucketSize: avgBucketSize.toFixed(2),
    maxBucketSize,
    singletons,
    estimatedReduction: `${reductionFactor.toFixed(1)}%`
  };
}

/**
 * Clear hex cache (call periodically for long-running operations)
 */
export function clearLshCache() {
  hexCache.clear();
}

/**
 * Adaptive LSH - automatically chooses sensitivity based on dataset size
 */
export function buildAdaptiveLshIndex(entriesById, { use12 = true, targetThreshold = 10 } = {}) {
  const count = entriesById.size;
  
  // Choose sensitivity based on dataset size and threshold
  let sensitivity = 'normal';
  
  if (count > 10000) {
    // Large dataset: use stricter LSH to reduce comparisons
    sensitivity = targetThreshold <= 5 ? 'strict' : 'normal';
  } else if (count < 1000) {
    // Small dataset: use loose LSH to ensure we don't miss matches
    sensitivity = 'loose';
  } else {
    // Medium dataset: base on threshold
    sensitivity = targetThreshold >= 15 ? 'loose' : 
                  targetThreshold <= 6 ? 'strict' : 'normal';
  }
  
  console.log(`[LSH] Using ${sensitivity} sensitivity for ${count} entries (threshold: ${targetThreshold})`);
  
  return buildLshIndex(entriesById, { use12, sensitivity });
}

// ============================================================================
// Feature #15: Two-pass LSH with dynamic band tuning
// Samples 5% of library to estimate Hamming distance distribution,
// then tunes band/row config to hit target false-negative rate (<1%).
// ============================================================================

/**
 * Sample distance distribution from a random subset of entries.
 * Returns { p10, p25, p50, p75, p90 } percentiles of Hamming distances.
 */
export function sampleDistanceDistribution(entriesById, { use12 = true, sampleRate = 0.05, maxSamples = 500 } = {}) {
  const ids = Array.from(entriesById.keys());
  const n = Math.min(maxSamples, Math.max(10, Math.floor(ids.length * sampleRate)));

  // Random sample without replacement (Fisher-Yates partial)
  const sample = [];
  const copy = ids.slice();
  for (let i = 0; i < n && copy.length > 0; i++) {
    const j = Math.floor(Math.random() * copy.length);
    sample.push(copy[j]);
    copy.splice(j, 1);
  }

  const distances = [];
  const bitsKey = use12 ? 'base12' : 'base8';

  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < Math.min(sample.length, i + 20); j++) {
      const a = entriesById.get(sample[i])?.[bitsKey];
      const b = entriesById.get(sample[j])?.[bitsKey];
      if (!a || !b) continue;
      let dist = 0;
      const len = Math.min(a.length, b.length);
      for (let k = 0; k < len; k++) {
        let x = a[k] ^ b[k];
        while (x) { dist += x & 1; x >>>= 1; }
      }
      distances.push(dist);
    }
  }

  if (distances.length === 0) return null;

  distances.sort((a, b) => a - b);
  const pct = (p) => distances[Math.floor(distances.length * p / 100)];

  return {
    count: distances.length,
    p10: pct(10), p25: pct(25), p50: pct(50), p75: pct(75), p90: pct(90),
    mean: distances.reduce((s, v) => s + v, 0) / distances.length
  };
}

/**
 * Choose optimal LSH config based on sampled distribution and target threshold.
 * Returns sensitivity: 'loose' | 'normal' | 'strict'
 */
export function autoTuneLshSensitivity(distStats, hamThresh) {
  if (!distStats) return 'normal';

  // If the 10th percentile (closest pairs) is already above threshold,
  // we need a loose config to catch anything
  if (distStats.p10 > hamThresh * 1.5) return 'loose';

  // If the median is well below threshold, strict config reduces false candidates
  if (distStats.p50 < hamThresh * 0.5) return 'strict';

  return 'normal';
}

/**
 * Build LSH index with automatic band tuning (Feature #15).
 * Falls back to standard adaptive index if dataset too small to sample.
 */
export function buildAutoTunedLshIndex(entriesById, { use12 = true, targetThreshold = 10, forceMode = 'auto' } = {}) {
  if (forceMode !== 'auto') {
    return buildAdaptiveLshIndex(entriesById, { use12, targetThreshold });
  }

  const n = entriesById.size;
  if (n < 200) {
    // Too small to sample meaningfully; use standard adaptive
    return buildAdaptiveLshIndex(entriesById, { use12, targetThreshold });
  }

  const distStats = sampleDistanceDistribution(entriesById, { use12 });
  const sensitivity = autoTuneLshSensitivity(distStats, targetThreshold);

  if (distStats) {
    console.log(`[LSH AutoTune] n=${n} p10=${distStats.p10} p50=${distStats.p50} p90=${distStats.p90} → sensitivity=${sensitivity}`);
  }

  const bitsCount = use12 ? 144 : 64;
  return { ...buildLshIndex(entriesById, { use12, sensitivity }), autoTuned: true, distStats, sensitivity };
}
