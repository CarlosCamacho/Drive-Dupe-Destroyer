/*
 * Drive Dupe Destroyer (DDD) v14.0 — compare.js
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
// Side-by-side image comparison with delete actions and keyboard shortcuts
// Fixed: Proper folder path display from pathMap

import { recordRejection } from "./rejection.js";
import { pushUndoDelete } from "./undo.js";
import { el, bytesToHuman, formatDate, IMAGE_PLACEHOLDER } from "./util.js";
import { getThumbUrlForFile } from "./hashing.js";
import { lockBodyScroll, showToast } from "./ui.js";
import { driveFilePreviewLink, driveFolderLink, batchTrash, downloadFileBlob, thumbLinkSized } from "./drive.js";
import { openCropModal } from "./crop.js";

let leftFile = null;
let rightFile = null;
let leftIsKeep = false;
let rightIsKeep = false;
let onDeleteCallback = null;
let onSelectCallback = null;
let onGetCurrentGroups = null;
let onGetPathMap = null;
let onIgnoreGroup = null;
let onGetIdToEntry = null;
let currentGroupIndex = -1;
let allGroups = [];
let modalKeyboardHandler = null;
let currentIdToEntry = null;

export function wireCompare() {
  const btnClose = el("btnCompareClose");
  const btnPrev = el("btnComparePrev");
  const btnNext = el("btnCompareNext");
  const modal = el("compareModal");
  const btnLeftDelete = el("btnCompareLeftDelete");
  const btnRightDelete = el("btnCompareRightDelete");
  const btnLeftDownload = el("btnCompareLeftDownload");
  const btnRightDownload = el("btnCompareRightDownload");
  const btnLeftEdit = el("btnCompareLeftEdit");
  const btnRightEdit = el("btnCompareRightEdit");
  
  if (btnClose) btnClose.onclick = closeCompare;
  if (btnPrev) btnPrev.onclick = () => navigateToGroup(currentGroupIndex - 1);
  if (btnNext) btnNext.onclick = () => navigateToGroup(currentGroupIndex + 1);
  if (btnLeftDelete) btnLeftDelete.onclick = () => handleDelete('left');
  if (btnRightDelete) btnRightDelete.onclick = () => handleDelete('right');
  
  if (btnLeftDownload) btnLeftDownload.onclick = (e) => { e.preventDefault(); handleDownload('left'); };
  if (btnRightDownload) btnRightDownload.onclick = (e) => { e.preventDefault(); handleDownload('right'); };
  
  if (btnLeftEdit) btnLeftEdit.onclick = () => handleEdit('left');
  if (btnRightEdit) btnRightEdit.onclick = () => handleEdit('right');
  
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeCompare();
    });
  }
}

function setupModalKeyboard() {
  if (modalKeyboardHandler) document.removeEventListener("keydown", modalKeyboardHandler);
  
  modalKeyboardHandler = (e) => {
    const modal = el("compareModal");
    if (!modal || modal.style.display === "none") return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    
    switch (e.key) {
      case "Escape": e.preventDefault(); closeCompare(); break;
      case "ArrowLeft": e.preventDefault(); navigateToGroup(currentGroupIndex - 1); break;
      case "ArrowRight": e.preventDefault(); navigateToGroup(currentGroupIndex + 1); break;
      case "1": e.preventDefault(); handleDelete('left'); break;
      case "2": e.preventDefault(); handleDelete('right'); break;
      case "3": e.preventDefault(); handleDeleteBoth(); break;
      case "4": e.preventDefault(); handleIgnoreGroup(); break;
    }
  };
  
  document.addEventListener("keydown", modalKeyboardHandler);
}

function removeModalKeyboard() {
  if (modalKeyboardHandler) {
    document.removeEventListener("keydown", modalKeyboardHandler);
    modalKeyboardHandler = null;
  }
}

function chooseKeepIndexLocal(group, keepRule, folderPriorityCsv = "") {
  if (!Array.isArray(group) || group.length <= 1) return 0;
  
  const mod = f => Date.parse(f.modifiedTime || 0) || 0;
  const size = f => Number(f.size || 0) || 0;
  const res = f => {
    const w = Number(f.imageMediaMetadata?.width || 0);
    const h = Number(f.imageMediaMetadata?.height || 0);
    return (w > 0 && h > 0) ? w * h : Number(f.size || 0);
  };
  
  const folderPriority = (folderPriorityCsv || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  
  const folderRank = (f) => {
    const p = (f.parents?.[0] || "").toLowerCase();
    const name = (f.name || "").toLowerCase();
    const path = (f._path || "").toLowerCase();
    
    for (let i = 0; i < folderPriority.length; i++) {
      if (p.includes(folderPriority[i]) || name.includes(folderPriority[i]) || path.includes(folderPriority[i])) return i;
    }
    return 999999;
  };

  let best = 0;
  
  for (let i = 1; i < group.length; i++) {
    const a = group[best], b = group[i];
    let pickB = false;

    switch (keepRule) {
      case "newest": pickB = mod(b) > mod(a); break;
      case "oldest": pickB = mod(b) < mod(a); break;
      case "largest": pickB = size(b) > size(a); break;
      case "smallest": pickB = size(b) < size(a); break;
      case "hires": pickB = res(b) > res(a); break;
      case "folderPriority": pickB = folderRank(b) < folderRank(a); break;
    }
    
    if (pickB) best = i;
  }
  
  return best;
}

function refreshGroups() {
  if (onGetCurrentGroups) allGroups = onGetCurrentGroups();
}

// v14: render a folder breadcrumb that, when a parent folder id is known, links
// out to that folder in Google Drive (new tab). Falls back to plain text.
function setFolderBreadcrumb(elm, pathStr, file) {
  if (!elm) return;
  const folderUrl = driveFolderLink(file?.parents?.[0]);
  const label = pathStr && pathStr.length ? pathStr : (folderUrl ? "Open containing folder" : "");
  elm.innerHTML = "";
  if (folderUrl) {
    const a = document.createElement("a");
    a.href = folderUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "folderLink";
    a.title = "Open containing folder in Google Drive";
    a.textContent = label;
    elm.appendChild(a);
  } else {
    elm.textContent = label;
  }
}

function getFilePath(file) {
  // First check if path was set on the file object during rendering
  if (file._path && file._path.length > 0 && !file._path.match(/^[A-Za-z0-9_-]{20,}$/)) {
    return file._path;
  }
  
  // Try to get from pathMap via callback
  if (onGetPathMap) {
    const pathMap = onGetPathMap();
    if (pathMap && pathMap.has(file.id)) {
      const path = pathMap.get(file.id);
      if (path && path.length > 0) {
        file._path = path; // Cache it
        return path;
      }
    }
  }
  
  // Fallback - return empty string rather than showing ID
  return "";
}

async function handleIgnoreGroup() {
  if (currentGroupIndex < 0 || currentGroupIndex >= allGroups.length) return;

  // Feature #19: Record rejection for false-positive suppression.
  // v14.0 FIX: currentIdToEntry was only set when openCompare received an
  // idToEntry option, but neither the table-click handler nor navigateToGroup
  // passed it — so this was almost always null and "Ignore" never actually
  // persisted (ignored pairs reappeared on the next scan). Fall back to the
  // live idToEntry from the renderer so rejections are always recorded.
  const group = allGroups[currentGroupIndex];
  const idToEntry = currentIdToEntry || (onGetIdToEntry ? onGetIdToEntry() : null);
  if (group && group.length >= 2 && idToEntry) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const eA = idToEntry.get(group[i]?.id);
        const eB = idToEntry.get(group[j]?.id);
        if (eA && eB) await recordRejection(eA, eB);
      }
    }
  }

  showToast("Group marked as not a duplicate — won't show again", "info", 2500);

  // v14.0 FIX: previously this removed the group TWICE — once via the
  // onIgnoreGroup callback and again via the ddd:ignoreGroup event, both of
  // which call removeGroupByIndex(currentGroupIndex). The second call ran after
  // the array had already shifted, so it silently removed an unrelated adjacent
  // group. Remove via a single path (the event, matching the ddd:trashed flow).
  window.dispatchEvent(new CustomEvent("ddd:ignoreGroup", { detail: { groupIndex: currentGroupIndex } }));

  setTimeout(() => {
    refreshGroups();
    if (allGroups.length === 0) {
      showToast("All groups processed!", "success");
      closeCompare();
    } else {
      navigateToGroup(Math.min(currentGroupIndex, allGroups.length - 1));
    }
  }, 100);
}

function handleEdit(side) {
  const file = side === 'left' ? leftFile : rightFile;
  if (!file) return;
  
  const modal = el("compareModal");
  if (modal) modal.style.display = "none";
  removeModalKeyboard();
  
  const group = allGroups[currentGroupIndex] || [];
  const indexInGroup = group.findIndex(f => f.id === file.id);
  
  openCropModal(file, {
    group: group,
    indexInGroup: indexInGroup >= 0 ? indexInGroup : 0,
    allGroups: allGroups,
    groupIndex: currentGroupIndex
  });
}

function navigateToGroup(newIndex) {
  refreshGroups();
  
  if (allGroups.length === 0) {
    showToast("All groups processed!", "success");
    closeCompare();
    return;
  }
  
  if (newIndex < 0) { showToast("Already at first group", "info"); return; }
  if (newIndex >= allGroups.length) { showToast("No more groups to review", "info"); return; }
  
  const group = allGroups[newIndex];
  if (!group || group.length < 2) {
    navigateToGroup(newIndex + 1);
    return;
  }
  
  const keepRule = document.getElementById("keepRule")?.value || "hires";
  const folderPriority = document.getElementById("folderPriority")?.value || "";
  
  const keepIdx = chooseKeepIndexLocal(group, keepRule, folderPriority);
  const keepFile = group[keepIdx] || group[0];
  const dupFile = group.find(f => f.id !== keepFile.id) || group[0];
  
  if (keepFile && dupFile) {
    currentGroupIndex = newIndex;
    openCompare(keepFile, dupFile, { leftIsKeep: true, rightIsKeep: false, groupIndex: newIndex, allGroups: allGroups });
  }
}

async function handleDownload(side) {
  const file = side === 'left' ? leftFile : rightFile;
  if (!file) return;
  
  const btn = el(side === 'left' ? 'btnCompareLeftDownload' : 'btnCompareRightDownload');
  if (btn) btn.classList.add("loading");
  
  try {
    const blob = await downloadFileBlob(file.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
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
    if (btn) btn.classList.remove("loading");
  }
}

async function handleDeleteBoth() {
  const filesToDelete = [];
  if (leftFile) filesToDelete.push({ file: leftFile, isKeep: leftIsKeep });
  if (rightFile) filesToDelete.push({ file: rightFile, isKeep: rightIsKeep });
  
  if (filesToDelete.length === 0) return;
  if (filesToDelete.some(f => f.isKeep)) showToast("⚠️ Warning: Deleting KEEP file(s)!", "info", 2000);
  
  const btnLeft = el('btnCompareLeftDelete');
  const btnRight = el('btnCompareRightDelete');
  if (btnLeft) btnLeft.classList.add("loading");
  if (btnRight) btnRight.classList.add("loading");
  
  try {
    const ids = filesToDelete.map(f => f.file.id);
    const result = await batchTrash(ids);
    
    if (result.success.length > 0) {
      showToast(`${result.success.length} file(s) moved to trash`, "success");
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: result.success } }));
      
      setTimeout(() => {
        refreshGroups();
        if (allGroups.length === 0) { showToast("All groups processed!", "success"); closeCompare(); }
        else navigateToGroup(Math.min(currentGroupIndex, allGroups.length - 1));
      }, 300);
    }
    if (result.failed.length > 0) showToast(`${result.failed.length} file(s) failed to delete`, "error");
  } catch (err) {
    showToast("Delete failed: " + (err?.message || err), "error");
    if (btnLeft) btnLeft.classList.remove("loading");
    if (btnRight) btnRight.classList.remove("loading");
  }
}

async function handleDelete(side) {
  const fileBeingDeleted = side === "left" ? leftFile : rightFile;
  const file = side === 'left' ? leftFile : rightFile;
  const isKeep = side === 'left' ? leftIsKeep : rightIsKeep;
  
  if (!file) return;
  if (isKeep) showToast("⚠️ Warning: Deleting the KEEP file!", "info", 2000);
  
  const btn = el(side === 'left' ? 'btnCompareLeftDelete' : 'btnCompareRightDelete');
  if (btn) btn.classList.add("loading");
  
  try {
    const result = await batchTrash([file.id]);
    if (result.success.includes(file.id)) {
      showToast("File moved to trash", "success");
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: [file.id] } }));
      
      setTimeout(() => {
        refreshGroups();
        if (allGroups.length === 0) { showToast("All groups processed!", "success"); closeCompare(); }
        else navigateToGroup(Math.min(currentGroupIndex, allGroups.length - 1));
      }, 300);
    } else throw new Error("Trash operation failed");
  } catch (err) {
    showToast("Delete failed: " + (err?.message || err), "error");
    if (btn) btn.classList.remove("loading");
  }
}

export function setCompareCallbacks({ onDelete, onSelect, getCurrentGroups, onIgnore, getPathMap, getIdToEntry }) {
  onDeleteCallback = onDelete;
  onSelectCallback = onSelect;
  onGetCurrentGroups = getCurrentGroups;
  onIgnoreGroup = onIgnore;
  onGetPathMap = getPathMap;
  onGetIdToEntry = getIdToEntry || null;
}

export async function openCompare(fileA, fileB, options = {}) {
  if (options.idToEntry) currentIdToEntry = options.idToEntry;
  leftFile = fileA;
  rightFile = fileB;
  leftIsKeep = options.leftIsKeep || false;
  rightIsKeep = options.rightIsKeep || false;
  
  if (options.groupIndex !== undefined) currentGroupIndex = options.groupIndex;
  if (options.allGroups) allGroups = options.allGroups;
  else if (onGetCurrentGroups) allGroups = onGetCurrentGroups();
  
  const modal = el("compareModal");
  const leftTitle = el("compareLeftTitle");
  const rightTitle = el("compareRightTitle");
  const leftImg = el("compareLeftImg");
  const rightImg = el("compareRightImg");
  const leftMeta = el("compareLeftMeta");
  const rightMeta = el("compareRightMeta");
  const leftLink = el("compareLeftLink");
  const rightLink = el("compareRightLink");
  const leftKeepBadge = el("compareLeftKeep");
  const rightKeepBadge = el("compareRightKeep");
  const btnLeftDelete = el("btnCompareLeftDelete");
  const btnRightDelete = el("btnCompareRightDelete");
  const btnPrev = el("btnComparePrev");
  const btnNext = el("btnCompareNext");
  const leftPath = el("compareLeftPath");
  const rightPath = el("compareRightPath");
  
  if (btnPrev) btnPrev.style.display = (currentGroupIndex > 0) ? "inline-block" : "none";
  if (btnNext) btnNext.style.display = (currentGroupIndex < allGroups.length - 1) ? "inline-block" : "none";
  
  if (leftTitle) leftTitle.textContent = fileA.name || "Image A";
  if (rightTitle) rightTitle.textContent = fileB.name || "Image B";
  
  // Set folder paths
  const leftPathStr = getFilePath(fileA);
  const rightPathStr = getFilePath(fileB);
  // v14: the folder breadcrumb is now clickable and opens the containing Drive
  // folder in a new tab, so the user can see the file alongside its neighbours.
  setFolderBreadcrumb(leftPath, leftPathStr, fileA);
  setFolderBreadcrumb(rightPath, rightPathStr, fileB);
  
  if (leftKeepBadge) leftKeepBadge.style.display = leftIsKeep ? "inline-block" : "none";
  if (rightKeepBadge) rightKeepBadge.style.display = rightIsKeep ? "inline-block" : "none";
  
  // Reset delete buttons
  if (btnLeftDelete) {
    btnLeftDelete.classList.remove("loading");
    btnLeftDelete.style.opacity = leftIsKeep ? "0.7" : "1";
    btnLeftDelete.title = leftIsKeep ? "⚠️ WARNING: This is the KEEP file!" : "Move to trash";
  }
  if (btnRightDelete) {
    btnRightDelete.classList.remove("loading");
    btnRightDelete.style.opacity = rightIsKeep ? "0.7" : "1";
    btnRightDelete.title = rightIsKeep ? "⚠️ WARNING: This is the KEEP file!" : "Move to trash";
  }
  
  // Single-line metadata
  const makeMeta = (f) => {
    const dims = f.imageMediaMetadata 
      ? `Resolution: ${f.imageMediaMetadata.width} × ${f.imageMediaMetadata.height} px` 
      : "Resolution: unknown";
    const size = `Size: ${bytesToHuman(f.size || 0)}`;
    const modified = `Modified: ${formatDate(f.modifiedTime)}`;
    return `${dims} | ${size} | ${modified}`;
  };
  
  if (leftMeta) leftMeta.textContent = makeMeta(fileA);
  if (rightMeta) rightMeta.textContent = makeMeta(fileB);
  
  if (leftLink) leftLink.href = driveFilePreviewLink(fileA) || "#";
  if (rightLink) rightLink.href = driveFilePreviewLink(fileB) || "#";

  // v14: show the inline placeholder while the real image loads, and fall back
  // to it if the image ever fails to load (deleted file, CORS, 404, etc.).
  if (leftImg) { leftImg.onerror = () => { leftImg.src = IMAGE_PLACEHOLDER; }; leftImg.src = IMAGE_PLACEHOLDER; leftImg.alt = "Loading…"; }
  if (rightImg) { rightImg.onerror = () => { rightImg.src = IMAGE_PLACEHOLDER; }; rightImg.src = IMAGE_PLACEHOLDER; rightImg.alt = "Loading…"; }

  if (modal) {
    modal.style.display = "flex";
    lockBodyScroll(true);
    modal.focus();
  }
  
  setupModalKeyboard();

  // Show the images as fast as possible. Setting img.src directly to Google's
  // thumbnail URL renders immediately (the browser fetches/decodes it off the
  // main thread and it doesn't queue behind the scan's authenticated blob
  // downloads). Previously we awaited getThumbUrlForFile first, which goes
  // through the authenticated download path and competes with hashing during a
  // background scan — that's why the modal sat on "Loading…". We optionally
  // upgrade to the higher-quality authenticated blob afterwards, without
  // blocking the initial display.
  const fastA = fileA.thumbnailLink ? thumbLinkSized(fileA.thumbnailLink, 800) : null;
  const fastB = fileB.thumbnailLink ? thumbLinkSized(fileB.thumbnailLink, 800) : null;
  if (leftImg && fastA) { leftImg.src = fastA; leftImg.alt = fileA.name || "Image A"; }
  if (rightImg && fastB) { rightImg.src = fastB; rightImg.alt = fileB.name || "Image B"; }

  // Background upgrade (best-effort, non-blocking). Only swap if the modal is
  // still showing this same pair when the blob arrives.
  const pairToken = `${fileA.id}|${fileB.id}`;
  upgradeCompareImages(fileA, fileB, pairToken, leftImg, rightImg);
}

let _compareUpgradeToken = "";
async function upgradeCompareImages(fileA, fileB, pairToken, leftImg, rightImg) {
  _compareUpgradeToken = pairToken;
  try {
    const [aUrl, bUrl] = await Promise.all([getLargeThumb(fileA), getLargeThumb(fileB)]);
    // Bail if the user navigated to a different pair or closed the modal.
    if (_compareUpgradeToken !== pairToken) return;
    if (leftImg && aUrl && leftFile?.id === fileA.id) leftImg.src = aUrl;
    if (rightImg && bUrl && rightFile?.id === fileB.id) rightImg.src = bUrl;
  } catch (e) {
    // Fast-path image is already showing; ignore upgrade failure.
  }
}

async function getLargeThumb(file) {
  try {
    const url = await getThumbUrlForFile(file, { size: 800 });
    if (url) return url;
  } catch (e) {}
  if (file.thumbnailLink) return thumbLinkSized(file.thumbnailLink, 800);
  return "";
}

export function closeCompare() {
  const modal = el("compareModal");
  if (modal) {
    modal.style.display = "none";
    lockBodyScroll(false);
  }
  removeModalKeyboard();
  _compareUpgradeToken = "";  // cancel any in-flight background image upgrade
  leftFile = null;
  rightFile = null;
}

export { currentGroupIndex, allGroups };
