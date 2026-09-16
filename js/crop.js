/*
 * Drive Dupe Destroyer (DDD) — crop.js
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
// Image cropping modal with marching ants selection, rotate, zoom, fixed-size selection, and delete
// Features: Stay in modal after crop, locked aspect ratio, D key delete shortcut

import { el, bytesToHuman, formatDate } from "./util.js";
import { confirmAction, UNDO_NOTE } from "./confirm.js";
import { settingGet, settingSet } from "./db.js";
import { lockBodyScroll, showToast, showTrashedToast } from "./ui.js";
import { pushUndoDeleteBatch, undoLastDelete } from "./undo.js";
import { batchTrash, uploadFile, downloadFileBlob } from "./drive.js";
import { openCompare } from "./compare.js";

let currentFile = null;
let currentGroup = [];
let currentIndexInGroup = 0;
let allGroups = [];
let currentGroupIndex = 0;
let originalImage = null;
let canvas = null;
let ctx = null;
// #118: the overlay canvas. Everything that changes per frame is drawn here;
// the image canvas above is painted once per transform and then left alone.
let overlay = null;
let octx = null;
let overlayNeedsClear = false;
// measureText is not free, and the label only changes when the selection does.
let labelCache = { text: null, width: 0 };
let selection = null;
let isSelecting = false;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let startX = 0;
let startY = 0;
let marchingAntsOffset = 0;
let animationId = null;
let onCropComplete = null;
let onGetCurrentGroups = null;

// Transform state
let rotation = 0;
let zoomLevel = 1;
let displayScale = 1;

// Remembered crop AREA, so the same region can be cropped out of image after
// image without reselecting it every time.
//
// Stored as FRACTIONS of the displayed image, never pixels. The canvas is
// scaled to fit the window (displayScale) and the next image may be a different
// size entirely, so pixels would land somewhere arbitrary. Fractions mean "the
// same part of the picture", which is what you actually want, and they collapse
// to the identical rectangle when the images are the same size — the common
// case for screenshots or a burst from one camera.
//
// Nothing is ever cropped without pressing Crop, and the restored rectangle is
// drawn on the canvas first, so a remembered area can always be seen and
// adjusted before it is used.
const AREA_KEY = "destroyer_crop_area";
const AREA_ON_KEY = "destroyer_crop_area_reuse";
let rememberArea = true;
let lastArea = null;        // { x, y, w, h } as 0..1 fractions

// Fixed size selection state (persisted during session)
let isLocked = false;
let lockedWidth = 0;
let lockedHeight = 0;
let rememberedWidth = 800;
let rememberedHeight = 600;

// Bound event handlers
let boundMouseMove = null;
let boundMouseUp = null;

export function wireCrop() {
  // Reuse the last crop area on the next image (#77). Cropping the same region
  // out of a run of pictures otherwise means reselecting it every single time.
  const reuseToggle = el("cropReuseArea");
  if (reuseToggle) {
    reuseToggle.onchange = () => {
      rememberArea = reuseToggle.checked;
      settingSet(AREA_ON_KEY, rememberArea).catch(() => {});
      if (rememberArea) applyRememberedArea();
      else { selection = null; redrawCanvas(); }
      updateAreaUI();
    };
  }
  const btnClearArea = el("btnCropClearArea");
  if (btnClearArea) btnClearArea.onclick = clearRememberedArea;


  const btnClose = el("btnCropClose");
  const btnCancel = el("btnCropCancel");
  const btnCrop = el("btnCropConfirm");
  const btnDelete = el("btnCropDelete");
  const btnPrev = el("btnCropPrev");
  const btnNext = el("btnCropNext");
  const btnRotate = el("btnCropRotate");
  const btnLock = el("btnCropLock");
  const inputWidth = el("cropFixedWidth");
  const inputHeight = el("cropFixedHeight");
  const modal = el("cropModal");
  const cropCanvas = el("cropCanvas");
  
  if (btnClose) btnClose.onclick = closeCropReturnToCompare;
  if (btnCancel) btnCancel.onclick = closeCropReturnToCompare;
  if (btnCrop) btnCrop.onclick = performCrop;
  if (btnDelete) btnDelete.onclick = handleCropDelete;
  if (btnPrev) btnPrev.onclick = navigatePrev;
  if (btnNext) btnNext.onclick = navigateNext;
  if (btnRotate) btnRotate.onclick = rotateImage;
  if (btnLock) btnLock.onclick = toggleLock;
  
  // Input fields for fixed size
  if (inputWidth) {
    inputWidth.value = rememberedWidth;
    inputWidth.oninput = () => {
      rememberedWidth = parseInt(inputWidth.value, 10) || 100;
      if (isLocked) applyLockedSize();
    };
  }
  if (inputHeight) {
    inputHeight.value = rememberedHeight;
    inputHeight.oninput = () => {
      rememberedHeight = parseInt(inputHeight.value, 10) || 100;
      if (isLocked) applyLockedSize();
    };
  }
  
  // Zoom buttons
  const zoomBtns = document.querySelectorAll("[data-zoom]");
  zoomBtns.forEach(btn => {
    btn.onclick = () => setZoom(parseFloat(btn.dataset.zoom));
  });
  
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeCropReturnToCompare();
    });
  }
  
  if (cropCanvas) {
    cropCanvas.addEventListener("mousedown", handleMouseDown);
    cropCanvas.addEventListener("touchstart", handleTouchStart, { passive: false });
  }
  
  document.addEventListener("keydown", handleCropKeyboard);
}

function handleCropKeyboard(e) {
  const modal = el("cropModal");
  if (!modal || modal.style.display === "none") return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  
  switch (e.key) {
    case "Escape":
      e.preventDefault();
      closeCropReturnToCompare();
      break;
    case "ArrowLeft":
      e.preventDefault();
      navigatePrev();
      break;
    case "ArrowRight":
      e.preventDefault();
      navigateNext();
      break;
    case "Enter":
      e.preventDefault();
      if (selection && selection.width > 10 && selection.height > 10) performCrop();
      break;
    case "r":
    case "R":
      e.preventDefault();
      rotateImage();
      break;
    case "l":
    case "L":
      e.preventDefault();
      toggleLock();
      break;
    case "d":
    case "D":
      e.preventDefault();
      handleCropDelete();
      break;
  }
}

function toggleLock() {
  isLocked = !isLocked;
  updateLockUI();
  
  if (isLocked) {
    applyLockedSize();
  }
}

function updateLockUI() {
  const btnLock = el("btnCropLock");
  const inputWidth = el("cropFixedWidth");
  const inputHeight = el("cropFixedHeight");
  
  if (btnLock) {
    btnLock.classList.toggle("active", isLocked);
    const icon = btnLock.querySelector("i");
    if (icon) {
      icon.className = isLocked ? "fa-solid fa-lock" : "fa-solid fa-lock-open";
    }
  }
  
  if (inputWidth) inputWidth.classList.toggle("active", isLocked);
  if (inputHeight) inputHeight.classList.toggle("active", isLocked);
}

function applyLockedSize() {
  if (!canvas || !isLocked) return;
  
  const inputWidth = el("cropFixedWidth");
  const inputHeight = el("cropFixedHeight");
  
  const targetW = parseInt(inputWidth?.value, 10) || rememberedWidth;
  const targetH = parseInt(inputHeight?.value, 10) || rememberedHeight;
  
  rememberedWidth = targetW;
  rememberedHeight = targetH;
  
  // Convert to display coordinates
  const dims = getTransformedDimensions();
  const scaleX = canvas.width / dims.width;
  const scaleY = canvas.height / dims.height;
  
  lockedWidth = Math.min(targetW * scaleX, canvas.width);
  lockedHeight = Math.min(targetH * scaleY, canvas.height);
  
  // Center the selection if none exists
  if (!selection) {
    selection = {
      x: Math.max(0, (canvas.width - lockedWidth) / 2),
      y: Math.max(0, (canvas.height - lockedHeight) / 2),
      width: lockedWidth,
      height: lockedHeight
    };
  } else {
    // Resize existing selection to locked size, keeping center
    const centerX = selection.x + selection.width / 2;
    const centerY = selection.y + selection.height / 2;
    
    selection.width = lockedWidth;
    selection.height = lockedHeight;
    selection.x = Math.max(0, Math.min(canvas.width - lockedWidth, centerX - lockedWidth / 2));
    selection.y = Math.max(0, Math.min(canvas.height - lockedHeight, centerY - lockedHeight / 2));
  }
  
  updateCropButton();
}

function updateCropButton() {
  const btnCrop = el("btnCropConfirm");
  if (btnCrop && selection) {
    btnCrop.disabled = selection.width < 10 || selection.height < 10;
  }
}

export function setCropCallbacks({ onComplete, getCurrentGroups }) {
  onCropComplete = onComplete;
  onGetCurrentGroups = getCurrentGroups;
}

function refreshGroups() {
  if (onGetCurrentGroups) {
    allGroups = onGetCurrentGroups();
    if (currentGroupIndex < allGroups.length) {
      currentGroup = allGroups[currentGroupIndex];
    }
  }
}

export async function openCropModal(file, options = {}) {
  currentFile = file;
  currentGroup = options.group || [file];
  currentIndexInGroup = options.indexInGroup || 0;
  allGroups = options.allGroups || [currentGroup];
  currentGroupIndex = options.groupIndex || 0;
  
  // Reset transforms but keep locked size settings
  rotation = 0;
  zoomLevel = 1;
  selection = null;
  updateZoomButtons();
  updateLockUI();
  
  await loadCropAreaSettings();

  // Restore remembered values to inputs
  const inputWidth = el("cropFixedWidth");
  const inputHeight = el("cropFixedHeight");
  if (inputWidth) inputWidth.value = rememberedWidth;
  if (inputHeight) inputHeight.value = rememberedHeight;
  
  const modal = el("cropModal");
  const cropCanvas = el("cropCanvas");
  const btnCrop = el("btnCropConfirm");
  
  if (!modal || !cropCanvas) {
    showToast("Crop modal not found", "error");
    return;
  }
  
  canvas = cropCanvas;
  ctx = canvas.getContext("2d");
  overlay = el("cropOverlay");
  octx = overlay ? overlay.getContext("2d") : null;
  
  if (btnCrop) btnCrop.disabled = true;
  
  updateCropInfo();
  updateNavButtons();
  
  modal.style.display = "flex";
  lockBodyScroll(true);
  
  await loadImageForCrop(file);
  
  // If locked, apply the locked size after image loads
  if (isLocked) {
    applyLockedSize();
  }
  
  startMarchingAnts();
}

async function loadImageForCrop(file) {
  const cropLoading = el("cropLoading");
  const cropCanvas = el("cropCanvas");
  
  if (cropLoading) cropLoading.style.display = "flex";
  if (cropCanvas) cropCanvas.style.display = "none";
  // The overlay is absolutely positioned, so hiding only the image canvas
  // would leave it floating over an empty loading panel.
  { const o = el("cropOverlay"); if (o) o.style.display = "none"; }
  
  try {
    // Release the previous image before loading the next. closeCropModal only
    // revoked the current one, so stepping through a group with the next/prev
    // buttons leaked one full-resolution blob per step.
    if (originalImage?.src?.startsWith("blob:")) {
      try { URL.revokeObjectURL(originalImage.src); } catch {}
    }

    // downloadFileBlob goes through authedFetch, which refreshes and retries on
    // a 401. The raw fetch here surfaced an expired token as
    // "Failed to download image".
    const blob = await downloadFileBlob(file.id);
    const imageUrl = URL.createObjectURL(blob);
    
    originalImage = new Image();
    await new Promise((resolve, reject) => {
      originalImage.onload = resolve;
      originalImage.onerror = reject;
      originalImage.src = imageUrl;
    });
    
    updateCropInfo();
    redrawCanvas();

    // After redrawCanvas, which sizes the canvas and clears any selection.
    // Restoring before it would be wiped by it.
    applyRememberedArea();
    updateAreaUI();

    if (cropLoading) cropLoading.style.display = "none";
    if (cropCanvas) cropCanvas.style.display = "block";
    { const o = el("cropOverlay"); if (o) o.style.display = "block"; }
    
  } catch (err) {
    console.error("Failed to load image for crop:", err);
    showToast("Failed to load image: " + (err.message || err), "error");
    if (cropLoading) cropLoading.textContent = "Failed to load image";
  }
}

// Record the current selection as fractions of the canvas.
function rememberCurrentArea() {
  if (!rememberArea || !selection || !canvas?.width || !canvas?.height) return;
  if (selection.width < 10 || selection.height < 10) return;
  lastArea = {
    x: selection.x / canvas.width,
    y: selection.y / canvas.height,
    w: selection.width / canvas.width,
    h: selection.height / canvas.height,
  };
  settingSet(AREA_KEY, lastArea).catch(() => {});
  updateAreaUI();
}

// Put a remembered area back onto whatever image is now loaded.
//
// Clamped rather than rejected when it does not fit: a 16:9 area reused on a
// 4:3 photo should give you the nearest sensible rectangle to adjust, not
// nothing at all.
function applyRememberedArea() {
  if (!rememberArea || !lastArea || !canvas?.width || !canvas?.height) return false;
  if (isLocked) return false;          // the fixed-size feature owns the selection

  const w = Math.min(canvas.width, Math.max(10, lastArea.w * canvas.width));
  const h = Math.min(canvas.height, Math.max(10, lastArea.h * canvas.height));
  const x = Math.max(0, Math.min(canvas.width - w, lastArea.x * canvas.width));
  const y = Math.max(0, Math.min(canvas.height - h, lastArea.y * canvas.height));

  // No explicit draw: the marching-ants animation loop reads `selection` every
  // frame, so assigning it is what puts it on screen.
  selection = { x, y, width: w, height: h };

  const btnCrop = el("btnCropConfirm");
  if (btnCrop) btnCrop.disabled = selection.width < 10 || selection.height < 10;
  return true;
}

function clearRememberedArea() {
  lastArea = null;
  if (canvas) delete canvas.dataset.selection;
  settingSet(AREA_KEY, null).catch(() => {});
  selection = null;
  const btnCrop = el("btnCropConfirm");
  if (btnCrop) btnCrop.disabled = true;
  redrawCanvas();
  updateAreaUI();
}

function updateAreaUI() {
  const toggle = el("cropReuseArea");
  if (toggle) toggle.checked = rememberArea;

  const note = el("cropAreaNote");
  if (!note) return;
  const active = rememberArea && lastArea && !isLocked;
  note.style.display = active ? "inline-flex" : "none";
  if (active) {
    const pct = (n) => Math.round(n * 100);
    const label = el("cropAreaNoteText");
    if (label) {
      label.textContent =
        `Reusing your last crop area (${pct(lastArea.w)}% × ${pct(lastArea.h)}% of the image)`;
    }
  }
}

async function loadCropAreaSettings() {
  const on = await settingGet(AREA_ON_KEY, null).catch(() => null);
  rememberArea = on === null ? true : on === true;
  const area = await settingGet(AREA_KEY, null).catch(() => null);
  lastArea = (area && typeof area.w === "number" && area.w > 0 && area.h > 0) ? area : null;
  updateAreaUI();
}

function getTransformedDimensions() {
  if (!originalImage) return { width: 0, height: 0 };
  const isRotated90 = rotation === 90 || rotation === 270;
  return {
    width: isRotated90 ? originalImage.naturalHeight : originalImage.naturalWidth,
    height: isRotated90 ? originalImage.naturalWidth : originalImage.naturalHeight
  };
}

function redrawCanvas() {
  if (!originalImage || !canvas || !ctx) return;
  
  const dims = getTransformedDimensions();
  const maxWidth = window.innerWidth * 0.80;
  const maxHeight = window.innerHeight * 0.50;
  
  displayScale = Math.min(1, maxWidth / dims.width, maxHeight / dims.height) * zoomLevel;
  
  canvas.width = Math.round(dims.width * displayScale);
  canvas.height = Math.round(dims.height * displayScale);
  // The overlay must track the image canvas exactly, or the selection
  // rectangle drifts from the pixels it is selecting. Setting width/height
  // also clears it, which is what we want on a transform.
  if (overlay) {
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width = canvas.width + "px";
    overlay.style.height = canvas.height + "px";
  }
  labelCache = { text: null, width: 0 };
  
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  
  const isRotated90 = rotation === 90 || rotation === 270;
  const drawWidth = isRotated90 ? canvas.height : canvas.width;
  const drawHeight = isRotated90 ? canvas.width : canvas.height;
  
  ctx.drawImage(originalImage, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
  
  // Clear selection when transforming (unless locked)
  if (!isLocked) {
    selection = null;
    const btnCrop = el("btnCropConfirm");
    if (btnCrop) btnCrop.disabled = true;
    // A remembered area is expressed in fractions, so it survives a zoom or a
    // rotate — put it straight back. Dropping it here would mean reselecting
    // after every transform, which is the annoyance the feature exists to
    // remove (#77).
    applyRememberedArea();
  } else {
    // Recalculate locked selection for new canvas size
    applyLockedSize();
  }
}

function rotateImage() {
  rotation = (rotation + 90) % 360;
  redrawCanvas();
  startMarchingAnts();
}

function setZoom(level) {
  zoomLevel = level;
  updateZoomButtons();
  redrawCanvas();
  startMarchingAnts();
}

function updateZoomButtons() {
  const zoomBtns = document.querySelectorAll("[data-zoom]");
  zoomBtns.forEach(btn => {
    btn.classList.toggle("active", parseFloat(btn.dataset.zoom) === zoomLevel);
  });
}

function updateCropInfo() {
  const cropTitle = el("cropTitle");
  const cropMeta = el("cropMeta");
  
  if (cropTitle) cropTitle.textContent = currentFile?.name || "Image";
  
  if (cropMeta && currentFile) {
    let width, height;
    if (originalImage) {
      const dims = getTransformedDimensions();
      width = dims.width;
      height = dims.height;
    } else if (currentFile.imageMediaMetadata) {
      width = currentFile.imageMediaMetadata.width;
      height = currentFile.imageMediaMetadata.height;
    }
    
    const dimsStr = width && height ? `Resolution: ${width} × ${height} px` : "Resolution: loading...";
    const sizeStr = `Size: ${bytesToHuman(currentFile.size || 0)}`;
    cropMeta.textContent = `${dimsStr} | ${sizeStr}`;
  }
}

function updateNavButtons() {
  const btnPrev = el("btnCropPrev");
  const btnNext = el("btnCropNext");
  const navInfo = el("cropNavInfo");
  
  let totalImages = 0;
  let currentPosition = 0;
  
  for (let i = 0; i < allGroups.length; i++) {
    if (i < currentGroupIndex) {
      currentPosition += allGroups[i].length;
    } else if (i === currentGroupIndex) {
      currentPosition += currentIndexInGroup + 1;
    }
    totalImages += allGroups[i].length;
  }
  
  const canPrev = currentGroupIndex > 0 || currentIndexInGroup > 0;
  const canNext = currentGroupIndex < allGroups.length - 1 || currentIndexInGroup < currentGroup.length - 1;
  
  if (btnPrev) btnPrev.style.display = canPrev ? "inline-block" : "none";
  if (btnNext) btnNext.style.display = canNext ? "inline-block" : "none";
  if (navInfo) navInfo.textContent = `Image ${currentPosition} of ${totalImages}`;
}

function navigatePrev() {
  stopMarchingAnts();
  cleanupDragListeners();
  selection = null;
  isSelecting = false;
  isDragging = false;
  rotation = 0;
  zoomLevel = 1;
  updateZoomButtons();
  
  if (currentIndexInGroup > 0) {
    currentIndexInGroup--;
    currentFile = currentGroup[currentIndexInGroup];
  } else if (currentGroupIndex > 0) {
    currentGroupIndex--;
    currentGroup = allGroups[currentGroupIndex];
    currentIndexInGroup = currentGroup.length - 1;
    currentFile = currentGroup[currentIndexInGroup];
  } else {
    return;
  }
  
  loadImageForCrop(currentFile).then(() => {
    if (isLocked) applyLockedSize();
  });
  updateNavButtons();
  updateCropInfo();
  startMarchingAnts();
}

function navigateNext() {
  stopMarchingAnts();
  cleanupDragListeners();
  selection = null;
  isSelecting = false;
  isDragging = false;
  rotation = 0;
  zoomLevel = 1;
  updateZoomButtons();
  
  if (currentIndexInGroup < currentGroup.length - 1) {
    currentIndexInGroup++;
    currentFile = currentGroup[currentIndexInGroup];
  } else if (currentGroupIndex < allGroups.length - 1) {
    currentGroupIndex++;
    currentGroup = allGroups[currentGroupIndex];
    currentIndexInGroup = 0;
    currentFile = currentGroup[currentIndexInGroup];
  } else {
    return;
  }
  
  loadImageForCrop(currentFile).then(() => {
    if (isLocked) applyLockedSize();
  });
  updateNavButtons();
  updateCropInfo();
  startMarchingAnts();
}

function getCanvasPosition(e) {
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  let clientX, clientY;
  
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else if (e.changedTouches && e.changedTouches.length > 0) {
    clientX = e.changedTouches[0].clientX;
    clientY = e.changedTouches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }
  
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isInsideSelection(x, y) {
  if (!selection) return false;
  return x >= selection.x && x <= selection.x + selection.width &&
         y >= selection.y && y <= selection.y + selection.height;
}

function handleMouseDown(e) {
  if (!canvas) return;
  e.preventDefault();
  
  const pos = getCanvasPosition(e);
  
  if (isLocked && selection && isInsideSelection(pos.x, pos.y)) {
    // Start dragging the locked selection
    isDragging = true;
    isSelecting = false;
    dragOffsetX = pos.x - selection.x;
    dragOffsetY = pos.y - selection.y;
  } else if (isLocked) {
    // Create new locked selection at click position
    isDragging = true;
    isSelecting = false;
    selection = {
      x: clamp(pos.x - lockedWidth / 2, 0, canvas.width - lockedWidth),
      y: clamp(pos.y - lockedHeight / 2, 0, canvas.height - lockedHeight),
      width: lockedWidth,
      height: lockedHeight
    };
    dragOffsetX = lockedWidth / 2;
    dragOffsetY = lockedHeight / 2;
    updateCropButton();
  } else {
    // Free selection mode
    startX = clamp(pos.x, 0, canvas.width);
    startY = clamp(pos.y, 0, canvas.height);
    isSelecting = true;
    isDragging = false;
    selection = null;
  }
  
  boundMouseMove = handleMouseMove.bind(this);
  boundMouseUp = handleMouseUp.bind(this);
  document.addEventListener("mousemove", boundMouseMove);
  document.addEventListener("mouseup", boundMouseUp);
}

function handleTouchStart(e) {
  if (!canvas) return;
  e.preventDefault();
  
  const pos = getCanvasPosition(e);
  
  if (isLocked && selection && isInsideSelection(pos.x, pos.y)) {
    isDragging = true;
    isSelecting = false;
    dragOffsetX = pos.x - selection.x;
    dragOffsetY = pos.y - selection.y;
  } else if (isLocked) {
    isDragging = true;
    isSelecting = false;
    selection = {
      x: clamp(pos.x - lockedWidth / 2, 0, canvas.width - lockedWidth),
      y: clamp(pos.y - lockedHeight / 2, 0, canvas.height - lockedHeight),
      width: lockedWidth,
      height: lockedHeight
    };
    dragOffsetX = lockedWidth / 2;
    dragOffsetY = lockedHeight / 2;
    updateCropButton();
  } else {
    startX = clamp(pos.x, 0, canvas.width);
    startY = clamp(pos.y, 0, canvas.height);
    isSelecting = true;
    isDragging = false;
    selection = null;
  }
  
  document.addEventListener("touchmove", handleTouchMove, { passive: false });
  document.addEventListener("touchend", handleTouchEnd);
  document.addEventListener("touchcancel", handleTouchEnd);
}

function handleMouseMove(e) {
  if (!canvas) return;
  e.preventDefault();
  
  const pos = getCanvasPosition(e);
  
  if (isDragging && isLocked && selection) {
    // Move the locked selection
    selection.x = clamp(pos.x - dragOffsetX, 0, canvas.width - selection.width);
    selection.y = clamp(pos.y - dragOffsetY, 0, canvas.height - selection.height);
  } else if (isSelecting) {
    updateSelection(pos.x, pos.y);
  }
}

function handleTouchMove(e) {
  if (!canvas) return;
  e.preventDefault();
  
  const pos = getCanvasPosition(e);
  
  if (isDragging && isLocked && selection) {
    selection.x = clamp(pos.x - dragOffsetX, 0, canvas.width - selection.width);
    selection.y = clamp(pos.y - dragOffsetY, 0, canvas.height - selection.height);
  } else if (isSelecting) {
    updateSelection(pos.x, pos.y);
  }
}

function updateSelection(currentX, currentY) {
  currentX = clamp(currentX, 0, canvas.width);
  currentY = clamp(currentY, 0, canvas.height);
  
  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);
  
  selection = { x, y, width, height };
  updateCropButton();
}

function handleMouseUp(e) {
  isSelecting = false;
  isDragging = false;
  cleanupDragListeners();
}

function handleTouchEnd(e) {
  isSelecting = false;
  isDragging = false;
  document.removeEventListener("touchmove", handleTouchMove);
  document.removeEventListener("touchend", handleTouchEnd);
  document.removeEventListener("touchcancel", handleTouchEnd);
}

function cleanupDragListeners() {
  if (boundMouseMove) {
    document.removeEventListener("mousemove", boundMouseMove);
    boundMouseMove = null;
  }
  if (boundMouseUp) {
    document.removeEventListener("mouseup", boundMouseUp);
    boundMouseUp = null;
  }
}

/**
 * Paint the selection overlay: dim mask, marching ants, size label.
 *
 * Everything here lives on the OVERLAY canvas (#118). It used to live in the
 * animation loop alongside a full `drawImage` of the source, so a 24 MP
 * photograph was rescaled to the canvas 60 times a second for as long as the
 * crop modal was open -- whether or not anything was moving, and whether or
 * not there was a selection to animate, because the drawImage sat OUTSIDE the
 * `if (selection)` guard. redrawCanvas() already did that same work correctly,
 * once per transform.
 */
