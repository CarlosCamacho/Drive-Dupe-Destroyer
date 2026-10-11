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

import { el, bytesToHuman } from "./util.js";
import { confirmAction, UNDO_NOTE } from "./confirm.js";
import { trashFiles, stoppedMessage } from "./trash.js";
import { selectedIds, getIdToFile } from "./render.js";
import { setStatus, setProgress, showSpinner, refreshActionButtons, showToast } from "./ui.js";
import { getExclusions } from "./folderPicker.js";
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

// One bulk trash at a time. The button stayed enabled while a batch ran, so a
// second click trashed the same ids again concurrently: two undo records for
// one delete (Undo then "restored" the batch twice over), two events, two
// toasts. Set before the confirm, so a second click cannot open a second one.
let trashInFlight = false;

export async function trashSelectedNow() {
  if (trashInFlight) return;
  const ids = selectedIds();
  if (!ids.length) {
    showToast("Select at least one image to delete", "info");
    return;
  }

  const { files, skipped } = selectedFilesForBulkAction();

  if (!files.length) {
    showToast("All selected items are in excluded folders", "info");
    return;
  }

  // Say what is at stake in bytes as well as in files (#114). "Move 1,204 to
  // Trash" is a count; "frees 6.1 GB" is the reason the user is here.
  const bytes = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
  let message = `${files.length.toLocaleString()} selected file(s) will be moved to Google Drive Trash`;
  message += bytes > 0 ? `, freeing ${bytesToHuman(bytes)}.` : ".";
  if (skipped > 0) {
    message += ` ${skipped} file(s) in excluded folders will be skipped.`;
  }

  trashInFlight = true;
  const btn = el("btnTrashNow");
  if (btn) btn.disabled = true;
  try {
    if (!await confirmAction({
      title: "Move selected files to Trash?",
      message,
      confirmLabel: `Move ${files.length} to Trash`,
      note: UNDO_NOTE,
      // FILE OBJECTS, not ids. Passing ids here made every row read "Untitled".
      files,
    })) return;

    showSpinner(true);
    setStatus(`Trashing ${files.length} file(s)…`);
    setProgress(0);

    try {
      // trashFiles records the undo, tells the table and offers Undo for the
      // files that were trashed -- including when the run stops part-way, which
      // this path used to drop: files already in Drive's trash got no undo
      // record and stayed selected in the table as if nothing had happened.
      const result = await trashFiles(files);
      setProgress(100);

      if (result.error) {
        console.error(result.error);
        showToast(stoppedMessage(result), "error", 8000);
        setStatus(`Trash stopped after ${result.success.length} file(s).`);
        return;
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
    }
  } finally {
    trashInFlight = false;
    refreshActionButtons();
  }
}
