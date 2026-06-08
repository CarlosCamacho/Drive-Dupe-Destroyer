/*
 * Drive Dupe Destroyer (DDD) v14.0 — undo.js
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