function drawOverlay() {
  if (!overlay || !octx || !canvas) return;

  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (!selection || selection.width <= 0 || selection.height <= 0) {
    if (canvas.dataset.selection) delete canvas.dataset.selection;
    return;
  }

  // Dim everything outside the selection.
  octx.fillStyle = "rgba(0, 0, 0, 0.5)";
  octx.fillRect(0, 0, overlay.width, selection.y);
  octx.fillRect(0, selection.y + selection.height, overlay.width, overlay.height - selection.y - selection.height);
  octx.fillRect(0, selection.y, selection.x, selection.height);
  octx.fillRect(selection.x + selection.width, selection.y, overlay.width - selection.x - selection.width, selection.height);

  // Marching ants: white dashes with black in the gaps, so the border reads
  // against both a light and a dark photograph.
  octx.save();
  octx.lineWidth = 1;
  octx.setLineDash([6, 6]);
  octx.strokeStyle = "#fff";
  octx.lineDashOffset = -marchingAntsOffset;
  octx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.width - 1, selection.height - 1);
  octx.strokeStyle = "#000";
  octx.lineDashOffset = -marchingAntsOffset + 6;
  octx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.width - 1, selection.height - 1);
  octx.restore();

  // The selection size, in the SOURCE image's pixels rather than the canvas's.
  const dims = getTransformedDimensions();
  const scaleX = dims.width / canvas.width;
  const scaleY = dims.height / canvas.height;
  const actualWidth = Math.round(selection.width * scaleX);
  const actualHeight = Math.round(selection.height * scaleY);
  const fullLabel = `${actualWidth} × ${actualHeight}` + (isLocked ? " 🔒" : "");

  // Mirror the selection onto the element, changed-only. Canvas pixels are not
  // inspectable, so this is what makes the current rectangle readable for
  // tools/crop-area.mjs and for anyone debugging -- the same way the sliders
  // expose actualValue. It lives here rather than in the animation loop so it
  // is written when the selection CHANGES, not only while an animation runs.
  const selKey = `${Math.round(selection.x)},${Math.round(selection.y)},` +
                 `${Math.round(selection.width)},${Math.round(selection.height)}`;
  if (canvas.dataset.selection !== selKey) canvas.dataset.selection = selKey;

  octx.font = "bold 13px system-ui, sans-serif";
  // measureText is the one genuinely costly call left in the frame, and the
  // label only changes when the selection does.
  if (labelCache.text !== fullLabel) {
    labelCache = { text: fullLabel, width: octx.measureText(fullLabel).width };
  }

  const labelPadding = 6;
  const labelHeight = 20;
  let labelX = selection.x + 4;
  let labelY = selection.y + 4;
  if (selection.height < 30) {
    labelY = selection.y - labelHeight - 4;
    if (labelY < 0) labelY = selection.y + selection.height + 4;
  }

  octx.fillStyle = "rgba(0, 0, 0, 0.75)";
  octx.fillRect(labelX, labelY, labelCache.width + labelPadding * 2, labelHeight);
  octx.fillStyle = "#fff";
  octx.fillText(fullLabel, labelX + labelPadding, labelY + 15);
}

