/*
 * Drive Dupe Destroyer (DDD) v14.0 — folderPicker.js
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
// Added: Include All / Exclude All buttons for visible folder list
// Folder browser with include/exclude in one interface

import { el, escapeHtml, debounce, formatDate } from "./util.js";
import { driveFetch, driveFolderLink } from "./drive.js";
import { setStatus, lockBodyScroll, showToast } from "./ui.js";
import { getFolderScanHistory } from "./db.js";

const ROOT = "root";
let currentId = ROOT;
let crumbs = [];
let included = new Map(); // id -> {id, name, include: true}
let excluded = new Map(); // id -> {id, name, include: false}
let renderSeq = 0;
let isLoading = false;
let scanHistory = {}; // Cache of folder scan history
let visibleFolders = []; // Currently visible folders in the list (for Include/Exclude All)

async function listFolderChildren(folderId) {
  const res = await driveFetch("files", {
    params: {
      q: `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`,
      fields: "files(id,name,parents),nextPageToken",
      pageSize: "500",
      orderBy: "folder,name"
    }
  });
  return res.files || [];
}

async function getFolderMeta(id) {
  if (id === ROOT) return { id: ROOT, name: "My Drive", parents: [] };
  return driveFetch(`files/${id}`, { params: { fields: "id,name,parents,mimeType" } });
}

function renderIncluded() {
  const chips = el("includedChips");
  const countEl = el("includedCount");
  const summaryEl = el("foldersSummary");
  
  if (chips) {
    chips.innerHTML = "";
    
    // Include chips (green)
    for (const f of included.values()) {
      const chip = document.createElement("span");
      chip.className = "chip chipInclude";
      chip.innerHTML = `<span>✓ ${escapeHtml(f.name)}</span> <button title="remove" aria-label="Remove ${f.name}">✕</button>`;
      chip.querySelector("button").onclick = () => {
        included.delete(f.id);
        renderIncluded();
      };
      chips.appendChild(chip);
    }
    
    // Exclude chips (red)
    for (const f of excluded.values()) {
      const chip = document.createElement("span");
      chip.className = "chip chipExclude";
      chip.innerHTML = `<span>✗ ${escapeHtml(f.name)}</span> <button title="remove" aria-label="Remove ${f.name}">✕</button>`;
      chip.querySelector("button").onclick = () => {
        excluded.delete(f.id);
        renderIncluded();
      };
      chips.appendChild(chip);
    }
  }
  
  if (countEl) countEl.textContent = String(included.size);
  
  if (summaryEl) {
    const parts = [];
    if (included.size) parts.push(`${included.size} included`);
    if (excluded.size) parts.push(`${excluded.size} excluded`);
    summaryEl.textContent = parts.length ? parts.join(", ") : "None selected";
  }
}

async function renderList(seq = 0) {
  if (isLoading) return;
  isLoading = true;
  
  const folderList = el("folderList");
  const folderCurrentName = el("folderCurrentName");
  const folderCrumbs = el("folderCrumbs");
  const searchInput = el("folderSearch");
  
  if (folderList) folderList.innerHTML = '<div class="loadingIndicator">Loading...</div>';
  
  if (folderCurrentName) {
    folderCurrentName.value = crumbs.length ? crumbs[crumbs.length - 1].name : "My Drive";
  }
  
  if (folderCrumbs) {
    folderCrumbs.innerHTML = crumbs.map(c => escapeHtml(c.name)).join(" / ") || "My Drive";
  }

  try {
    // Load scan history and folder list in parallel
    const [kids, history] = await Promise.all([
      listFolderChildren(currentId),
      getFolderScanHistory()
    ]);
    scanHistory = history;

    if (seq !== renderSeq) {
      isLoading = false;
      return;
    }

    const search = searchInput?.value.trim().toLowerCase() || "";
    const filtered = search 
      ? kids.filter(k => String(k.name || "").toLowerCase().includes(search)) 
      : kids;

    if (folderList) {
      folderList.innerHTML = "";
      visibleFolders = filtered; // Track for Include All / Exclude All

      if (filtered.length === 0) {
        folderList.innerHTML = '<div class="emptyFolder">No subfolders found</div>';
      }

      for (const f of filtered) {
        const row = document.createElement("div");
        row.className = "folderRow";
        
        // Determine current state
        const isIncluded = included.has(f.id);
        const isExcluded = excluded.has(f.id);
        
        // Check scan history
        const lastScanned = scanHistory[f.id]?.lastScanned;
        const scanInfo = lastScanned 
          ? `<span class="scanHistory" title="Last scanned">🕒 ${formatDate(lastScanned)}</span>`
          : '';
        
        row.innerHTML = `
          <div class="folderIcon">📁</div>
          <div class="folderInfo">
            <b>${escapeHtml(f.name || "(unnamed)")}</b>
            <div class="folderMeta">
              <span class="muted folderId">${f.id}</span>
              ${scanInfo}
            </div>
          </div>
        `;
        
        const actions = document.createElement("div");
        actions.className = "folderActions";

        // Include button
        const btnInclude = document.createElement("button");
        btnInclude.className = isIncluded ? "btnInclude active" : "btnInclude";
        btnInclude.textContent = "Include";
        btnInclude.title = "Add to scan";
        btnInclude.onclick = () => {
          if (isIncluded) {
            included.delete(f.id);
          } else {
            excluded.delete(f.id);
            included.set(f.id, { id: f.id, name: f.name || "" });
          }
          renderIncluded();
          renderList(renderSeq);
        };

        // Exclude button
        const btnExclude = document.createElement("button");
        btnExclude.className = isExcluded ? "btnExclude active" : "btnExclude";
        btnExclude.textContent = "Exclude";
        btnExclude.title = "Skip this folder";
        btnExclude.onclick = () => {
          if (isExcluded) {
            excluded.delete(f.id);
          } else {
            included.delete(f.id);
            excluded.set(f.id, { id: f.id, name: f.name || "" });
          }
          renderIncluded();
          renderList(renderSeq);
        };

        // Open button
        const btnOpen = document.createElement("button");
        btnOpen.className = "btnGhost btnOpen";
        btnOpen.textContent = "Open";
        btnOpen.onclick = async () => {
          crumbs.push({ id: f.id, name: f.name || "" });
          currentId = f.id;
          renderSeq++;
          await renderList(renderSeq);
        };

        actions.appendChild(btnInclude);
        actions.appendChild(btnExclude);
        actions.appendChild(btnOpen);
        row.appendChild(actions);
        folderList.appendChild(row);
      }
    }
  } catch (e) {
    console.error("Failed to list folders:", e);
    if (folderList) {
      folderList.innerHTML = `<div class="errorState">Failed to load: ${escapeHtml(e.message)}</div>`;
    }
  }
  
  isLoading = false;
}

const debouncedSearch = debounce(() => {
  renderSeq++;
  renderList(renderSeq).catch(console.error);
}, 150);

export function wireFolderPicker() {
  const btnPickFolders = el("btnPickFolders");
  const btnFolderClose = el("btnFolderClose");
  const folderModal = el("folderModal");
  const btnFolderUp = el("btnFolderUp");
  const folderSearch = el("folderSearch");
  const btnIncludeThis = el("btnIncludeThis");
  const btnClearAll = el("btnClearAll");
  const btnFolderDone = el("btnFolderDone");

  if (btnPickFolders) {
    btnPickFolders.onclick = async () => {
      try {
        currentId = ROOT;
        crumbs = [];
        renderSeq++;
        
        if (folderModal) {
          folderModal.style.display = "flex";
          lockBodyScroll(true);
        }
        
        await renderList(renderSeq);
        renderIncluded();
        
        if (folderSearch) {
          folderSearch.value = "";
          folderSearch.focus();
        }
      } catch (e) {
        showToast(e.message || String(e), "error");
      }
    };
  }

  if (btnFolderClose || folderModal) {
    const closeModal = () => {
      if (folderModal) {
        folderModal.style.display = "none";
        lockBodyScroll(false);
      }
    };
    
    if (btnFolderClose) btnFolderClose.onclick = closeModal;
    
    if (folderModal) {
      folderModal.addEventListener("click", (e) => {
        if (e.target === folderModal) closeModal();
      });
      folderModal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeModal();
      });
    }
  }

  if (btnFolderUp) {
    btnFolderUp.onclick = async () => {
      if (!crumbs.length) return;
      crumbs.pop();
      currentId = crumbs.length ? crumbs[crumbs.length - 1].id : ROOT;
      renderSeq++;
      await renderList(renderSeq);
    };
  }

  if (folderSearch) {
    folderSearch.oninput = debouncedSearch;
    folderSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        folderSearch.value = "";
        debouncedSearch();
      }
    });
  }

  if (btnIncludeThis) {
    btnIncludeThis.onclick = async () => {
      try {
        const meta = await getFolderMeta(currentId);
        if (meta?.id && meta.id !== ROOT) {
          excluded.delete(meta.id);
          included.set(meta.id, { id: meta.id, name: meta.name || "" });
          renderIncluded();
          showToast(`Added "${meta.name}"`, "success", 1500);
        } else if (meta.id === ROOT) {
          showToast("Cannot add root folder", "info");
        }
      } catch (e) {
        showToast(e.message || "Failed to add folder", "error");
      }
    };
  }

  const btnIncludeAll = el("btnIncludeAll");
  const btnExcludeAll = el("btnExcludeAll");

  if (btnIncludeAll) {
    btnIncludeAll.onclick = () => {
      if (visibleFolders.length === 0) {
        showToast("No folders visible to include", "info");
        return;
      }
      for (const f of visibleFolders) {
        excluded.delete(f.id);
        included.set(f.id, { id: f.id, name: f.name || "" });
      }
      renderIncluded();
      renderList(renderSeq);
      showToast(`Included ${visibleFolders.length} folder${visibleFolders.length !== 1 ? "s" : ""}`, "success", 1500);
    };
  }

  if (btnExcludeAll) {
    btnExcludeAll.onclick = () => {
      if (visibleFolders.length === 0) {
        showToast("No folders visible to exclude", "info");
        return;
      }
      for (const f of visibleFolders) {
        included.delete(f.id);
        excluded.set(f.id, { id: f.id, name: f.name || "" });
      }
      renderIncluded();
      renderList(renderSeq);
      showToast(`Excluded ${visibleFolders.length} folder${visibleFolders.length !== 1 ? "s" : ""}`, "info", 1500);
    };
  }

  if (btnClearAll) {
    btnClearAll.onclick = () => {
      included.clear();
      excluded.clear();
      renderIncluded();
      renderList(renderSeq);
    };
  }

  if (btnFolderDone) {
    btnFolderDone.onclick = () => {
      if (folderModal) {
        folderModal.style.display = "none";
        lockBodyScroll(false);
      }
      renderIncluded();
    };
  }
}

export function getIncludedFolderIds() {
  return Array.from(included.keys());
}

export function getExcludedFolderIds() {
  return Array.from(excluded.keys());
}

export function getIncludedFolders() {
  return Array.from(included.values());
}

export function getExcludedFolders() {
  return Array.from(excluded.values());
}

export function clearAllFolders() {
  included.clear();
  excluded.clear();
  renderIncluded();
}

export function getExclusions() {
  return new Set(excluded.keys());
}
