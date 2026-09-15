/*
 * Drive Dupe Destroyer (DDD) — compare.js
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
// Side-by-side image comparison with delete actions and keyboard shortcuts
// Fixed: Proper folder path display from pathMap

import { recordRejection } from "./rejection.js";
import { chooseKeepIndex, DEFAULT_KEEP_RULE } from "./common.js";
import { pushUndoDeleteBatch, undoLastDelete } from "./undo.js";
import { el, bytesToHuman, formatDate, IMAGE_PLACEHOLDER } from "./util.js";
import { getThumbUrlForFile } from "./hashing.js";
import { lockBodyScroll, showToast, showTrashedToast } from "./ui.js";
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
// Which pair WITHIN the current group is on screen. The view used to pair the
// keeper with group.find(f => f.id !== keep.id) -- the first other member --
// and never show the rest, then report "All groups processed!", which reads as
// having seen everything. A group of N now walks N-1 pairs. See #55.
let currentPairIndex = 0;
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
  if (btnPrev) btnPrev.onclick = () => navigatePair(-1);
  if (btnNext) btnNext.onclick = () => navigatePair(1);
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
      case "ArrowLeft": e.preventDefault(); navigatePair(-1); break;
      case "ArrowRight": e.preventDefault(); navigatePair(1); break;
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

// The keeper is decided in exactly one place, common.js. This file used to
// carry its own copy, chooseKeepIndexLocal, which had drifted: it compared a
// byte count against a pixel count under the "hires" rule, matched a folder
// priority term against the opaque parent ID and the file's own name, kept
// index 0 for an unrecognised rule, and broke ties by array order. On the same
// group it picked a different file from the list and the CSV export in all four
// cases -- and since the compare view hard-coded the LEFT pane as the keeper,
// the file the rest of the app wanted kept landed on the right, where the
// "deleting the KEEP file" warning is disabled.
function currentKeepRule() {
  return el("keepRule")?.value || DEFAULT_KEEP_RULE;
}

function currentFolderPriority() {
  return el("folderPriority")?.value || "";
}

function keepFileForGroup(group) {
  if (!Array.isArray(group) || group.length === 0) return null;
  const idx = chooseKeepIndex(group, currentKeepRule(), currentFolderPriority());
  return group[idx] || group[0];
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
      showPair(Math.min(currentGroupIndex, allGroups.length - 1), currentPairIndex);
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

// Every member of a group except the keeper. Each one is a pair to review.
function candidatesIn(group) {
  const keepFile = keepFileForGroup(group);
  return { keepFile, others: (group || []).filter(f => f.id !== keepFile?.id) };
}

function pairCount(index) {
  const g = allGroups[index];
  return g && g.length >= 2 ? candidatesIn(g).others.length : 0;
}

// The first group at or after `from` that still has something to compare.
// Groups shrink as files are trashed, so a group can drop below two members
// while the view is open.
function nextReviewable(from, step) {
  for (let i = from; i >= 0 && i < allGroups.length; i += step) {
    if (pairCount(i) > 0) return i;
  }
  return -1;
}

function updateProgress() {
  const label = el("compareProgress");
  if (!label) return;
  const pairs = pairCount(currentGroupIndex);
  const reviewable = allGroups.reduce((n, _, i) => n + (pairCount(i) > 0 ? 1 : 0), 0);
  // Count this group's position among reviewable ones, not its raw index, or
  // the numbers jump as groups are emptied.
  let ordinal = 0;
  for (let i = 0; i <= currentGroupIndex && i < allGroups.length; i++) if (pairCount(i) > 0) ordinal++;
  label.textContent = pairs > 1
    ? `Group ${ordinal} of ${reviewable} · pair ${currentPairIndex + 1} of ${pairs}`
    : `Group ${ordinal} of ${reviewable}`;
}

// The one entry point. Shows the keeper against the pairIndex-th other member,
// rolling into the neighbouring group when it runs off either end.
function showPair(groupIndex, pairIndex) {
  refreshGroups();

  if (allGroups.length === 0 || nextReviewable(0, 1) < 0) {
    showToast("All groups processed!", "success");
    closeCompare();
    return;
  }

  let gi = groupIndex;
  let pi = pairIndex;

  // Ran off the end of this group -> the start of the next reviewable one.
  while (gi < allGroups.length && pi >= pairCount(gi)) {
    const next = nextReviewable(gi + 1, 1);
    if (next < 0) { showToast("No more groups to review", "info"); return; }
    pi -= Math.max(pairCount(gi), 1);
    gi = next;
    if (pi < 0) pi = 0;
  }
  // Ran off the start -> the LAST pair of the previous reviewable group, so
  // stepping back never skips the members it just walked forward through.
  while (gi >= 0 && pi < 0) {
    const prev = nextReviewable(gi - 1, -1);
    if (prev < 0) { showToast("Already at first group", "info"); return; }
    gi = prev;
    pi += pairCount(gi);
  }

  if (gi < 0 || gi >= allGroups.length) return;
  const { keepFile, others } = candidatesIn(allGroups[gi]);
  if (!keepFile || others.length === 0) return;

  currentGroupIndex = gi;
  currentPairIndex = Math.min(Math.max(pi, 0), others.length - 1);

  // No leftIsKeep/rightIsKeep here: openCompare derives them from the group,
  // so no caller can label the wrong pane.
  openCompare(keepFile, others[currentPairIndex], { groupIndex: gi, allGroups: allGroups });
  updateProgress();
}

// Step one pair forward or back, crossing group boundaries.
function navigatePair(delta) {
  showPair(currentGroupIndex, currentPairIndex + delta);
}

// Jump to a whole group, entering at its first pair. Kept for the callers that
// genuinely mean "a different group" rather than "the next thing to look at".
function navigateToGroup(newIndex) {
  refreshGroups();
  if (newIndex < 0) { showToast("Already at first group", "info"); return; }
  const target = nextReviewable(newIndex, newIndex >= currentGroupIndex ? 1 : -1);
  if (target < 0) {
    if (nextReviewable(0, 1) < 0) { showToast("All groups processed!", "success"); closeCompare(); }
    else showToast("No more groups to review", "info");
    return;
  }
  showPair(target, 0);
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
      // Record as one undo operation. pushUndoDelete was imported here but never
      // actually called, so no delete path in the app recorded anything and the
      // Undo button had nothing to restore.
      const trashed = new Set(result.success);
      pushUndoDeleteBatch(filesToDelete.map(f => f.file).filter(f => trashed.has(f.id)));

      showTrashedToast(result.success.length, () => undoLastDelete());
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: result.success } }));
      
      setTimeout(() => {
        refreshGroups();
        if (allGroups.length === 0) { showToast("All groups processed!", "success"); closeCompare(); }
        else showPair(Math.min(currentGroupIndex, allGroups.length - 1), currentPairIndex);
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
  const file = side === 'left' ? leftFile : rightFile;
  const isKeep = side === 'left' ? leftIsKeep : rightIsKeep;
  
  if (!file) return;
  if (isKeep) showToast("⚠️ Warning: Deleting the KEEP file!", "info", 2000);
  
  const btn = el(side === 'left' ? 'btnCompareLeftDelete' : 'btnCompareRightDelete');
  if (btn) btn.classList.add("loading");
  
  try {
    const result = await batchTrash([file.id]);
    if (result.success.includes(file.id)) {
      pushUndoDeleteBatch([file]);
      showTrashedToast(1, () => undoLastDelete());
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: [file.id] } }));
      
      setTimeout(() => {
        refreshGroups();
        if (allGroups.length === 0) { showToast("All groups processed!", "success"); closeCompare(); }
        else showPair(Math.min(currentGroupIndex, allGroups.length - 1), currentPairIndex);
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
  
  if (options.groupIndex !== undefined) currentGroupIndex = options.groupIndex;
  if (options.allGroups) allGroups = options.allGroups;
  else if (onGetCurrentGroups) allGroups = onGetCurrentGroups();

  // Derive which pane holds the keeper instead of trusting the caller. All three
  // call sites passed `leftIsKeep: true` unconditionally -- correct from
  // render.js, which puts the real keeper on the left, but wrong from crop.js,
  // which passes group[0] and group[1] as they happen to be ordered. The badge,
  // the dimmed delete button, its tooltip and the "deleting the KEEP file"
  // warning all read these two flags, so getting them from one shared decision
  // is what keeps the warning pointing at the right file.
  const group = allGroups?.[currentGroupIndex];
  const inGroup = Array.isArray(group) && group.some(f => f.id === fileA?.id || f.id === fileB?.id);
  const groupKeeper = inGroup
    ? keepFileForGroup(group)
    : keepFileForGroup([fileA, fileB].filter(Boolean));

  // Entered from the row's Compare button or the crop editor rather than from
  // the Prev/Next walk: sync the pair cursor to whichever file is on screen, so
  // the counter is honest and stepping onward continues from here.
  if (inGroup && groupKeeper) {
    const shown = groupKeeper.id === fileA?.id ? fileB : fileA;
    const at = group.filter(f => f.id !== groupKeeper.id).findIndex(f => f.id === shown?.id);
    if (at >= 0) currentPairIndex = at;
  }
  // showPair() updates the label on its own path; this covers direct entry.
  updateProgress();

  if (groupKeeper) {
    leftIsKeep = groupKeeper.id === fileA?.id;
    rightIsKeep = groupKeeper.id === fileB?.id;
  } else {
    leftIsKeep = options.leftIsKeep || false;
    rightIsKeep = options.rightIsKeep || false;
  }
  
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
  
  const morePairsAfter = currentPairIndex < pairCount(currentGroupIndex) - 1
    || nextReviewable(currentGroupIndex + 1, 1) >= 0;
  const morePairsBefore = currentPairIndex > 0 || nextReviewable(currentGroupIndex - 1, -1) >= 0;
  if (btnPrev) btnPrev.style.display = morePairsBefore ? "inline-block" : "none";
  if (btnNext) btnNext.style.display = morePairsAfter ? "inline-block" : "none";
  
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