/**
 * Advance the ants.
 *
 * The frame is now the overlay only. When there is no selection there is
 * nothing to animate, so the frame clears the overlay once and then does no
 * work at all until a selection appears -- rather than stopping the loop,
 * which would need every one of the twenty-odd places that assign `selection`
 * to remember to restart it, and a missed one leaves a stale rectangle painted
 * over the image.
 */
function startMarchingAnts() {
  stopMarchingAnts();

  function animate() {
    if (!canvas || !ctx || !originalImage) { animationId = null; return; }

    if (selection && selection.width > 0 && selection.height > 0) {
      marchingAntsOffset = (marchingAntsOffset + 0.3) % 12;
      drawOverlay();
      overlayNeedsClear = true;
    } else if (overlayNeedsClear) {
      drawOverlay();            // clears, and drops the dataset mirror
      overlayNeedsClear = false;
    }

    animationId = requestAnimationFrame(animate);
  }

  animate();
}

/**
 * A seam for tools/crop-frame-cost.mjs.
 *
 * openCropModal() downloads the file from Drive, so the canvas code cannot be
 * reached in a harness without a signed-in account -- which is why the
 * expensive animation loop went unmeasured for as long as it did. One grouped
 * export rather than six, to keep the surface honest about being a test hook.
 */
export const __test = {
  /** Mount an arbitrary drawable (an <img>, or a canvas standing in for a big photo). */
  mount(image) {
    canvas = el("cropCanvas");
    ctx = canvas.getContext("2d");
    overlay = el("cropOverlay");
    octx = overlay ? overlay.getContext("2d") : null;
    originalImage = image;
    rotation = 0;
    zoomLevel = 1;
    selection = null;
    redrawCanvas();
  },
  setSelection(s) { selection = s; },
  get selection() { return selection; },
  drawOverlay,
  redrawCanvas,
  startAnts: startMarchingAnts,
  stopAnts: stopMarchingAnts,
};

