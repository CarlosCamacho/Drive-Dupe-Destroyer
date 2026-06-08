/*
 * Drive Dupe Destroyer (DDD) v14.0 — render.js
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
// Security: all user-controlled data escaped before DOM insertion
// Results rendering with VIRTUAL SCROLLING
// Added: delete button on all rows, pathMap access for compare modal

import { el, bytesToHuman, escapeHtml, throttle, IMAGE_PLACEHOLDER } from "./util.js";
import { setStatus, refreshActionButtons, showEmptyState, showToast, updateFilterStats } from "./ui.js";
import { releaseAllThumbBlobs, getThumbUrlForFile } from "./hashing.js";
import { openCompare, setCompareCallbacks } from "./compare.js";
import { setCropCallbacks } from "./crop.js";
import { batchTrash, driveFilePreviewLink, driveFolderLink, downloadFileBlob, thumbLinkSized } from "./drive.js";
import { chooseKeepIndex, distToPercent, bestDist } from "./common.js";

const ROW_HEIGHT = 58;
const BUFFER_ROWS = 10;

let thumbObserver = null;
const loadedThumbs = new Set();
let scrollListenersAttached = false;

let currentState = null;
let allRows = [];
let selected = new Set();
let idToFile = new Map();
let visibleRange = { start: 0, end: 0 };

// --- Progressive (live) rendering state ---------------------------------
// While a scan is running, matches stream in via beginProgressive()/
// pushProgressiveMatch(). We keep groups keyed by their union-find root so
// updates (a group growing, or two groups merging) replace cleanly. Rows are
// rebuilt from this map and rendered with the SAME machinery used for final
// results, so every streamed row is fully interactive (open / Compare /
// select / delete) while the search continues.
let progressiveActive = false;
let progressiveGroups = new Map();   // root -> array<file>
let progressiveOptions = null;       // { keepRule, folderPriority, bitsCount, withVariants }
let progressiveRenderScheduled = false;
let progressiveTrashed = new Set();  // file ids the user trashed mid-scan

const GROUP_COLORS = [
  { keep: 'rgba(6, 214, 160, 0.15)', delete: 'rgba(239, 71, 111, 0.12)' },
  { keep: 'rgba(6, 214, 160, 0.25)', delete: 'rgba(239, 71, 111, 0.18)' }
];

export function selectedIds() { return Array.from(selected); }
export function getSelectedCount() { return selected.size; }
export function getIdToFile() { return idToFile; }
export function getCurrentGroups() { return currentState?.groups || []; }
export function getPathMap() { return currentState?.pathMap || new Map(); }

function getFolderPath(file, pathMap) {
  return pathMap?.get(file.id) || "";
}

function dimsForFile(file) {
  const w = file?.imageMediaMetadata?.width;
  const h = file?.imageMediaMetadata?.height;
  return (w && h) ? `${w}×${h}` : "—";
}

// Pairwise similarity is stable for a given (keepFile, file) pair within a
// result set, but createRowElement runs on every virtual-scroll repaint and
// (in progressive mode) on every live update. Recomputing the Hamming distance
// each time is wasteful, so memoize by id-pair. Cleared on each fresh render.
const _simCache = new Map();
function clearSimCache() { _simCache.clear(); }

function computeSimilarity(keepFile, file, idToEntry, bitsCount, withVariants) {
  if (!keepFile || file.id === keepFile.id) return 100;
  const cacheKey = `${keepFile.id}:${file.id}:${withVariants ? 1 : 0}:${bitsCount}`;
  const cached = _simCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const keepEntry = idToEntry?.get(keepFile.id);
  const fileEntry = idToEntry?.get(file.id);
  if (!keepEntry?.base12 || !fileEntry?.base12) {
    _simCache.set(cacheKey, null);
    return null;
  }
  const dist = bestDist(keepEntry, fileEntry, withVariants, true);
  const pct = distToPercent(dist, bitsCount);
  _simCache.set(cacheKey, pct);
  return pct;
}

function formatSimilarity(pctValue) {
  if (pctValue === null || pctValue === undefined) return "—";
  return `${pctValue}%`;
}

/**
 * Feature #2: compute the best (highest) pairwise similarity percentage
 * within a duplicate group, measured against the keep file at `keepIdx`.
 * Returns null if no comparable pairs are available.
 */
