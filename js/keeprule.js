/*
 * Drive Dupe Destroyer (DDD) — keeprule.js
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
// Which file of a duplicate group is the one to KEEP (#121).
//
// Product judgement, not maths, and the most consequential decision the app
// makes: everything else in the group becomes a delete candidate. It lived at
// line 569 of common.js, in a file read as "the distance module", which is the
// wrong home for the one function #50 went to the trouble of centralising.
//
// Consulted by render.js for which row is the keeper, by the exporter, and by
// every path that offers a bulk delete.

/**
 * Choose which file to keep in a duplicate group
 * Fixed: Uses file size as fallback when imageMediaMetadata is missing
 */
// The keep rule used when the #keepRule element is missing or empty.
//
// scan.js defaulted to "hires" while render.js defaulted to "newest", so a
// missing element made the scan pipeline and the render pipeline nominate
// different keepers for the same group. Since the keeper is the one file NOT
// offered for deletion, that divergence is a correctness problem. One constant,
// used by every call site.
export const DEFAULT_KEEP_RULE = "hires";

export function chooseKeepIndex(group, keepRule, folderPriorityCsv = "") {
  if (!Array.isArray(group) || group.length <= 1) return 0;
  
  const mod = f => Date.parse(f.modifiedTime || 0) || 0;
  const size = f => Number(f.size || 0) || 0;

  // Pixel count, or null when Drive gave us no dimensions.
  //
  // This deliberately does NOT fall back to the byte count. Doing so compared a
  // pixel count against a byte count, so a 5 MB file with no imageMediaMetadata
  // beat a genuine 800x600 original -- and Drive routinely omits that metadata
  // for exactly the formats most likely to be the master copy (PSD, RAW, TIFF,
  // and anything it typed as application/octet-stream). Under a "hires" rule a
  // file whose resolution we actually know is always the better-evidenced
  // keeper; size only decides between two files that are both unknown.
  const pixels = f => {
    const w = Number(f.imageMediaMetadata?.width || 0);
    const h = Number(f.imageMediaMetadata?.height || 0);
    return (w > 0 && h > 0) ? w * h : null;
  };

  // Parse and cache folder priority lookup
  const folderPriority = (folderPriorityCsv || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const NO_FOLDER_MATCH = Number.MAX_SAFE_INTEGER;

  // Rank by the RESOLVED folder path only.
  //
  // This used to also test f.parents[0] -- an opaque Drive folder ID -- and
  // f.name, the file's own name. Neither is a folder name, so a pattern could
  // match for reasons the user never intended, and the help text ("folder name
  // patterns") described behaviour the code did not have.
  const folderRank = (f) => {
    if (folderPriority.length === 0) return NO_FOLDER_MATCH;
    const path = (f._path || "").toLowerCase();
    if (!path) return NO_FOLDER_MATCH;
    for (let i = 0; i < folderPriority.length; i++) {
      if (path.includes(folderPriority[i])) return i;
    }
    return NO_FOLDER_MATCH;
  };

  // Comparators return > 0 when b is the better keeper, < 0 when a is, and 0 for
  // a genuine tie -- which the loop below then breaks deterministically.
  const compare = {
    newest:         (a, b) => mod(b) - mod(a),
    oldest:         (a, b) => mod(a) - mod(b),
    largest:        (a, b) => size(b) - size(a),
    smallest:       (a, b) => size(a) - size(b),
    folderPriority: (a, b) => folderRank(a) - folderRank(b),
    hires: (a, b) => {
      const pa = pixels(a), pb = pixels(b);
      if (pa !== null && pb !== null) return pb - pa;   // both known: more pixels wins
      if (pa !== null) return -1;                       // only a known: prefer a
      if (pb !== null) return 1;                        // only b known: prefer b
      return size(b) - size(a);                         // neither known: fall back to bytes
    },
  }[keepRule] ?? (() => 0);

  let best = 0;

  for (let i = 1; i < group.length; i++) {
    const a = group[best], b = group[i];
    let verdict = compare(a, b);

    // Deterministic tie-break. Without this the keeper depended on group order,
    // which comes from union-find iteration and is not stable between runs -- so
    // the same library scanned twice could nominate a different file to delete.
    // createdTime first (the earliest upload is the most likely original), then
    // the Drive ID, which is stable and unique.
    if (verdict === 0) {
      const ca = Date.parse(a.createdTime || 0) || 0;
      const cb = Date.parse(b.createdTime || 0) || 0;
      verdict = ca !== cb ? ca - cb : String(a.id).localeCompare(String(b.id));
    }

    if (verdict > 0) best = i;
  }

  return best;
}
