/*
 * Drive Dupe Destroyer (DDD) — resume.js
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
// Scan resume - Feature #4
// Saves scan queue state after each folder batch so crashes/refreshes can resume.

import { stateSet, stateGet } from "./db.js";
import { driveFilePreviewLink } from "./drive.js";

const RESUME_KEY = "destroyer_scan_resume_v1";

/**
 * Fields dropped from the stored file objects because they can be rebuilt.
 *
 * webViewLink is 16% of the serialised state (1.91 MB of 11.91 MB across
 * 20,000 files) and driveFilePreviewLink already falls back to constructing it
 * from the id -- so storing it is pure redundancy in a payload that gets
 * rewritten on every checkpoint (#99). It IS rebuilt on load: the CSV export
 * has a webViewLink column, which would otherwise come back empty for every
 * resumed file.
 */
function shrinkFile(f) {
  const { webViewLink, ...rest } = f;
  return rest;
}

function rehydrateFile(f) {
  return f.webViewLink ? f : { ...f, webViewLink: driveFilePreviewLink(f) };
}

export async function saveResumeState(state) {
  // state: { folderIds, exclusions, visitedFolderIds, pendingFolderIds,
  //          files, options, savedAt, totalImagesFound }
  //
  // pendingFolderIds is the BFS frontier and `files` what has been collected so
  // far — together they are what makes a resume an actual resume rather than a
  // rescan. Written periodically during collection, not once at the end.
  await stateSet(RESUME_KEY, {
    ...state,
    files: Array.isArray(state?.files) ? state.files.map(shrinkFile) : state?.files,
    savedAt: Date.now()
  }).catch(() => {});
}

export async function loadResumeState() {
  const s = await stateGet(RESUME_KEY).catch(() => null);
  if (!s) return null;
  // Expire after 24 hours
  if (!s.savedAt || Date.now() - s.savedAt > 24 * 60 * 60 * 1000) {
    await clearResumeState();
    return null;
  }
  if (Array.isArray(s.files)) s.files = s.files.map(rehydrateFile);
  return s;
}

export async function clearResumeState() {
  await stateSet(RESUME_KEY, null).catch(() => {});
}

export function formatResumeDescription(state) {
  if (!state) return "";
  const age = Math.round((Date.now() - state.savedAt) / 60000);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
  const pending = state.pendingFolderIds?.length || 0;
  return `${(state.totalImagesFound || 0).toLocaleString()} images found, ` +
         `${(state.visitedFolderIds?.length || 0)} folders scanned, ` +
         `${pending} still to go (${ageStr})`;
}
