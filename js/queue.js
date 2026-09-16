/*
 * Drive Dupe Destroyer (DDD) — queue.js
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
// Security: file names escaped before DOM insertion - v7.1.0
// Trash queue management

import { el, escapeHtml, bytesToHuman } from "./util.js";
import { confirmAction, UNDO_NOTE } from "./confirm.js";
import { queueList, queueAdd, queueAddBatch, queueDel, queueClear } from "./db.js";
import { batchTrash } from "./drive.js";
import { setStatus, showSpinner, showToast, lockBodyScroll, showTrashedToast } from "./ui.js";
import { pushUndoDeleteBatch, undoLastDelete } from "./undo.js";

export async function renderQueue() {
  const list = el("queueList");
  const countEl = el("queueCount");
  
  if (!list) return;
  
  try {
    const items = await queueList();
    
    if (countEl) countEl.textContent = String(items.length);
    
    if (items.length === 0) {
      list.innerHTML = '<div class="emptyQueue">Queue is empty</div>';
      return;
    }
    
    const fragment = document.createDocumentFragment();
    
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "queueRow";
      row.setAttribute("data-file-id", item.id);
      row.innerHTML = `
        <div class="queueInfo">
          <b>${escapeHtml(item.name || item.id)}</b>
          <div class="muted">${bytesToHuman(item.size || 0)}</div>
        </div>
        <button class="btnMiniDanger btnRemove" aria-label="Remove from queue">✕</button>
      `;
      
      row.querySelector(".btnRemove").onclick = async () => {
        try {
          await queueDel(item.id);
          await renderQueue();
          showToast("Removed from queue", "success", 1500);
        } catch (e) {
          showToast("Failed to remove: " + e.message, "error");
        }
      };
      
      fragment.appendChild(row);
    }
    
    list.innerHTML = "";
    list.appendChild(fragment);
  } catch (e) {
    console.error("Failed to render queue:", e);
    list.innerHTML = '<div class="errorState">Failed to load queue</div>';
  }
}

/** The stored shape. One place, so the single and batch paths cannot diverge. */
function queueRecord(file) {
  return {
    id: file.id,
    name: file.name || "",
    size: Number(file.size) || 0,
    // The app stores the resolved folder path as _path (render.js); plain
    // `path` was always undefined, so every queued row persisted "".
    path: file._path || file.path || "",
  };
}

export async function addToQueue(file) {
  if (!file?.id) return false;
  
  try {
    await queueAdd(queueRecord(file));
    await renderQueue();
    showToast(`Added "${file.name}" to queue`, "success", 1500);
    return true;
  } catch (e) {
    showToast("Failed to add to queue: " + e.message, "error");
    return false;
  }
}

/**
 * Queue many files at once (#125).
 *
 * The queue exists to accumulate deletions across many groups and run them in
 * one batch, so the bulk path is the one that matters -- and doing it as a loop
 * over addToQueue would be one IndexedDB transaction, one full queue re-render
 * and one toast PER FILE. At 2,000 selected files that is 2,000 of each.
 *
 * Re-queuing a file already in the queue is a no-op rather than an error: the
 * store is keyed on id, so put() overwrites. The count reported is what was
 * actually new, because "Queued 2,000" after a second click on an unchanged
 * selection would be a lie.
 *
 * @returns {Promise<number>} how many were not already queued
 */
export async function addToQueueBatch(files) {
  const records = (files || []).filter(f => f?.id).map(queueRecord);
  if (records.length === 0) return 0;

  try {
    const before = new Set((await queueList()).map(i => i.id));
    const added = records.filter(r => !before.has(r.id)).length;

    await queueAddBatch(records);
    await renderQueue();

    const already = records.length - added;
    const what = added === 1 ? "1 file" : `${added.toLocaleString()} files`;
    showToast(
      already > 0
        ? `Queued ${what} — ${already.toLocaleString()} already in the queue`
        : `Queued ${what}`,
      "success", 2500);
    return added;
  } catch (e) {
    showToast("Failed to add to queue: " + e.message, "error");
    return 0;
  }
}