function stopMarchingAnts() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  overlayNeedsClear = false;
}

async function handleCropDelete() {
  if (!currentFile) return;
  
  if (!await confirmAction({
    title: "Move to Trash?",
    message: "This file will be moved to Google Drive Trash.",
    confirmLabel: "Move to Trash",
    note: UNDO_NOTE,
    files: [currentFile],
  })) return;
  
  const btnDelete = el("btnCropDelete");
  if (btnDelete) {
    btnDelete.disabled = true;
    btnDelete.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
  }
  
  try {
    const result = await batchTrash([currentFile.id]);
    if (result.success.includes(currentFile.id)) {
      pushUndoDeleteBatch([currentFile]);
      showTrashedToast(1, () => undoLastDelete());
      window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: [currentFile.id] } }));
      
      // Navigate to next image
      refreshGroups();
      
      // Remove file from current group
      currentGroup = currentGroup.filter(f => f.id !== currentFile.id);
      if (currentIndexInGroup >= currentGroup.length) currentIndexInGroup = Math.max(0, currentGroup.length - 1);
      
      if (currentGroup.length > 0) {
        currentFile = currentGroup[currentIndexInGroup];
        await loadImageForCrop(currentFile);
        if (isLocked) applyLockedSize();
        updateNavButtons();
        updateCropInfo();
        startMarchingAnts();
      } else {
        moveToNextAvailableImage();
      }
    } else {
      throw new Error("Trash operation failed");
    }
  } catch (err) {
    showToast("Delete failed: " + (err?.message || err), "error");
  } finally {
    if (btnDelete) {
      btnDelete.disabled = false;
      btnDelete.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
    }
  }
}