function groupBestPct(group, keepIdx, idToEntry, bitsCount, withVariants) {
  if (!group || group.length < 2) return null;
  const keep = group[keepIdx] || group[0];
  let best = null;
  for (let i = 0; i < group.length; i++) {
    if (i === keepIdx) continue;
    const pct = computeSimilarity(keep, group[i], idToEntry, bitsCount, withVariants);
    if (pct === null || pct === undefined) continue;
    if (best === null || pct > best) best = pct;
  }
  return best;
}

/**
 * Feature #2: render the similarity-band badge for a group header row.
 * Bands: identical (100), near (>=90), similar (>=75), loose (<75).
 */
function makeSimilarityBadge(pct) {
  if (pct === null || pct === undefined) return "";
  let cls, label;
  if (pct >= 100) { cls = "badge-identical"; label = "identical"; }
  else if (pct >= 90) { cls = "badge-near"; label = "near"; }
  else if (pct >= 75) { cls = "badge-similar"; label = "similar"; }
  else { cls = "badge-loose"; label = "loose"; }
  return `<span class="similarityBadge ${cls}" title="Best similarity in group: ${pct}%">${label} ${pct}%</span>`;
}

function isFirstInGroup(rowData, rowIndex) {
  if (rowIndex === 0) return true;
  const prevRow = allRows[rowIndex - 1];
  return prevRow && prevRow.groupId !== rowData.groupId;
}

