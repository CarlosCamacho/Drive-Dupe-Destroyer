/*
 * Drive Dupe Destroyer (DDD) — resultsModel.js
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
// The results table as data, with no DOM in sight (#123).
//
// js/render.js keeps 15 module-level `let`s and 8 module-level Maps and Sets --
// currentState, allRows, selected, idToFile, keepOverrides, _simCache. Every
// one of these calculations used to read them directly, so the only way to
// check which file a group would keep, what the table would sort to, or how
// many bytes a selection would free was to boot the app in a browser and click.
//
// These take their state as arguments instead. render.js passes its module
// state in; a test passes a literal.

import { chooseKeepIndex } from "./keeprule.js";

/**
 * A group's identity, independent of where it currently sits in the table.
 *
 * Keyed on the member ids rather than the group's position, because numbering
 * is re-derived on every filter change and after every delete -- a positional
 * key would move a user's pinned keeper onto a different group (#73).
 */
export function groupSignature(group) {
  return group.map(f => f.id).sort().join("|");
}

/**
 * Which file of a group is the keeper: the user's pin if there is one, the
 * keep rule otherwise.
 *
 * A pin that names a file no longer in the group -- deleted, or the group
 * reshaped by a rescan -- is DROPPED rather than ignored, so it cannot sit
 * there silently overriding nothing.
 */
export function keeperFor(group, rule, folderPriority, overrides) {
  const sig = groupSignature(group);
  const pinned = overrides?.get(sig);
  if (pinned) {
    const match = group.find(f => f.id === pinned);
    if (match) return match;
    overrides.delete(sig);
  }
  return group[chooseKeepIndex(group, rule, folderPriority)] || group[0];
}

/**
 * What the current view could free, and how much of it is selected (#114).
 *
 * Over the rows as filtered, which is the scope the table itself shows.
 * `unknown` counts files Drive reported no size for, so the total can be
 * presented as a floor rather than a promise.
 */
export function sizeStatsFor(rows, selectedIds) {
  let reclaimable = 0, selected = 0, unknown = 0;
  for (const row of rows) {
    if (row.isKeep) continue;
    const bytes = Number(row.file.size);
    if (!Number.isFinite(bytes) || bytes <= 0) { unknown++; continue; }
    reclaimable += bytes;
    if (selectedIds?.has(row.file.id)) selected += bytes;
  }
  return { reclaimable, selected, unknown };
}

/** The value a group sorts on for a given column. */
export function groupSortValue(built, key) {
  const n = (v) => Number(v || 0) || 0;
  switch (key) {
    case "name":   return (built.keepFile.name || "").toLowerCase();
    case "folder": return (built.keepFile._path || "").toLowerCase();
    case "dims": {
      const m = built.keepFile.imageMediaMetadata;
      return n(m?.width) * n(m?.height);
    }
    case "size":
      // What this group would FREE, not what it weighs: the keeper stays.
      return built.members.reduce((sum, f) => f.id === built.keepFile.id ? sum : sum + n(f.size), 0);
    default:
      return 0;
  }
}

/**
 * Sort groups as units, in place.
 *
 * Groups move whole -- sorting rows independently would shred the groups the
 * table exists to show. A null key means the order matching produced, which is
 * otherwise unrecoverable without rescanning (#70).
 */
export function sortGroups(built, key, dir = "desc") {
  if (!key) return built;
  const sign = dir === "asc" ? 1 : -1;
  built.sort((x, y) => {
    const a = groupSortValue(x, key), b = groupSortValue(y, key);
    if (a === b) {
      // Stable and reproducible: fall back to the keeper's id, which is unique.
      return x.keepFile.id < y.keepFile.id ? -1 : x.keepFile.id > y.keepFile.id ? 1 : 0;
    }
    return (typeof a === "string" ? a.localeCompare(b) : a - b) * sign;
  });
  return built;
}

/**
 * Narrow rows by free text, at GROUP level.
 *
 * Matching one file of three and hiding its siblings leaves a lone row with
 * nothing to compare against, which is not a useful thing to show -- so a group
 * survives if any member matches, and survives whole (#72).
 */
export function filterBySearch(rows, searchText) {
  const needle = (searchText || "").trim().toLowerCase();
  if (!needle) return rows;
  const matched = new Set();
  for (const row of rows) {
    const name = (row.file.name || "").toLowerCase();
    const path = (row.file._path || "").toLowerCase();
    if (name.includes(needle) || path.includes(needle)) matched.add(row.groupId);
  }
  return rows.filter(row => matched.has(row.groupId));
}

/** Drop any group left with nothing to compare its keeper against. */
export function dropLoneKeepers(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.groupId, (counts.get(row.groupId) || 0) + 1);
  return rows.filter(row => counts.get(row.groupId) > 1);
}
