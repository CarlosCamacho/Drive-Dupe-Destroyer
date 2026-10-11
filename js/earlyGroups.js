/*
 * Drive Dupe Destroyer (DDD) — earlyGroups.js
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
// Duplicates that can be shown BEFORE matching runs.
//
// The live table used to stay empty for the whole of hashing -- on a large
// Drive, nearly all of the scan -- because near-duplicate matching needs every
// hash before it can start: whether A matches B depends on images not hashed
// yet. Two kinds of duplicate do not:
//
//   1. Byte-identical files. Drive hands us md5Checksum in the listing, so
//      these are known the moment enumeration ends, before any download.
//   2. Files whose perceptual hash is IDENTICAL. Distance 0 is within every
//      threshold the matcher can be given, and every comparator in distance.js
//      returns 0 for identical base hashes before it looks at anything else
//      (bestDist, bestDistExtended, bestDistWithPHash). So the matcher is
//      certain to put them in the same group too.
//
// That second point is the contract. Every group this module emits is a SUBSET
// of the group the matcher will later emit for the same files, which is what
// lets the live table replace an early group with the matcher's larger one
// rather than showing both. Anything the matcher would decline must therefore
// be declined here as well: a pair the user rejected, and a pair the aspect
// pre-filter separates.

/** Same key format as rejection.js's entryHashStr and matcher.js. */
function hashKey(entry) {
  const h = entry?.base12;
  return h && h.length ? Array.from(h).join(",") : null;
}

/**
 * @param {object} opts
 * @param {Set<string>|string[]} [opts.rejectedKeys]  "hashA|hashB" pairs the user marked as not duplicates
 * @param {(a: object, b: object) => boolean} [opts.compatible]  extra pair test (the aspect pre-filter)
 * @param {Map<string, object[]>} [opts.siblings]  file id -> its byte-identical siblings that were not hashed
 */
export function makeEarlyGrouper({ rejectedKeys = null, compatible = null, siblings = null } = {}) {
  const rejected = rejectedKeys instanceof Set ? rejectedKeys : new Set(rejectedKeys || []);
  const buckets = new Map();   // hash key -> files with that exact hash

  return {
    /**
     * Record one hashed file. Returns `{ key, group }` when this file joins
     * another with the identical hash -- the group to show -- or null.
     */
    add(file, entry) {
      if (!file?.id) return null;
      const key = hashKey(entry);
      if (!key) return null;
      // A rejected pair of identical hashes is "k|k". The user has said these
      // are not duplicates; the matcher honours that, so must we.
      if (rejected.has(`${key}|${key}`)) return null;

      let bucket = buckets.get(key);
      if (!bucket) { bucket = []; buckets.set(key, bucket); }
      if (bucket.some(f => f.id === file.id)) return null;
      if (compatible && bucket.some(f => !compatible(f, file))) return null;

      bucket.push(file);
      for (const s of siblings?.get(file.id) || []) {
        if (!bucket.some(f => f.id === s.id)) bucket.push(s);
      }
      return bucket.length > 1 ? { key: `hash:${key}`, group: bucket.slice() } : null;
    },
  };
}

/**
 * MD5 groups keyed for the live table, and the file id -> unhashed siblings map
 * that lets a hashed representative carry its byte-identical copies into any
 * perceptual group it joins.
 */
export function exactGroupsForLive(exactGroups) {
  const groups = [];
  const siblings = new Map();
  for (const g of exactGroups || []) {
    if (!Array.isArray(g) || g.length < 2) continue;
    groups.push({ key: `md5:${g[0].md5Checksum || g[0].id}`, group: g.slice() });
    siblings.set(g[0].id, g.slice(1));
  }
  return { groups, siblings };
}