/**
 * Choose a canvas-encodable MIME type, and the extension that goes with it.
 *
 * Browsers encode PNG, JPEG and WebP. Anything else must be re-encoded as one
 * of those, so pick deliberately rather than letting toBlob fall back silently:
 * lossless sources become PNG, everything else JPEG.
 */
function chooseEncoding(sourceMime, sourceName) {
  const mime = (sourceMime || "").toLowerCase();
  const ext = (sourceName || "").toLowerCase().slice((sourceName || "").lastIndexOf("."));

  if (mime === "image/png" || ext === ".png") return { mime: "image/png", ext: ".png" };
  if (mime === "image/webp" || ext === ".webp") return { mime: "image/webp", ext: ".webp" };
  if (mime === "image/jpeg" || ext === ".jpg" || ext === ".jpeg") return { mime: "image/jpeg", ext: ".jpg" };

  // Lossless or unknown sources (PNG-like, BMP, TIFF, PSD…) keep detail as PNG.
  if (mime === "image/bmp" || mime === "image/gif" || mime === "image/tiff" || !mime) {
    return { mime: "image/png", ext: ".png" };
  }
  return { mime: "image/jpeg", ext: ".jpg" };
}

/** "photo.heic" + ".jpg" -> "photo (cropped).jpg" */
function croppedFileName(originalName, ext) {
  const name = originalName || "image";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem} (cropped)${ext}`;
}

/** Clear the crop UI state and refresh the group list after a save. */
function resetAfterCrop() {
  rotation = 0;
  zoomLevel = 1;
  updateZoomButtons();
  selection = null;
  refreshGroups();
}

async function performCrop() {
  if (!selection || !originalImage || !currentFile) {
    showToast("No selection made", "error");
    return;
  }
  
  if (selection.width < 10 || selection.height < 10) {
    showToast("Selection too small", "error");
    return;
  }
  
  const btnCrop = el("btnCropConfirm");
  const btnCancel = el("btnCropCancel");
  
  if (btnCrop) {
    btnCrop.disabled = true;
    btnCrop.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cropping...';
  }
  if (btnCancel) btnCancel.disabled = true;
  
  try {
    // Create temp canvas with rotation
    const dims = getTransformedDimensions();
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = dims.width;
    tempCanvas.height = dims.height;
    const tempCtx = tempCanvas.getContext("2d");
    
    tempCtx.save();
    tempCtx.translate(dims.width / 2, dims.height / 2);
    tempCtx.rotate((rotation * Math.PI) / 180);
    
    const isRotated90 = rotation === 90 || rotation === 270;
    const drawWidth = isRotated90 ? dims.height : dims.width;
    const drawHeight = isRotated90 ? dims.width : dims.height;
    
    tempCtx.drawImage(originalImage, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    tempCtx.restore();
    
    // Calculate crop coordinates
    const scaleX = dims.width / canvas.width;
    const scaleY = dims.height / canvas.height;
    const cropX = Math.round(selection.x * scaleX);
    const cropY = Math.round(selection.y * scaleY);
    const cropWidth = Math.round(selection.width * scaleX);
    const cropHeight = Math.round(selection.height * scaleY);
    
    // Create cropped canvas
    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.width = cropWidth;
    croppedCanvas.height = cropHeight;
    const croppedCtx = croppedCanvas.getContext("2d");
    
    croppedCtx.drawImage(tempCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    
    // Pick an encoder the canvas can actually honour.
    //
    // toBlob silently falls back to image/png for any type the browser cannot
    // encode, and browsers encode only PNG, JPEG and WebP. Passing the
    // original's MIME straight through meant a file Drive typed image/tiff,
    // image/heic or application/octet-stream was uploaded as PNG bytes under
    // the original's name AND the original's declared MIME — extension,
    // declared type and actual bytes all disagreeing.
    // Remember this rectangle for the next image before anything else can reset
    // the selection.
    rememberCurrentArea();

    const { mime: encodeMime, ext: encodeExt } = chooseEncoding(currentFile.mimeType, currentFile.name);
    const quality = encodeMime === "image/jpeg" ? 0.92 : undefined;

    const blob = await new Promise(resolve => croppedCanvas.toBlob(resolve, encodeMime, quality));
    if (!blob) throw new Error("The browser could not encode the cropped image");

    // Trust the blob, not what we asked for: if the browser fell back anyway,
    // name and declare what we actually got.
    const actualMime = blob.type || encodeMime;
    const actualExt = actualMime === "image/png" ? ".png"
                    : actualMime === "image/webp" ? ".webp"
                    : actualMime === "image/jpeg" ? ".jpg"
                    : encodeExt;

    const parentId = currentFile.parents?.[0];
    if (!parentId) throw new Error("Cannot determine parent folder");

    // Save alongside the original rather than shadowing it. The crop is a
    // canvas re-encode: EXIF, ICC profile, GPS, capture date and orientation
    // are all gone. Writing it under the original's exact name and then
    // trashing the original made that loss silent and unrecoverable.
    const newName = croppedFileName(currentFile.name, actualExt);

    showToast("Uploading cropped image...", "info", 2000);
    const uploadedFile = await uploadFile(blob, newName, parentId, actualMime);

    if (!uploadedFile || !uploadedFile.id) throw new Error("Upload failed");
    
    // Trashing the original is now the user's call, and it is stated plainly
    // what the crop did and did not keep. This used to happen automatically,
    // with no warning that the replacement had lost every piece of metadata.
    const alsoTrash = await confirmAction({
      title: `Saved the crop as "${newName}"`,
      message: "Move the original to Google Drive Trash?",
      confirmLabel: "Move original to Trash",
      note: "The crop is a re-encode, so EXIF, colour profile, GPS and capture date are NOT carried over. " +
            "Keep the original if you need them. " + UNDO_NOTE,
      files: [currentFile],
    });

    if (!alsoTrash) {
      showToast(`Saved "${newName}". Original kept.`, "success", 4000);
      window.dispatchEvent(new CustomEvent("ddd:fileReplaced", { detail: { oldId: currentFile.id, newFile: uploadedFile } }));
      resetAfterCrop();
      return;
    }

    showToast("Moving original to trash...", "info", 1500);
    const trashResult = await batchTrash([currentFile.id]);
    
    if (trashResult.success.includes(currentFile.id)) {
      // The original is now in Trash. Record it so Undo can bring it back —
      // this path replaced a file with a re-encoded crop and left no way back.
      pushUndoDeleteBatch([currentFile]);
    } else {
      // Upload succeeded but the trash did not, so Drive now holds two files
      // with the same name in the same folder. Say so loudly: quietly creating
      // a duplicate is the exact outcome this app exists to prevent.
      showToast(
        "Cropped copy was uploaded, but the original could NOT be trashed — " +
        "both files are now in that folder.",
        "error",
        8000
      );
    }
    
    window.dispatchEvent(new CustomEvent("ddd:fileReplaced", { detail: { oldId: currentFile.id, newFile: uploadedFile } }));
    window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: [currentFile.id] } }));
    
    showToast("Image cropped and saved!", "success");

    resetAfterCrop();
    
    if (currentGroup.length > 1) {
      currentGroup = currentGroup.filter(f => f.id !== currentFile.id);
      if (currentIndexInGroup >= currentGroup.length) currentIndexInGroup = currentGroup.length - 1;
      if (currentGroup.length > 0) {
        currentFile = currentGroup[currentIndexInGroup];
        await loadImageForCrop(currentFile);
        if (isLocked) applyLockedSize();
        updateNavButtons();
        updateCropInfo();
        startMarchingAnts();
      } else {
        moveToNextAvailableImage();
      }
    } else {
      moveToNextAvailableImage();
    }
    
  } catch (err) {
    console.error("Crop failed:", err);
    showToast("Crop failed: " + (err.message || err), "error");
  } finally {
    if (btnCrop) {
      btnCrop.disabled = false;
      btnCrop.innerHTML = '<i class="fa-solid fa-crop"></i> Crop';
    }
    if (btnCancel) btnCancel.disabled = false;
  }
}

function moveToNextAvailableImage() {
  refreshGroups();
  
  if (allGroups.length === 0) {
    showToast("All images processed!", "success");
    closeCropModal();
    return;
  }
  
  if (currentGroupIndex >= allGroups.length) currentGroupIndex = allGroups.length - 1;
  currentGroup = allGroups[currentGroupIndex];
  currentIndexInGroup = 0;
  
  if (currentGroup && currentGroup.length > 0) {
    currentFile = currentGroup[currentIndexInGroup];
    loadImageForCrop(currentFile).then(() => {
      if (isLocked) applyLockedSize();
    });
    updateNavButtons();
    updateCropInfo();
    startMarchingAnts();
  } else {
    showToast("No more images to edit", "info");
    closeCropReturnToCompare();
  }
}

function closeCropReturnToCompare() {
  closeCropModal();
  refreshGroups();
  
  if (allGroups.length > 0 && currentGroupIndex < allGroups.length) {
    const group = allGroups[currentGroupIndex];
    if (group && group.length >= 2) {
      // group[0] is whatever order the group happens to be in, so asserting it
      // is the keeper was simply wrong here. openCompare derives it.
      openCompare(group[0], group[1], {
        groupIndex: currentGroupIndex,
        allGroups: allGroups
      });
    }
  }
}

function closeCropModal() {
  const modal = el("cropModal");
  
  stopMarchingAnts();
  cleanupDragListeners();
  
  document.removeEventListener("touchmove", handleTouchMove);
  document.removeEventListener("touchend", handleTouchEnd);
  document.removeEventListener("touchcancel", handleTouchEnd);
  
  if (modal) {
    modal.style.display = "none";
    lockBodyScroll(false);
  }
  
  if (originalImage?.src) URL.revokeObjectURL(originalImage.src);
  originalImage = null;
  selection = null;
  currentFile = null;
  isSelecting = false;
  isDragging = false;
  rotation = 0;
  zoomLevel = 1;
  // Note: isLocked, rememberedWidth, rememberedHeight persist across sessions
}
