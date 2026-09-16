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

import { restoreFromTrash, isAlreadyGoneError } from "./drive.js";
import { showToast } from "./ui.js";
import { stateSet, stateGet } from "./db.js";

const UNDO_KEY = "destroyer_undo_stack_v1";
const MAX_UNDO_OPS = 50;                       // operations, not files
const UNDO_TTL_MS = 30 * 60 * 1000;            // 30 minutes

// [{ opId, files: [{ fileId, fileName }], trashedAt }]
let undoStack = [];

// The in-flight (or completed) load, held as a promise rather than a boolean.
//
// `loaded` used to be set to true BEFORE awaiting the read, so a second caller
// got an answer for a stack that had not been read yet -- and the read then
// ASSIGNED over the in-memory stack, discarding anything recorded while it was
// in flight. Meanwhile that operation's fire-and-forget persist() had already
// overwritten the stored stack. Both sides lost: the new delete vanished from
// memory, and every previously recoverable operation vanished from storage
// (#95). Everything that touches the stack now chains off this.
let loadPromise = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isFresh(op) {
  return op && typeof op.trashedAt === "number" && Date.now() - op.trashedAt <= UNDO_TTL_MS;
}

/** Load the persisted stack once per session. Safe to call repeatedly. */
export async function loadUndoStack() {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const saved = await stateGet(UNDO_KEY);
        if (Array.isArray(saved)) {
          // MERGE, never assign. Anything recorded while this read was in
          // flight is already in undoStack and is the most recent thing the
          // user did -- assigning over it threw away the undo record for a
          // delete that had just happened (#95).
          const seen = new Set(undoStack.map((op) => op?.opId));
          const restored = saved.filter((op) => isFresh(op) && !seen.has(op?.opId));
          undoStack = [...restored, ...undoStack];   // oldest first: the stack is chronological
          if (undoStack.length > MAX_UNDO_OPS) {
            undoStack = undoStack.slice(undoStack.length - MAX_UNDO_OPS);
          }
        }
      } catch {
        // A load failure is not worth surfacing: whatever is in memory is the
        // safe default, and the files are still recoverable from Google Drive
        // Trash.
      }
      updateUndoButton();
    })();
  }
  await loadPromise;
  return undoStack.length;
}

/**
 * Persist without blocking the caller. A trash operation should not wait on
 * IndexedDB, and a failed write only costs the user the in-app shortcut — the
 * files are in Drive Trash either way.
 */
function persist() {
  // Chained behind any in-flight load, so a write can never land before the
  // read it would invalidate. Without this the first delete of a session could
  // overwrite the stored stack with just itself, erasing every operation the
  // previous session had left recoverable (#95).
  const write = () =>
    stateSet(UNDO_KEY, undoStack).catch((e) =>
      console.warn("[Undo] Persist failed:", e?.message || e)
    );
  if (loadPromise) loadPromise.then(write, write);
  else write();
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

  // Drop operations that have aged out. Every entry is tested individually
  // rather than trusting the stack to be in age order: a partially failed
  // operation is re-pushed onto the END below while keeping its original
  // trashedAt, so the stack is not strictly chronological.
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
      //
      // By status, not by matching "404" in a message that embeds Drive's error
      // body -- that could report a file we failed to restore as restored (#81).
      if (isAlreadyGoneError(e)) restored.push(entry);
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

  // Undo expires. The button used to give no hint of that, so a user could read
  // "Undo (3)" an hour after the fact and find nothing there (#106).
  const newest = undoStack.filter(isFresh).reduce((t, op) => Math.max(t, op.trashedAt), 0);
  const minsLeft = newest ? Math.max(0, Math.round((UNDO_TTL_MS - (Date.now() - newest)) / 60000)) : 0;

  btn.title = ops > 0
    ? `Undo the last delete (Ctrl+Z) — restores ${files} file(s) from Google Drive Trash. ` +
      `${ops} operation(s) available, expiring in about ${minsLeft} minute(s).`
    : "Nothing to undo";
}
