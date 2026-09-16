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
import { addToQueueBatch } from "./queue.js";

export function wireActions() {
  const btnTrashNow = el("btnTrashNow");
  if (btnTrashNow) {
    btnTrashNow.onclick = () => trashSelectedNow();
  }

  const btnQueueSelected = el("btnQueueSelected");
  if (btnQueueSelected) {
    btnQueueSelected.onclick = () => queueSelectedNow();
  }
  
  refreshActionButtons();
}

/**
 * The selection, resolved to files, minus anything in an excluded folder.
 *
 * Both bulk actions need exactly this. trashSelectedNow used to resolve ids and
 * then hand the ID STRINGS to confirmAction as `files` -- so the confirmation
 * for the most destructive path in the app listed "Untitled" with no thumbnail,
 * no path and no size, which is the one thing #109 exists to prevent.
 */
function selectedFilesForBulkAction() {
  const ids = selectedIds();
  const idToFile = getIdToFile();
  const files = ids.map(id => idToFile.get(id)).filter(Boolean).filter(f => !isProtected(f));
  return { files, skipped: ids.length - files.length, total: ids.length };
}

export async function queueSelectedNow() {
  const { files, skipped, total } = selectedFilesForBulkAction();

  if (!total) {
    showToast("Select at least one image to queue", "info");
    return;
  }
  if (!files.length) {
    showToast("All selected items are in excluded folders", "info");
    return;
  }

  // No confirmation: queuing is not destructive and is undone by removing the
  // row, which is the "undo over confirm" rule. The confirmation happens once,
  // at Process Queue, where the deletion actually happens.
  await addToQueueBatch(files);
  if (skipped > 0) {
    showToast(`${skipped} file(s) in excluded folders were not queued`, "info");
  }
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
  const { files, skipped } = selectedFilesForBulkAction();

  if (!files.length) {
    showToast("All selected items are in excluded folders", "info");
    return;
  }

  const filtered = files.map(f => f.id);
  let message = `${files.length.toLocaleString()} selected file(s) will be moved to Google Drive Trash.`;
  if (skipped > 0) {
    message += ` ${skipped} file(s) in excluded folders will be skipped.`;
  }
  
  if (!await confirmAction({
    title: "Move selected files to Trash?",
    message,
    confirmLabel: `Move ${files.length} to Trash`,
    note: UNDO_NOTE,
    // FILE OBJECTS, not ids. Passing ids here made every row read "Untitled".
    files,
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
