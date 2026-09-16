/*
 * Drive Dupe Destroyer (DDD) — fileListCache.js
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
// The previous scan's enumeration, so the next one does not repeat it (#116).
//
// #67 corrected the comment that called the Changes reconcile a "delta scan":
// by the time it runs, files.list has already been paginated across every
// selected folder, so the expensive network pass is done and the reconcile
// saves nothing. It closed on that honest fix and deferred the actual saving.
// This is the saving.
//
// Two rules make it safe, and both matter more than the speed:
//
// 1. The cache holds the UNFILTERED enumeration. Size limits and the Image
//    Types selection are applied fresh on every run, so changing them re-widens
//    the scan instead of being permanently narrowed by whatever was cached.
//    Caching the filtered set is the obvious mistake and it is unrecoverable
//    without a manual rescan.
//
// 2. It is keyed on everything that changes WHAT WOULD BE ENUMERATED -- the
//    folders, the exclusions, whether the walk recurses, and the item cap.
//    Anything else and a delta scan silently inherits a stale scope, which is
//    the failure the in-scope check at scan.js:962 exists to prevent and which
//    does not look like a bug: it looks like the app scanning folders you told
//    it not to.

import { stateGet, stateSet } from "./db.js";
import { driveFilePreviewLink } from "./drive.js";

const KEY = "destroyer_filelist_v1";

/** Stale enough that re-enumerating is cheaper than trusting it. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What makes two enumerations comparable.
 *
 * NOT the size limits or the type toggles: those are applied after
 * enumeration, so they do not change what the walk returns. Including them
 * would throw the cache away every time somebody moved a slider.
 */
export function enumerationScopeKey({ folderIds = [], exclusions = [], recursive = true, maxItems = 0 } = {}) {
  const inc = [...folderIds].map(String).sort().join(",");
  const exc = [...(exclusions instanceof Set ? exclusions : (exclusions || []))].map(String).sort().join(",");
  return `${inc}|${exc}|r=${recursive ? 1 : 0}|max=${Number(maxItems) || 0}`;
}

// webViewLink is 16% of the serialised payload and driveFilePreviewLink
// rebuilds it from the id, so storing it is pure redundancy -- the same
// measurement that drove #99 (1.91 MB of 11.91 MB across 20,000 files).
const shrink = ({ webViewLink, ...rest }) => rest;
const rehydrate = (f) => (f.webViewLink ? f : { ...f, webViewLink: driveFilePreviewLink(f) });

export async function saveFileList({ scope, files, visitedFolderIds }) {
  await stateSet(KEY, {
    scope,
    files: (files || []).map(shrink),
    visitedFolderIds: [...(visitedFolderIds || [])],
    savedAt: Date.now(),
  }).catch(() => {});
}

/**
 * The cached enumeration for this scope, or null.
 *
 * Returns null rather than throwing on every disagreement -- wrong scope,
 * too old, malformed -- because the caller's fallback is simply to enumerate,
 * which is always correct. A cache that is unsure must lose.
 */
export async function loadFileList(scope, now = Date.now()) {
  const raw = await stateGet(KEY).catch(() => null);
  if (!raw || raw.scope !== scope) return null;
  if (!Array.isArray(raw.files) || raw.files.length === 0) return null;
  if (!raw.savedAt || now - raw.savedAt > MAX_AGE_MS) return null;
  return {
    files: raw.files.map(rehydrate),
    visitedFolderIds: new Set(raw.visitedFolderIds || []),
    savedAt: raw.savedAt,
  };
}

export async function clearFileList() {
  await stateSet(KEY, null).catch(() => {});
}

/**
 * Apply the Changes feed to a cached enumeration.
 *
 * Pure, so the rules are testable without a Drive: a change is only taken if
 * its parent is a folder this scope actually visited and is not excluded --
 * the Changes API reports the WHOLE Drive, not the selected folders, and
 * without this check it pulled in images from anywhere, including folders the
 * user had explicitly excluded, and offered them as delete candidates.
 */
export function applyChangesToList(files, changes, { visitedFolderIds, exclusions }) {
  const excluded = exclusions instanceof Set ? exclusions : new Set(exclusions || []);
  const visited = visitedFolderIds instanceof Set ? visitedFolderIds : new Set(visitedFolderIds || []);
  const inScope = (f) => {
    const parent = f.parents?.[0];
    if (!parent) return false;
    if (excluded.has(parent)) return false;
    return visited.has(parent);
  };

  const removedIds = new Set(changes.filter(c => c._removed).map(c => c.id));
  const existing = new Set(files.map(f => f.id));

  let added = 0, outOfScope = 0;
  const out = files.filter(f => !removedIds.has(f.id));
  for (const cf of changes.filter(c => c._changed)) {
    if (existing.has(cf.id) || removedIds.has(cf.id)) continue;
    if (!inScope(cf)) { outOfScope++; continue; }
    out.push(cf);
    added++;
  }
  return { files: out, added, removed: removedIds.size, outOfScope, removedIds };
}
