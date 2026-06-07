/*
 * Drive Dupe Destroyer (DDD) v14.0 — resume.js
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
