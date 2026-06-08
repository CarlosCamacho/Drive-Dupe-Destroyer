/*
 * Drive Dupe Destroyer (DDD) v14.0 — crop.js
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
import { lockBodyScroll, showToast } from "./ui.js";
import { batchTrash, uploadFile, getAccessToken } from "./drive.js";
import { openCompare } from "./compare.js";

let currentFile = null;
let currentGroup = [];
let currentIndexInGroup = 0;
let allGroups = [];
let currentGroupIndex = 0;
let originalImage = null;
let canvas = null;
let ctx = null;
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
  
  try {
    const token = await getAccessToken();
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    if (!response.ok) throw new Error("Failed to download image");
    
    const blob = await response.blob();
    const imageUrl = URL.createObjectURL(blob);
    
    originalImage = new Image();
    await new Promise((resolve, reject) => {
      originalImage.onload = resolve;
      originalImage.onerror = reject;
      originalImage.src = imageUrl;
    });
    
    updateCropInfo();
    redrawCanvas();
    
    if (cropLoading) cropLoading.style.display = "none";
    if (cropCanvas) cropCanvas.style.display = "block";
    
  } catch (err) {
    console.error("Failed to load image for crop:", err);
    showToast("Failed to load image: " + (err.message || err), "error");
    if (cropLoading) cropLoading.textContent = "Failed to load image";
  }
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

function startMarchingAnts() {
  stopMarchingAnts();
  
  function animate() {
    if (!canvas || !ctx || !originalImage) return;
    
    // Redraw canvas
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    
    const isRotated90 = rotation === 90 || rotation === 270;
    const drawWidth = isRotated90 ? canvas.height : canvas.width;
    const drawHeight = isRotated90 ? canvas.width : canvas.height;
    
    ctx.drawImage(originalImage, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
    
    if (selection && selection.width > 0 && selection.height > 0) {
      // Dim area outside selection
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fillRect(0, 0, canvas.width, selection.y);
      ctx.fillRect(0, selection.y + selection.height, canvas.width, canvas.height - selection.y - selection.height);
      ctx.fillRect(0, selection.y, selection.x, selection.height);
      ctx.fillRect(selection.x + selection.width, selection.y, canvas.width - selection.x - selection.width, selection.height);
      
      // Marching ants border
      ctx.save();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]);
      ctx.lineDashOffset = -marchingAntsOffset;
      ctx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.width - 1, selection.height - 1);
      
      ctx.strokeStyle = "#000";
      ctx.lineDashOffset = -marchingAntsOffset + 6;
      ctx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.width - 1, selection.height - 1);
      ctx.restore();
      
      // Show selection dimensions
      const dims = getTransformedDimensions();
      const scaleX = dims.width / canvas.width;
      const scaleY = dims.height / canvas.height;
      const actualWidth = Math.round(selection.width * scaleX);
      const actualHeight = Math.round(selection.height * scaleY);
      
      const labelText = `${actualWidth} × ${actualHeight}`;
      ctx.font = "bold 13px system-ui, sans-serif";
      const textWidth = ctx.measureText(labelText).width;
      const labelPadding = 6;
      const labelHeight = 20;
      
      let labelX = selection.x + 4;
      let labelY = selection.y + 4;
      
      if (selection.height < 30) {
        labelY = selection.y - labelHeight - 4;
        if (labelY < 0) labelY = selection.y + selection.height + 4;
      }
      
      // Show lock indicator if locked
      const lockIndicator = isLocked ? " 🔒" : "";
      const fullLabel = labelText + lockIndicator;
      const fullTextWidth = ctx.measureText(fullLabel).width;
      
      ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
      ctx.fillRect(labelX, labelY, fullTextWidth + labelPadding * 2, labelHeight);
      ctx.fillStyle = "#fff";
      ctx.fillText(fullLabel, labelX + labelPadding, labelY + 15);
    }
    
    marchingAntsOffset = (marchingAntsOffset + 0.3) % 12;
    animationId = requestAnimationFrame(animate);
  }
  
  animate();
}

function stopMarchingAnts() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

async function handleCropDelete() {
  if (!currentFile) return;
  
  if (!confirm(`Delete "${currentFile.name}"? This will move the file to trash.`)) return;
  
  const btnDelete = el("btnCropDelete");
  if (btnDelete) {
    btnDelete.disabled = true;
    btnDelete.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
  }
  
  try {
    const result = await batchTrash([currentFile.id]);
    if (result.success.includes(currentFile.id)) {
      showToast("File moved to trash", "success");
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
    
    const mimeType = currentFile.mimeType || "image/jpeg";
    const quality = mimeType === "image/jpeg" ? 0.92 : undefined;
    
    const blob = await new Promise(resolve => croppedCanvas.toBlob(resolve, mimeType, quality));
    
    const parentId = currentFile.parents?.[0];
    if (!parentId) throw new Error("Cannot determine parent folder");
    
    showToast("Uploading cropped image...", "info", 2000);
    const uploadedFile = await uploadFile(blob, currentFile.name, parentId, mimeType);
    
    if (!uploadedFile || !uploadedFile.id) throw new Error("Upload failed");
    
    showToast("Moving original to trash...", "info", 1500);
    const trashResult = await batchTrash([currentFile.id]);
    
    if (!trashResult.success.includes(currentFile.id)) {
      showToast("Warning: Original may not have been trashed", "error");
    }
    
    window.dispatchEvent(new CustomEvent("ddd:fileReplaced", { detail: { oldId: currentFile.id, newFile: uploadedFile } }));
    window.dispatchEvent(new CustomEvent("ddd:trashed", { detail: { ids: [currentFile.id] } }));
    
    showToast("Image cropped and saved!", "success");
    
    // Reset for next image
    rotation = 0;
    zoomLevel = 1;
    updateZoomButtons();
    selection = null;
    
    // Navigate to next image
    refreshGroups();
    
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
      openCompare(group[0], group[1], {
        leftIsKeep: true,
        rightIsKeep: false,
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

export function closeCrop() {
  closeCropModal();
}