function createRowElement(rowData, rowIndex) {
  const { file, groupId, keepFile, idToEntry, pathMap, isKeep, bitsCount, withVariants, groupColorIdx, groupPct } = rowData;
  
  const tr = document.createElement("tr");
  tr.setAttribute("data-row-index", String(rowIndex));
  tr.setAttribute("data-file-id", file.id);
  tr.setAttribute("data-group-id", String(groupId));
  tr.tabIndex = 0;
  tr.style.height = ROW_HEIGHT + "px";
  tr.style.contain = "content";
  
  if (isFirstInGroup(rowData, rowIndex) && rowIndex > 0) tr.classList.add("groupFirst");
  
  const colors = GROUP_COLORS[groupColorIdx % GROUP_COLORS.length];
  if (isKeep) {
    tr.classList.add("keepRow");
    tr.style.backgroundColor = colors.keep;
  } else {
    tr.classList.add("deleteCandidate");
    tr.style.backgroundColor = colors.delete;
  }

  const pctValue = computeSimilarity(keepFile, file, idToEntry, bitsCount, withVariants);
  const previewUrl = driveFilePreviewLink(file) || "#";
  const folderPath = getFolderPath(file, pathMap);
  const folderUrl = driveFolderLink(file.parents?.[0]) || "";

  // Store path on file object for compare modal
  file._path = folderPath;

  // v14: folder cell is now a link that opens the containing Drive folder in a
  // new tab (so the user can see the file in context alongside its neighbours).
  const folderLabel = folderPath ? escapeHtml(folderPath) : "(open folder)";
  const folderCell = folderUrl
    ? `<a href="${folderUrl}" target="_blank" rel="noopener" class="folderLink" title="Open containing folder in Google Drive">${folderLabel}</a>`
    : escapeHtml(folderPath);

  // v14: every row can be deleted (the KEEP file too — no longer disabled, just
  // visually flagged and confirmed) and downloaded.
  const deleteBtn = isKeep
    ? '<button class="btnMiniDanger btnDangerKeep" data-action="delete-keep" title="⚠️ KEEP file — click to delete anyway"><i class="fa-solid fa-trash"></i></button>'
    : '<button class="btnMiniDanger" data-action="delete" title="Move to trash"><i class="fa-solid fa-trash"></i></button>';
  const downloadBtn = '<button class="btnMiniIcon" data-action="download" title="Download this image"><i class="fa-solid fa-download"></i></button>';

  tr.innerHTML = `
    <td class="cellCb">${isKeep
      ? '<span class="keepIndicator">✓</span>'
      : `<input type="checkbox" ${selected.has(file.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(file.name)}">`
    }</td>
    <td><button class="btnMini btnCompare" data-action="compare">Compare</button></td>
    <td><img class="thumb" data-file-id="${file.id}" src="${IMAGE_PLACEHOLDER}" alt="${escapeHtml(file.name)}" loading="lazy" title="Click to open"></td>
    <td class="nameCell"><a href="${previewUrl}" target="_blank" rel="noopener" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a></td>
    <td class="pathCell" title="${escapeHtml(folderPath)}">${folderCell}</td>
    <td>${dimsForFile(file)}</td>
    <td>${bytesToHuman(Number(file.size || 0))}</td>
    <td><span class="pill">${formatSimilarity(pctValue)}</span></td>
    <td class="cellGrp"><span class="groupBadge">${groupId}</span>${isFirstInGroup(rowData, rowIndex) ? makeSimilarityBadge(groupPct) : ""}</td>
    <td class="cellActions">${downloadBtn}${deleteBtn}</td>
  `;

  return tr;
}

function calculateVisibleRange(scrollTop, viewportHeight) {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
  const end = Math.min(allRows.length, start + visibleCount + BUFFER_ROWS * 2);
  return { start, end };
}

function renderVisibleRows() {
  const tableWrap = document.querySelector(".tableWrap");
  const tbody = el("resultsTbody");
  if (!tableWrap || !tbody) return;

  const scrollTop = tableWrap.scrollTop;
  const viewportHeight = tableWrap.clientHeight;
  const newRange = calculateVisibleRange(scrollTop, viewportHeight);

  if (newRange.start === visibleRange.start && newRange.end === visibleRange.end) return;

  visibleRange = newRange;
  const fragment = document.createDocumentFragment();
  
  if (visibleRange.start > 0) {
    const topSpacer = document.createElement("tr");
    topSpacer.className = "virtualSpacer";
    topSpacer.innerHTML = `<td colspan="10" style="height:${visibleRange.start * ROW_HEIGHT}px;padding:0;border:none;"></td>`;
    fragment.appendChild(topSpacer);
  }

  for (let i = visibleRange.start; i < visibleRange.end; i++) {
    const rowData = allRows[i];
    if (rowData) fragment.appendChild(createRowElement(rowData, i));
  }

  const rowsBelow = allRows.length - visibleRange.end;
  if (rowsBelow > 0) {
    const bottomSpacer = document.createElement("tr");
    bottomSpacer.className = "virtualSpacer";
    bottomSpacer.innerHTML = `<td colspan="10" style="height:${rowsBelow * ROW_HEIGHT}px;padding:0;border:none;"></td>`;
    fragment.appendChild(bottomSpacer);
  }

  tbody.innerHTML = "";
  tbody.appendChild(fragment);

  requestAnimationFrame(() => {
    observeThumbnails();
    throttledLoadVisibleThumbs();
  });
}

function setupThumbObserver() {
  if (thumbObserver) thumbObserver.disconnect();
  
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        loadThumbnailForImg(entry.target);
        thumbObserver.unobserve(entry.target);
      }
    }
  }, { root: document.querySelector('.tableWrap'), rootMargin: '200px', threshold: 0 });
  
  if (!scrollListenersAttached) {
    scrollListenersAttached = true;
    const tableWrap = document.querySelector('.tableWrap');
    if (tableWrap) {
      tableWrap.addEventListener('scroll', throttledLoadVisibleThumbs, { passive: true });
      tableWrap.addEventListener('wheel', throttledLoadVisibleThumbs, { passive: true });
    }
    window.addEventListener('scroll', throttledLoadVisibleThumbs, { passive: true });
  }
}

const throttledLoadVisibleThumbs = throttle(() => {
  const tableWrap = document.querySelector('.tableWrap');
  if (!tableWrap) return;
  const imgs = tableWrap.querySelectorAll('img.thumb[data-file-id]');
  const wrapRect = tableWrap.getBoundingClientRect();
  
  for (const img of imgs) {
    if (img.dataset.failed) continue;
    if (img.src && img.src.startsWith('http')) continue;
    const rect = img.getBoundingClientRect();
    if (rect.bottom >= wrapRect.top - 200 && rect.top <= wrapRect.bottom + 200) {
      loadThumbnailForImg(img);
    }
  }
}, 100);

async function loadThumbnailForImg(img) {
  const fileId = img.dataset.fileId;
  if (!fileId || img.dataset.failed || (img.src && img.src.startsWith('http'))) return;
  
  const file = idToFile.get(fileId);
  if (!file) return;
  
  try {
    const url = await getThumbUrlForFile(file, { size: 256 });
    if (url && img.isConnected) { img.src = url; loadedThumbs.add(fileId); return; }
  } catch (e) {}
  
  if (file.thumbnailLink && img.isConnected) {
    const url = thumbLinkSized(file.thumbnailLink, 256);
    if (url) { img.src = url; loadedThumbs.add(fileId); }
  }
}

function observeThumbnails() {
  if (!thumbObserver) return;
  const tbody = el("resultsTbody");
  if (!tbody) return;
  const imgs = tbody.querySelectorAll("img.thumb[data-file-id]");
  for (const img of imgs) {
    if (!(img.src && img.src.startsWith('http'))) thumbObserver.observe(img);
  }
}

function handleTableClick(e) {
  const target = e.target;
  const tr = target.closest("tr[data-file-id]");
  if (!tr) return;

  const fileId = tr.dataset.fileId;
  const file = idToFile.get(fileId);
  if (!file) return;

  const rowIndex = parseInt(tr.dataset.rowIndex, 10);
  const rowData = allRows[rowIndex];

  if (target.matches('input[type="checkbox"]')) {
    if (target.checked) selected.add(fileId); else selected.delete(fileId);
    refreshActionButtons();
    return;
  }

  if (target.matches('[data-action="compare"]')) {
    e.stopPropagation();
    if (rowData) {
      const { keepFile } = rowData;
      // Locate the group by membership rather than trusting the displayed group
      // number. After filtering (or in progressive mode) the on-screen group
      // numbering no longer matches positions in currentState.groups, so
      // groupId-1 could open the wrong group. Finding the group that actually
      // contains this file is always correct.
      const groups = currentState.groups || [];
      let groupIndex = groups.findIndex(g => g.some(f => f.id === file.id));
      if (groupIndex < 0) groupIndex = groups.findIndex(g => g.some(f => f.id === keepFile.id));

      if (file.id === keepFile.id) {
        const other = groups[groupIndex]?.find(x => x.id !== file.id) || keepFile;
        openCompare(file, other, { leftIsKeep: true, rightIsKeep: false, groupIndex, allGroups: groups });
      } else {
        openCompare(keepFile, file, { leftIsKeep: true, rightIsKeep: false, groupIndex, allGroups: groups });
      }
    }
    return;
  }

  if (target.matches('[data-action="delete"]') || target.closest('[data-action="delete"]')) {
    e.stopPropagation();
    handleSingleDelete(file, tr);
    return;
  }

  if (target.matches('[data-action="delete-keep"]') || target.closest('[data-action="delete-keep"]')) {
    e.stopPropagation();
    const btn = tr.querySelector('[data-action="delete-keep"]');
    if (btn && !confirm("⚠️ This is the KEEP file (highest quality in this group). Are you sure you want to delete it?")) return;
    handleSingleDelete(file, tr);
    return;
  }

  if (target.matches('[data-action="download"]') || target.closest('[data-action="download"]')) {
    e.stopPropagation();
    const btn = target.closest('[data-action="download"]');
    handleSingleDownload(file, btn);
    return;
  }

  if (target.matches(".thumb")) {
    e.stopPropagation();
    const url = driveFilePreviewLink(file);
    if (url) window.open(url, '_blank');
    return;
  }

  if (!target.closest("a") && !target.closest("button") && !target.matches("input")) {
    const cb = tr.querySelector('input[type="checkbox"]');
    if (cb) {
      cb.checked = !cb.checked;
      if (cb.checked) selected.add(fileId); else selected.delete(fileId);
      refreshActionButtons();
    }
  }
}

// v14: download any row's image (keep or duplicate) straight from the results
// table. Mirrors the compare modal's download, but works per-row.
async function handleSingleDownload(file, btn) {
  if (!file) return;
  const original = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    const blob = await downloadFileBlob(file.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name || `file_${file.id}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Download started", "success", 1500);
  } catch (err) {
    showToast("Download failed: " + (err?.message || err), "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original || '<i class="fa-solid fa-download"></i>'; }
  }
}

