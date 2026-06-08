/*
 * Drive Dupe Destroyer (DDD) v14.0 — queue.js
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
import { queueList, queueAdd, queueDel, queueClear } from "./db.js";
import { batchTrash } from "./drive.js";
import { setStatus, showSpinner, showToast, lockBodyScroll } from "./ui.js";

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

export async function addToQueue(file) {
  if (!file?.id) return false;
  
  try {
    await queueAdd({
      id: file.id,
      name: file.name || "",
      size: file.size || 0,
      path: file.path || ""
    });
    await renderQueue();
    showToast(`Added "${file.name}" to queue`, "success", 1500);
    return true;
  } catch (e) {
    showToast("Failed to add to queue: " + e.message, "error");
    return false;
  }
}

export async function processQueue() {
  const items = await queueList();
  
  if (items.length === 0) {
    showToast("Queue is empty", "info");
    return;
  }
  
  if (!confirm(`Move ${items.length} queued file(s) to trash?`)) return;
  
  showSpinner(true);
  setStatus(`Processing queue: ${items.length} file(s)…`);
  
  try {
    const ids = items.map(i => i.id);
    const result = await batchTrash(ids);
    
    for (const id of result.success) {
      await queueDel(id);
    }
    
    await renderQueue();
    
    if (result.success.length > 0) {
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: result.success } }));
      showToast(`Trashed ${result.success.length} file(s)`, "success");
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
    queueModal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }
  
  if (btnQueueClear) {
    btnQueueClear.onclick = async () => {
      if (!confirm("Clear the entire queue?")) return;
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