export async function processQueue() {
  const items = await queueList();
  
  if (items.length === 0) {
    showToast("Queue is empty", "info");
    return;
  }
  
  const queuedBytes = items.reduce((n, i) => n + (Number(i.size) || 0), 0);
  if (!await confirmAction({
    title: "Process the trash queue?",
    message: `${items.length.toLocaleString()} queued file(s) will be moved to Google Drive Trash`
      + (queuedBytes > 0 ? `, freeing ${bytesToHuman(queuedBytes)}.` : "."),
    confirmLabel: `Move ${items.length} to Trash`,
    note: UNDO_NOTE,
    files: items,
  })) return;
  
  showSpinner(true);
  setStatus(`Processing queue: ${items.length} file(s)…`);
  
  // A file that is in Drive's trash has to be recorded whether the run finished
  // or not. batchTrash works in chunks of 100 and a run can stop part-way -- the
  // token expires, the silent refresh needs an interaction the browser will not
  // allow without user activation, and it throws at the next chunk boundary.
  // This used to live inside the try, so that throw skipped all of it: the
  // queue still listed 250 files, 100 of them were already in the trash, and
  // Undo had no record of any of them (#81).
  const settle = async (result) => {
    // Record BEFORE clearing the queue rows -- they are the only place the file
    // names live at this point. This was the one delete path never wired to the
    // undo stack, and it is the bulk one: the queue exists to accumulate
    // deletions across many groups and run them in a single batch, which is
    // exactly the case undo.js was built for.
    const trashed = new Set(result.success);
    pushUndoDeleteBatch(items.filter(i => trashed.has(i.id)));

    for (const id of result.success) {
      // One row that will not delete must not cost us the rest of the cleanup,
      // the event, or the toast.
      try { await queueDel(id); } catch (e) { console.warn("Queue row not removed:", id, e); }
    }

    await renderQueue();

    if (result.success.length > 0) {
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: result.success } }));
    }
  };

  try {
    const ids = items.map(i => i.id);

    let result;
    let stoppedBy = null;
    try {
      result = await batchTrash(ids);
    } catch (e) {
      // batchTrash attaches what it had already done to any error that stops
      // it. Without that record those deletions are invisible to the app.
      if (!e?.partial) throw e;
      result = e.partial;
      stoppedBy = e;
    }

    await settle(result);

    if (result.success.length > 0) {
      showTrashedToast(result.success.length, () => undoLastDelete());
    }

    if (stoppedBy) {
      console.error("Queue processing stopped part-way:", stoppedBy);
      const trailer = result.success.length > 0
        ? ` ${result.success.length} file(s) were trashed and can be restored with Undo.`
        : "";
      showToast(`Queue stopped: ${stoppedBy.message}.${trailer}`, "error", 6000);
      setStatus(`Queue stopped after ${result.success.length} trashed.`);
      return;
    }

    if (result.failed.length > 0) {
      showToast(`Failed to trash ${result.failed.length} file(s)`, "error");
    }

    setStatus(`Queue processed: ${result.success.length} trashed.`);
  } catch (e) {
    console.error("Queue processing failed:", e);
    showToast("Queue processing failed: " + e.message, "error");
    setStatus("Queue processing failed.");
  } finally {
    showSpinner(false);
  }
}

export function wireQueue() {
  const btnQueueOpen = el("btnQueueOpen");
  const btnQueueClose = el("btnQueueClose");
  const queueModal = el("queueModal");
  const btnQueueClear = el("btnQueueClear");
  const btnQueueProcess = el("btnQueueProcess");
  
  if (btnQueueOpen) {
    btnQueueOpen.onclick = async () => {
      if (queueModal) {
        queueModal.style.display = "flex";
        lockBodyScroll(true);
      }
      await renderQueue();
    };
  }
  
  const closeModal = () => {
    if (queueModal) {
      queueModal.style.display = "none";
      lockBodyScroll(false);
    }
  };
  
  if (btnQueueClose) btnQueueClose.onclick = closeModal;
  
  if (queueModal) {
    queueModal.addEventListener("click", (e) => {
      if (e.target === queueModal) closeModal();
    });
    // Listen on document, not the modal. A <div> is not focusable, so it
    // receives no key events unless the user has tabbed onto a control inside
    // it -- Escape simply did nothing. The auth and About modals both listen on
    // document for the same reason.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && queueModal.style.display === "flex") closeModal();
    });
  }
  
  if (btnQueueClear) {
    btnQueueClear.onclick = async () => {
      if (!await confirmAction({
        title: "Clear the queue?",
        message: "The queued files stay in Drive — only the list is emptied.",
        confirmLabel: "Clear queue",
        danger: false,
      })) return;
      try {
        await queueClear();
        await renderQueue();
        showToast("Queue cleared", "success");
      } catch (e) {
        showToast("Failed to clear queue: " + e.message, "error");
      }
    };
  }
  
  if (btnQueueProcess) {
    btnQueueProcess.onclick = () => processQueue();
  }
}