async function handleSingleDelete(file, tr) {
  const btn = tr.querySelector('[data-action="delete"]') || tr.querySelector('[data-action="delete-keep"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

  try {
    const result = await batchTrash([file.id]);
    if (result.success.includes(file.id)) {
      selected.delete(file.id);
      removeFileFromResults(file.id);
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: [file.id] } }));
      showToast("File moved to trash", "success");
    } else throw new Error("Trash failed");
  } catch (err) {
    showToast("Trash failed: " + (err?.message || err), "error");
    if (btn) { 
      btn.disabled = false; 
      btn.innerHTML = '<i class="fa-solid fa-trash"></i>'; 
    }
  }
}

function removeFileFromGroups(fileId) {
  if (!currentState?.groups) return;
  for (let i = currentState.groups.length - 1; i >= 0; i--) {
    const group = currentState.groups[i];
    const fileIndex = group.findIndex(f => f.id === fileId);
    if (fileIndex !== -1) {
      group.splice(fileIndex, 1);
      if (group.length < 2) currentState.groups.splice(i, 1);
      break;
    }
  }
}

function removeGroupByIndex(groupIndex) {
  if (!currentState?.groups || groupIndex < 0 || groupIndex >= currentState.groups.length) return;
  
  const group = currentState.groups[groupIndex];
  const fileIds = new Set(group.map(f => f.id));
  currentState.groups.splice(groupIndex, 1);
  
  for (let i = allRows.length - 1; i >= 0; i--) {
    if (fileIds.has(allRows[i].file.id)) {
      idToFile.delete(allRows[i].file.id);
      selected.delete(allRows[i].file.id);
      allRows.splice(i, 1);
    }
  }
  
  if (allRows.length === 0) {
    showEmptyState(true);
    setStatus("All duplicates processed.");
  } else {
    visibleRange = { start: -1, end: -1 };
    renderVisibleRows();
  }
  refreshActionButtons();
}

