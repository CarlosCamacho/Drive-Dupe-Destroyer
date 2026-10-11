/*
 * Drive Dupe Destroyer (DDD) — trash.js
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
// Moving files to Drive Trash, and everything that has to follow when it works.
//
// Six places in the app trash files: the row button, Trash Selected, the queue,
// both Compare deletes, and the crop modal (twice). Each did the same four
// things -- trash, record an undo, tell the results table, offer Undo in a
// toast -- with its own copy, and the copies had drifted:
//
//   - Only the queue handled a run that stopped part-way (#81). Everywhere
//     else, files already in Drive's trash when the token expired at a chunk
//     boundary got no undo record and stayed in the table as if untouched.
//   - Every toast's Undo restored the MOST RECENT delete, not its own.
//   - The crop modal announced a failed trash to the table as a success.
//
// One path now, so they cannot drift again. The queue keeps its own settle step
// (it also clears its rows) but records undo the same way.

import { batchTrash } from "./drive.js";
import { pushUndoDeleteBatch, undoDelete } from "./undo.js";
import { showTrashedToast } from "./ui.js";

/**
 * Trash `files` (Drive file objects; their names go into the undo record).
 *
 * Never loses what was done: if the run stops part-way, the files it HAD
 * trashed are still recorded, announced and offered for undo, and the error
 * that stopped it is returned rather than thrown. Errors before anything was
 * attempted are thrown as before.
 *
 * @returns {Promise<{success: string[], failed: string[], error: Error|null, opId: string|null}>}
 */
export async function trashFiles(files, { signal = null, toast = true } = {}) {
  const byId = new Map();
  for (const f of files || []) if (f?.id) byId.set(f.id, f);
  if (byId.size === 0) return { success: [], failed: [], error: null, opId: null };

  let result;
  let error = null;
  try {
    result = await batchTrash([...byId.keys()], { signal });
  } catch (e) {
    if (!e?.partial) throw e;
    result = e.partial;
    error = e;
  }

  const success = (result.success || []).filter(id => byId.has(id));
  const failed = (result.failed || []).filter(id => byId.has(id));
  let opId = null;
  if (success.length > 0) {
    // Record before announcing: a listener that throws must not cost the undo.
    opId = pushUndoDeleteBatch(success.map(id => byId.get(id)));
    window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: success } }));
    if (toast) showTrashedToast(success.length, () => undoDelete(opId));
  }
  return { success, failed, error, opId };
}

/** One sentence for a run that stopped part-way, for the caller's error toast. */
export function stoppedMessage({ success, error }) {
  const done = success.length > 0
    ? ` ${success.length} file(s) were already trashed and can be restored with Undo.`
    : "";
  return `Trash stopped: ${error?.message || error}.${done}`;
}
