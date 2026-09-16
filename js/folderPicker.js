/*
 * Drive Dupe Destroyer (DDD) — folderPicker.js
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
// Added: Include All / Exclude All buttons for visible folder list
// Folder browser with include/exclude in one interface

import { el, escapeHtml, debounce, formatDate } from "./util.js";
import { driveFetch, driveFolderLink } from "./drive.js";
import { setStatus, lockBodyScroll, showToast } from "./ui.js";
import { getFolderScanHistory } from "./db.js";
import { validateFolderId, sanitizeText } from "./security.js";

const ROOT = "root";
let currentId = ROOT;
let crumbs = [];
/**
 * The include/exclude selection, as data (#124).
 *
 * This used to be two module-level Maps mutated from inside a dozen click
 * handlers, which is why this 443-line module -- the gate in front of the
 * entire app, since no scan can start without it -- had no test of any kind.
 * The rules below are small but they are not obvious: including a folder must
 * remove it from the excluded set and vice versa, or the same id ends up in
 * both and getExclusions() silently contradicts getIncludedFolderIds().
 *
 * That matters beyond this module. The exclusion set is consulted twice for
 * two different purposes -- actions.js refuses to trash a file whose parent is
 * excluded, and scan.js:962 uses it to keep delta-scan changes in scope. A
 * wrong exclusion set does not look like a bug; it looks like the app scanning
 * folders you told it not to.
 */
export function makeSelection() {
  return { included: new Map(), excluded: new Map() };
}

/** Include a folder, which un-excludes it. Idempotent. */
export function includeFolder(sel, folder) {
  if (!folder?.id) return sel;
  sel.excluded.delete(folder.id);
  sel.included.set(folder.id, { id: folder.id, name: folder.name || "" });
  return sel;
}

/** Exclude a folder, which un-includes it. Idempotent. */
export function excludeFolder(sel, folder) {
  if (!folder?.id) return sel;
  sel.included.delete(folder.id);
  sel.excluded.set(folder.id, { id: folder.id, name: folder.name || "" });
  return sel;
}

/** Forget a folder entirely -- neither included nor excluded. */
export function forgetFolder(sel, id) {
  sel.included.delete(id);
  sel.excluded.delete(id);
  return sel;
}

export function clearSelection(sel) {
  sel.included.clear();
  sel.excluded.clear();
  return sel;
}

/** What the sidebar says under "Folders". */
export function selectionSummary(sel) {
  const parts = [];
  if (sel.included.size) parts.push(`${sel.included.size} included`);
  if (sel.excluded.size) parts.push(`${sel.excluded.size} excluded`);
  return parts.length ? parts.join(", ") : "None selected";
}

const selection = makeSelection();
const included = selection.included; // id -> {id, name}
const excluded = selection.excluded; // id -> {id, name}
let renderSeq = 0;
let isLoading = false;
let scanHistory = {}; // Cache of folder scan history
let visibleFolders = []; // Currently visible folders in the list (for Include/Exclude All)

// The picker interpolated its folder ID straight into the `q` expression with
// no validation, while scan.js guards the identical interpolation. IDs here come
// from API responses, but that is a property of today's call sites rather than
// of the function, so check it where it is used.
function quoteFolderId(folderId) {
  const id = String(folderId ?? "");
  if (!validateFolderId(id)) {
    throw new Error(`Refusing to list a malformed folder ID: ${sanitizeText(id.slice(0, 64))}`);
  }
  return id;
}

// A single page held 500 subfolders and nextPageToken was requested and then
// discarded, so a wider folder was silently truncated -- and Include All then
// acted on 500 of N while reporting "Included 500 folders", which reads as
// completeness. Follow the token.
const FOLDER_PAGE_SIZE = 500;
const MAX_FOLDER_PAGES = 40;   // 20,000 subfolders; a stop, not an expectation

async function listFolderChildren(folderId) {
  const out = [];
  let pageToken = null;
  let pages = 0;

  do {
    const params = {
      q: `'${quoteFolderId(folderId)}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`,
      fields: "files(id,name,parents),nextPageToken",
      pageSize: String(FOLDER_PAGE_SIZE),
      orderBy: "folder,name"
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await driveFetch("files", { params });
    if (res.files?.length) out.push(...res.files);
    pageToken = res.nextPageToken || null;
  } while (pageToken && ++pages < MAX_FOLDER_PAGES);

  out.truncated = Boolean(pageToken);
  return out;
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
      chip.innerHTML = `<span>✓ ${escapeHtml(f.name)}</span> <button title="remove" aria-label="Remove ${escapeHtml(f.name)}">✕</button>`;
      chip.querySelector("button").onclick = () => {
        forgetFolder(selection, f.id);
        renderIncluded();
      };
      chips.appendChild(chip);
    }
    
    // Exclude chips (red)
    for (const f of excluded.values()) {
      const chip = document.createElement("span");
      chip.className = "chip chipExclude";
      chip.innerHTML = `<span>✗ ${escapeHtml(f.name)}</span> <button title="remove" aria-label="Remove ${escapeHtml(f.name)}">✕</button>`;
      chip.querySelector("button").onclick = () => {
        forgetFolder(selection, f.id);
        renderIncluded();
      };
      chips.appendChild(chip);
    }
  }
  
  if (countEl) countEl.textContent = String(included.size);
  
  if (summaryEl) {
    summaryEl.textContent = selectionSummary(selection);
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
      } else if (kids.truncated) {
        // Only reachable past MAX_FOLDER_PAGES. Say so rather than let Include
        // All claim a count that is not the whole folder.
        const note = document.createElement("div");
        note.className = "emptyFolder";
        note.textContent = `Showing the first ${kids.length.toLocaleString()} subfolders — this folder has more.`;
        folderList.appendChild(note);
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
              <span class="muted folderId">${escapeHtml(f.id || "")}</span>
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
            forgetFolder(selection, f.id);
          } else {
            includeFolder(selection, f);
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
          if (isExcluded) forgetFolder(selection, f.id);
          else excludeFolder(selection, f);
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
        // Without this the keypress also reached the modal's own Escape
        // handler, so clearing the search closed the entire picker.
        e.stopPropagation();
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
          includeFolder(selection, meta);
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
        includeFolder(selection, f);
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
        excludeFolder(selection, f);
      }
      renderIncluded();
      renderList(renderSeq);
      showToast(`Excluded ${visibleFolders.length} folder${visibleFolders.length !== 1 ? "s" : ""}`, "info", 1500);
    };
  }

  if (btnClearAll) {
    btnClearAll.onclick = () => {
      clearSelection(selection);
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

export function getIncludedFolders() {
  return Array.from(included.values());
}

export function getExclusions() {
  return new Set(excluded.keys());
}