function removeFileFromResults(fileId) {
  removeFileFromGroups(fileId);
  
  const rowIndex = allRows.findIndex(r => r.file.id === fileId);
  if (rowIndex === -1) return;

  const groupId = allRows[rowIndex].groupId;
  allRows.splice(rowIndex, 1);
  idToFile.delete(fileId);

  const groupRows = allRows.filter(r => r.groupId === groupId);
  if (groupRows.length <= 1) {
    const keepRowIndex = allRows.findIndex(r => r.groupId === groupId);
    if (keepRowIndex !== -1) {
      idToFile.delete(allRows[keepRowIndex].file.id);
      allRows.splice(keepRowIndex, 1);
    }
  }

  if (allRows.length === 0) {
    showEmptyState(true);
    setStatus("All duplicates processed.");
  } else {
    visibleRange = { start: -1, end: -1 };
    renderVisibleRows();
  }
  refreshActionButtons();
}

function handleBulkTrash(ids) {
  const idSet = new Set(ids);
  for (const fileId of ids) removeFileFromGroups(fileId);
  
  for (let i = allRows.length - 1; i >= 0; i--) {
    if (idSet.has(allRows[i].file.id)) {
      idToFile.delete(allRows[i].file.id);
      selected.delete(allRows[i].file.id);
      allRows.splice(i, 1);
    }
  }

  const groupCounts = new Map();
  for (const row of allRows) groupCounts.set(row.groupId, (groupCounts.get(row.groupId) || 0) + 1);

  for (let i = allRows.length - 1; i >= 0; i--) {
    if (groupCounts.get(allRows[i].groupId) <= 1) {
      idToFile.delete(allRows[i].file.id);
      allRows.splice(i, 1);
    }
  }

  if (allRows.length === 0) {
    showEmptyState(true);
    setStatus("All duplicates processed.");
  } else {
    visibleRange = { start: -1, end: -1 };
    renderVisibleRows();
  }
  refreshActionButtons();
}

