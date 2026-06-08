/*
 * Drive Dupe Destroyer (DDD) v14.0 — resume.js
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

const RESUME_KEY = "destroyer_scan_resume_v1";

export async function saveResumeState(state) {
  // state: { folderIds, exclusions, visitedFolderIds, hashedFileIds, 
  //          options, savedAt, totalImagesFound }
  await stateSet(RESUME_KEY, {
    ...state,
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
  return s;
}

export async function clearResumeState() {
  await stateSet(RESUME_KEY, null).catch(() => {});
}

export function formatResumeDescription(state) {
  if (!state) return "";
  const age = Math.round((Date.now() - state.savedAt) / 60000);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age/60)}h ago`;
  return `${(state.totalImagesFound || 0).toLocaleString()} images found, ` +
         `${(state.visitedFolderIds?.length || 0)} folders scanned (${ageStr})`;
}
