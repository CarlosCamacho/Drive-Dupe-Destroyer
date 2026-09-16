/*
 * Drive Dupe Destroyer (DDD) — actions.js
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
// Bulk actions for selected files

import { el } from "./util.js";
import { confirmAction, UNDO_NOTE } from "./confirm.js";
import { batchTrash } from "./drive.js";
import { selectedIds, getIdToFile } from "./render.js";
import { setStatus, setProgress, showSpinner, refreshActionButtons, showToast, showTrashedToast } from "./ui.js";
import { getExclusions } from "./folderPicker.js";
import { pushUndoDeleteBatch, undoLastDelete } from "./undo.js";

export function wireActions() {
  const btnTrashNow = el("btnTrashNow");
  if (btnTrashNow) {
    btnTrashNow.onclick = () => trashSelectedNow();
  }
  
  refreshActionButtons();
}

function isProtected(file) {
  const exclusions = getExclusions();
  const pid = file.parents?.[0] || "";
  return exclusions && exclusions.has(pid);
}

export async function trashSelectedNow() {
  const ids = selectedIds();
  if (!ids.length) {
    showToast("Select at least one image to delete", "info");
    return;
  }

  const idToFile = getIdToFile();
  
  const filtered = ids.filter(id => {
    const file = idToFile.get(id);
    if (!file) return false;
    if (isProtected(file)) return false;
    return true;
  });

  if (!filtered.length) {
    showToast("All selected items are in excluded folders", "info");
    return;
  }
  
  const protectedCount = ids.length - filtered.length;
  let message = `Move ${filtered.length} selected file(s) to trash?`;
  if (protectedCount > 0) {
    message += `\n\n(${protectedCount} file(s) in excluded folders will be skipped)`;
  }
  
  if (!await confirmAction({
    title: "Move selected files to Trash?",
    message,
    confirmLabel: `Move ${filtered.length} to Trash`,
    note: UNDO_NOTE,
    files: filtered,
  })) return;

  showSpinner(true);
  setStatus(`Trashing ${filtered.length} file(s)…`);
  setProgress(0);

  try {
    const result = await batchTrash(filtered);
    
    setProgress(100);
    
    if (result.success.length > 0) {
      // Record the whole batch as ONE undo operation before telling the UI the
      // files are gone. Bulk delete is the most destructive path in the app and
      // previously recorded nothing at all, so Undo had nothing to restore.
      pushUndoDeleteBatch(result.success.map(id => idToFile.get(id)).filter(Boolean));

      window.dispatchEvent(new CustomEvent("ddd:trashed", { 
        detail: { ids: result.success } 
      }));
      showTrashedToast(result.success.length, () => undoLastDelete());
    }
    
    if (result.failed.length > 0) {
      showToast(`Failed to trash ${result.failed.length} file(s)`, "error");
    }
    
    setStatus(`Trashed ${result.success.length} file(s).`);
  } catch (err) {
    console.error(err);
    showToast("Trash failed: " + (err?.message || err), "error");
    setStatus("Trash operation failed.");
  } finally {
    showSpinner(false);
    refreshActionButtons();
  }
}