export function wireRenderControls() {
  setupThumbObserver();
  
  const btnSelectAll = el("btnSelectAll");
  const btnSelectNone = el("btnSelectNone");
  const tbody = el("resultsTbody");
  const tableWrap = document.querySelector(".tableWrap");
  
  if (tbody) tbody.addEventListener("click", handleTableClick);

  // v14: error events don't bubble, so capture them. Any thumbnail that fails to
  // load (404, CORS, deleted file, etc.) falls back to the inline placeholder
  // instead of showing a broken-image glyph.
  if (tbody) tbody.addEventListener("error", (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG" && img.classList.contains("thumb") && img.src !== IMAGE_PLACEHOLDER) {
      img.dataset.failed = "1";
      img.src = IMAGE_PLACEHOLDER;
    }
  }, true);

  if (tableWrap) {
    tableWrap.addEventListener("scroll", throttle(() => renderVisibleRows(), 16), { passive: true });
  }

  if (btnSelectAll) {
    btnSelectAll.onclick = () => {
      for (const row of allRows) if (!row.isKeep) selected.add(row.file.id);
      visibleRange = { start: -1, end: -1 };
      renderVisibleRows();
      refreshActionButtons();
    };
  }

  if (btnSelectNone) {
    btnSelectNone.onclick = () => {
      selected.clear();
      visibleRange = { start: -1, end: -1 };
      renderVisibleRows();
      refreshActionButtons();
    };
  }

  window.addEventListener("ddd:trashed", (e) => {
    const ids = e.detail?.ids || [];
    if (ids.length > 0) {
      // During a live scan, remember trashed ids so re-emitted groups don't
      // bring deleted files back when the table rebuilds.
      if (progressiveActive) for (const id of ids) progressiveTrashed.add(id);
      handleBulkTrash(ids);
    }
  });
  
  window.addEventListener("ddd:ignoreGroup", (e) => {
    const groupIndex = e.detail?.groupIndex;
    if (groupIndex !== undefined && groupIndex >= 0) removeGroupByIndex(groupIndex);
  });

  setCompareCallbacks({
    onSelect: (fileId) => {
      if (selected.has(fileId)) { selected.delete(fileId); return false; }
      else { selected.add(fileId); return true; }
    },
    onDelete: null,
    getCurrentGroups: () => currentState?.groups || [],
    onIgnore: (groupIndex) => removeGroupByIndex(groupIndex),
    getPathMap: () => currentState?.pathMap || new Map(),
    // v14.0: lets the compare modal record "ignore" rejections so ignored
    // pairs stay suppressed across future scans (previously never wired up).
    getIdToEntry: () => currentState?.idToEntry || new Map()
  });
  
  setCropCallbacks({
    onComplete: null,
    getCurrentGroups: () => currentState?.groups || []
  });

  const filterEl = el("filterMode");
  if (filterEl) filterEl.onchange = handleFilterChange;
}

function handleFilterChange() {
  if (!currentState) return;
  
  allRows = [];
  let groupId = 0;
  
  for (const g of currentState.groups) {
    groupId++;
    const keepIdx = chooseKeepIndex(g, el("keepRule")?.value || "newest", el("folderPriority")?.value || "");
    const keepFile = g[keepIdx] || g[0];
    const sortedGroup = [keepFile, ...g.filter(f => f.id !== keepFile.id)];
    
    for (const f of sortedGroup) {
      allRows.push({ 
        file: f, groupId, keepFile, 
        idToEntry: currentState.idToEntry, 
        pathMap: currentState.pathMap, 
        isKeep: f.id === keepFile.id,
        bitsCount: currentState.bitsCount,
        withVariants: currentState.withVariants,
        groupColorIdx: groupId - 1
      });
    }
  }
  
  applyFilter();
  
  const totalGroupsAfter = new Set(allRows.map(r => r.groupId)).size;
  visibleRange = { start: -1, end: -1 };
  
  const tableWrap = document.querySelector(".tableWrap");
  if (tableWrap) tableWrap.scrollTop = 0;
  
  renderVisibleRows();
  refreshActionButtons();
  updateFilterStats(totalGroupsAfter, allRows.length, el("filterMode")?.value || "all");
  setStatus(`Filtered: ${totalGroupsAfter} group(s), ${allRows.length} file(s).`);
}

