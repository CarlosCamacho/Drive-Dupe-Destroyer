/*
 * Drive Dupe Destroyer (DDD) v14.0 — undo.js
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
// Session-scoped undo buffer for trash operations (Feature #9 from original list)
// Keeps last N deleted file IDs with Drive restore capability

import { restoreFromTrash } from "./drive.js";
import { showToast } from "./ui.js";

const MAX_UNDO = 50;
const UNDO_TTL_MS = 30 * 60 * 1000; // 30 minutes

const undoStack = []; // { fileId, fileName, trashedAt }

export function pushUndoDelete(fileId, fileName) {
  undoStack.push({ fileId, fileName, trashedAt: Date.now() });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoButton();
}

export function pushUndoDeleteBatch(files) {
  for (const f of files) pushUndoDelete(f.id, f.name);
}

export async function undoLastDelete() {
  // Purge stale entries
  const now = Date.now();
  while (undoStack.length && now - undoStack[undoStack.length - 1].trashedAt > UNDO_TTL_MS) {
    undoStack.pop();
  }

  const entry = undoStack.pop();
  if (!entry) {
    showToast("Nothing to undo", "info");
    updateUndoButton();
    return;
  }

  try {
    await restoreFromTrash(entry.fileId);
    showToast(`Restored: ${entry.fileName}`, "success");
  } catch (e) {
    showToast(`Undo failed: ${e.message}`, "error");
    // Put it back so user can retry
    undoStack.push(entry);
  }
  updateUndoButton();
}

export function getUndoCount() {
  const now = Date.now();
  return undoStack.filter(e => now - e.trashedAt <= UNDO_TTL_MS).length;
}

function updateUndoButton() {
  const btn = document.getElementById("btnUndo");
  if (!btn) return;
  const count = getUndoCount();
  btn.disabled = count === 0;
  btn.title = count > 0 ? `Undo last delete (${count} available)` : "Nothing to undo";
  btn.textContent = count > 0 ? `↩ Undo (${count})` : "↩ Undo";
}
