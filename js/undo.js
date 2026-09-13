/*
 * Drive Dupe Destroyer (DDD) — undo.js
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
// Undo buffer for trash operations.
//
// The stack holds OPERATIONS, not individual files. Trashing 200 files from the
// queue is one undo entry that restores all 200, rather than 200 entries the
// user would have to click through one at a time — of which only the last 50
// used to survive the cap at all.
//
// The stack is persisted to IndexedDB. It used to live only in a module-level
// array, so a refresh wiped it — including the reload sw.js triggers itself when
// a new service worker activates, which meant the app could destroy its own
// undo history without the user doing anything.

import { restoreFromTrash } from "./drive.js";
import { showToast } from "./ui.js";
import { stateSet, stateGet } from "./db.js";

const UNDO_KEY = "destroyer_undo_stack_v1";
const MAX_UNDO_OPS = 50;                       // operations, not files
const UNDO_TTL_MS = 30 * 60 * 1000;            // 30 minutes

// [{ opId, files: [{ fileId, fileName }], trashedAt }]
let undoStack = [];
let loaded = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isFresh(op) {
  return op && typeof op.trashedAt === "number" && Date.now() - op.trashedAt <= UNDO_TTL_MS;
}

/** Load the persisted stack once per session. Safe to call repeatedly. */
export async function loadUndoStack() {
  if (loaded) return undoStack.length;
  loaded = true;
  try {
    const saved = await stateGet(UNDO_KEY);
    if (Array.isArray(saved)) {
      undoStack = saved.filter(isFresh);
    }
  } catch {
    // A load failure is not worth surfacing: an empty undo stack is the safe
    // default, and the files are still recoverable from Google Drive Trash.
  }
  updateUndoButton();
  return undoStack.length;
}

/**
 * Persist without blocking the caller. A trash operation should not wait on
 * IndexedDB, and a failed write only costs the user the in-app shortcut — the
 * files are in Drive Trash either way.
 */
function persist() {
  stateSet(UNDO_KEY, undoStack).catch((e) =>
    console.warn("[Undo] Persist failed:", e?.message || e)
  );
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record one trash operation covering any number of files.
 * @param {Array<{id: string, name?: string}>} files files that were trashed
 */
export function pushUndoDeleteBatch(files) {
  const entries = (files || [])
    .filter((f) => f && f.id)
    .map((f) => ({ fileId: f.id, fileName: f.name || f.id }));

  if (entries.length === 0) return;

  undoStack.push({
    opId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    files: entries,
    trashedAt: Date.now(),
  });
  if (undoStack.length > MAX_UNDO_OPS) undoStack.shift();

  persist();
  updateUndoButton();
}

/** Record a single-file trash operation. */
export function pushUndoDelete(fileId, fileName) {
  pushUndoDeleteBatch([{ id: fileId, name: fileName }]);
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/** Restore every file from the most recent trash operation. */
export async function undoLastDelete() {
  await loadUndoStack();

  // Drop operations that have aged out. Entries are pushed in chronological
  // order, so once the newest is stale the whole stack is.
  undoStack = undoStack.filter(isFresh);

  const op = undoStack.pop();
  if (!op) {
    showToast("Nothing to undo", "info");
    updateUndoButton();
    return;
  }

  const restored = [];
  const failed = [];

  for (const entry of op.files) {
    try {
      await restoreFromTrash(entry.fileId);
      restored.push(entry);
    } catch (e) {
      // A 404 means the file is no longer in Trash — emptied, or already
      // restored by hand. The goal state is met either way, so don't report it
      // as a failure the user needs to act on.
      if (String(e?.message || "").includes("404")) restored.push(entry);
      else failed.push(entry);
    }
  }

  if (failed.length > 0) {
    // Keep what we could not restore so the user can retry, rather than
    // silently dropping those files off the stack.
    undoStack.push({ ...op, files: failed });
  }

  persist();
  updateUndoButton();

  if (restored.length === 0) {
    showToast(
      `Undo failed for ${failed.length} file(s). They remain in Google Drive Trash.`,
      "error",
      6000
    );
  } else if (failed.length > 0) {
    showToast(
      `Restored ${restored.length} file(s); ${failed.length} failed. Try Undo again.`,
      "error",
      6000
    );
  } else if (restored.length === 1) {
    showToast(`Restored: ${restored[0].fileName}`, "success");
  } else {
    showToast(`Restored ${restored.length} file(s)`, "success");
  }

  // NOTE: restored files are not re-inserted into the results table. The row was
  // removed when the file was trashed, and rebuilding it would mean re-deriving
  // the group and its keep selection mid-session. The files are back in Drive;
  // they reappear on the next scan. Deliberately not dispatching an event here —
  // nothing listens for one, and an unhandled event would just be dead wiring.
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Number of undoable operations still within the TTL. */
export function getUndoCount() {
  return undoStack.filter(isFresh).length;
}

/** Number of individual files those operations would restore. */
export function getUndoFileCount() {
  return undoStack.filter(isFresh).reduce((n, op) => n + op.files.length, 0);
}

function updateUndoButton() {
  const btn = document.getElementById("btnUndo");
  if (!btn) return;

  const ops = getUndoCount();
  const files = getUndoFileCount();

  btn.disabled = ops === 0;
  btn.textContent = ops > 0 ? `↩ Undo (${ops})` : "↩ Undo";
  btn.title = ops > 0
    ? `Undo the last delete — restores ${files} file(s) from Google Drive Trash (${ops} operation(s) available)`
    : "Nothing to undo";
}