function applyFilter() {
  const filter = el("filterMode")?.value || "all";
  if (filter === "all") return;
  
  const minPct = filter === "pct90" ? 90 : filter === "pct75" ? 75 : filter === "pct50" ? 50 : 0;
  
  allRows = allRows.filter(row => {
    if (row.isKeep) return true;
    const pct = computeSimilarity(row.keepFile, row.file, row.idToEntry, row.bitsCount, row.withVariants);
    return pct !== null && pct >= minPct;
  });

  const groupCounts = new Map();
  for (const row of allRows) groupCounts.set(row.groupId, (groupCounts.get(row.groupId) || 0) + 1);
  allRows = allRows.filter(row => groupCounts.get(row.groupId) > 1);
}

// ============================================================================
// Progressive (live) rendering — show & act on matches while scan continues
// ============================================================================

/**
 * Start a live results session. Called when progressive matching begins.
 * Resets the table and switches the renderer into "progressive" mode so that
 * pushProgressiveMatch() can stream groups into the SAME interactive table.
 */
export function beginProgressive({ idToEntry, keepRule = "newest", folderPriority = "", bitsCount = 144, withVariants = false } = {}) {
  releaseAllThumbBlobs();
  loadedThumbs.clear();
  clearSimCache();

  const tbody = el("resultsTbody");
  if (tbody) tbody.innerHTML = "";

  selected.clear();
  allRows = [];
  visibleRange = { start: -1, end: -1 };

  progressiveActive = true;
  progressiveGroups = new Map();
  progressiveTrashed = new Set();
  progressiveOptions = { keepRule, folderPriority, bitsCount, withVariants };

  // currentState is needed by Compare/delete handlers. pathMap is filled in
  // later (paths are built in the final phase); an empty map is fine for now.
  currentState = {
    groups: [],
    idToEntry: idToEntry || new Map(),
    pathMap: new Map(),
    bitsCount,
    withVariants
  };
  idToFile = new Map();

  showEmptyState(false);
  refreshActionButtons();
}

/**
 * Stream a single match-group update into the live table.
 * @param {Object} match - { group, root } from the scan's onMatchFound emit.
 *   - group: array of file objects currently unioned under `root`
 *   - root:  union-find root id (stable key for this group)
 */
export function pushProgressiveMatch(match) {
  if (!progressiveActive || !match || !Array.isArray(match.group)) return;
  if (match.group.length < 2) return;

  // Replace the group stored under this root. The scan emits the full current
  // group on every update, and cleans up merged roots on its side, so a plain
  // set-by-root keeps us consistent without double-counting.
  progressiveGroups.set(match.root, match.group);

  scheduleProgressiveRender();
}

// Coalesce bursts of match emits into one render per frame to stay smooth.
function scheduleProgressiveRender() {
  if (progressiveRenderScheduled) return;
  progressiveRenderScheduled = true;
  requestAnimationFrame(() => {
    progressiveRenderScheduled = false;
    if (progressiveActive) rebuildProgressiveRows();
  });
}

