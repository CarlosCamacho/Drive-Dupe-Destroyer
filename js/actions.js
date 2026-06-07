/*
 * Drive Dupe Destroyer (DDD) v14.0 — actions.js
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
// Bulk actions for selected files

import { el } from "./util.js";
import { batchTrash } from "./drive.js";
import { selectedIds, getIdToFile } from "./render.js";
import { setStatus, setProgress, showSpinner, refreshActionButtons, showToast } from "./ui.js";
import { getExclusions } from "./folderPicker.js";

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
  
  if (!confirm(message)) return;

  showSpinner(true);
  setStatus(`Trashing ${filtered.length} file(s)…`);
  setProgress(0);

  try {
    const result = await batchTrash(filtered);
    
    setProgress(100);
    
    if (result.success.length > 0) {
      window.dispatchEvent(new CustomEvent("ddd:trashed", { 
        detail: { ids: result.success } 
      }));
      showToast(`Trashed ${result.success.length} file(s)`, "success");
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