function rebuildProgressiveRows() {
  const opts = progressiveOptions || {};
  const idToEntry = currentState?.idToEntry || new Map();
  const pathMap = currentState?.pathMap || new Map();

  // Preserve the user's current selection across live re-renders.
  const prevSelected = new Set(selected);

  allRows = [];
  idToFile = new Map();
  const liveGroups = [];

  let groupId = 0;
  for (const rawGroup of progressiveGroups.values()) {
    // Drop files the user already trashed during this live session so a
    // re-emitted (grown/merged) group never resurrects a deleted row.
    const group = progressiveTrashed.size
      ? rawGroup.filter(f => !progressiveTrashed.has(f.id))
      : rawGroup;
    if (!group || group.length < 2) continue;
    groupId++;
    liveGroups.push(group);

    const keepIdx = chooseKeepIndex(group, opts.keepRule || "newest", opts.folderPriority || "");
    const keepFile = group[keepIdx] || group[0];
    const sortedGroup = [keepFile, ...group.filter(f => f.id !== keepFile.id)];
    const _groupPct = groupBestPct(sortedGroup, 0, idToEntry, opts.bitsCount, opts.withVariants);

    for (const f of sortedGroup) {
      idToFile.set(f.id, f);
      allRows.push({
        file: f, groupId, keepFile, idToEntry, pathMap,
        isKeep: f.id === keepFile.id,
        bitsCount: opts.bitsCount, withVariants: opts.withVariants,
        groupColorIdx: groupId - 1, groupPct: _groupPct
      });
    }
  }

  // Keep currentState.groups live so Compare / delete handlers work on what's
  // currently shown, even mid-scan.
  currentState.groups = liveGroups;

  // Drop any selections whose files no longer exist in the live set.
  selected = new Set([...prevSelected].filter(id => idToFile.has(id)));

  if (allRows.length === 0) {
    showEmptyState(true);
  } else {
    showEmptyState(false);
  }

  visibleRange = { start: -1, end: -1 };
  renderVisibleRows();
  refreshActionButtons();

  const totalGroups = new Set(allRows.map(r => r.groupId)).size;
  updateFilterStats(totalGroups, allRows.length, el("filterMode")?.value || "all");
}

/**
 * End the live session. The caller follows this with a normal renderGroups()
 * pass that re-renders cleanly (with folder paths and final keep-rule sorting).
 */
export function endProgressive() {
  progressiveActive = false;
  progressiveGroups = new Map();
  progressiveOptions = null;
  progressiveRenderScheduled = false;
}

export async function renderGroups({ groups, idToEntry, pathMap, keepRule = "newest", folderPriority = "", bitsCount = 144, withVariants = false }) {
  releaseAllThumbBlobs();
  loadedThumbs.clear();
  clearSimCache();
  
  const tbody = el("resultsTbody");
  if (tbody) tbody.innerHTML = "";
  
  selected.clear();
  allRows = [];
  visibleRange = { start: -1, end: -1 };

  currentState = { groups, idToEntry, pathMap, bitsCount, withVariants };
  idToFile = new Map(groups.flat().map(f => [f.id, f]));

  if (groups.length === 0) {
    showEmptyState(true);
    setStatus("No duplicate groups found.");
    refreshActionButtons();
    return;
  }

  showEmptyState(false);
  setStatus(`Preparing ${groups.length} group(s)…`);

  let groupId = 0;
  for (const g of groups) {
    groupId++;
    const keepIdx = chooseKeepIndex(g, keepRule, folderPriority);
    const keepFile = g[keepIdx] || g[0];
    const sortedGroup = [keepFile, ...g.filter(f => f.id !== keepFile.id)];
    
    // Feature #2: compute best group similarity pct for badge
    const _groupPct = groupBestPct(sortedGroup, 0, idToEntry, bitsCount, withVariants);
    for (const f of sortedGroup) {
      allRows.push({ 
        file: f, groupId, keepFile, idToEntry, pathMap, 
        isKeep: f.id === keepFile.id, bitsCount, withVariants, groupColorIdx: groupId - 1,
        groupPct: _groupPct
      });
    }
  }

  applyFilter();
  
  const totalGroups = new Set(allRows.map(r => r.groupId)).size;
  updateFilterStats(totalGroups, allRows.length, "all");
  setStatus(`Showing ${groups.length} group(s), ${allRows.length} file(s). (Virtual scroll enabled)`);
  refreshActionButtons();

  const tableWrap = document.querySelector(".tableWrap");
  if (tableWrap) tableWrap.scrollTop = 0;
  
  requestAnimationFrame(() => renderVisibleRows());
}
