/*
 * Drive Dupe Destroyer (DDD) v14.0 — ui.js
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
// Added: ETA display, collecting spinner, folder picker bulk actions
// Security: user-controlled data escaped in all DOM insertions - v9.4
// UI utilities and state management
// Fixed selection count bug - now uses render module's selected Set

import { el, clamp, bytesToHuman, humanDuration, getCurrentYear, HELP_TEXT } from "./util.js";

export const APP_VERSION = "14.0";

let statusPending = null;
let phasePending = null;
let progressPending = null;
let _etaStartTime = 0;
let _etaLastPct = 0;
let rafId = 0;

// Store a reference to the getSelectedCount function from render.js
let getSelectedCountFn = null;

export function setSelectedCountProvider(fn) {
  getSelectedCountFn = fn;
}

export function uiInit() {
  try {
    const vEl = el("appVersion");
    if (vEl) vEl.textContent = "v" + APP_VERSION;
    document.title = `Drive Dupe Destroyer (DDD) v${APP_VERSION}`;
    
    const yearEl = el("copyrightYear");
    if (yearEl) yearEl.textContent = getCurrentYear();
    
    // Initialize help tooltips
    initHelpTooltips();
  } catch (_) {}
}

function initHelpTooltips() {
  // Wire up existing help icons with data-help attributes
  const existingIcons = document.querySelectorAll('.helpIcon[data-help]');
  for (const icon of existingIcons) {
    const helpKey = icon.getAttribute('data-help');
    const text = HELP_TEXT[helpKey];
    if (!text) continue;
    
    // Skip if already has tooltip
    if (icon.querySelector('.helpTooltip')) continue;
    
    icon.setAttribute('tabindex', '0');
    icon.setAttribute('role', 'button');
    icon.setAttribute('aria-label', 'Help');
    
    const tooltip = document.createElement('div');
    tooltip.className = 'helpTooltip';
    tooltip.textContent = text;
    icon.appendChild(tooltip);
    
    // Show/hide on hover and focus
    icon.addEventListener('mouseenter', () => tooltip.classList.add('show'));
    icon.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
    icon.addEventListener('focus', () => tooltip.classList.add('show'));
    icon.addEventListener('blur', () => tooltip.classList.remove('show'));
  }
  
  // Also create help icons for any HELP_TEXT entries without existing icons
  for (const [id, text] of Object.entries(HELP_TEXT)) {
    const input = el(id);
    if (!input) continue;
    
    const row = input.closest('.formRow');
    if (!row) continue;
    
    const label = row.querySelector('label');
    if (!label) continue;
    
    // Check if help icon already exists
    if (label.querySelector('.helpIcon')) continue;
    
    const helpIcon = document.createElement('span');
    helpIcon.className = 'helpIcon';
    helpIcon.textContent = '?';
    helpIcon.setAttribute('tabindex', '0');
    helpIcon.setAttribute('role', 'button');
    helpIcon.setAttribute('aria-label', 'Help');
    
    const tooltip = document.createElement('div');
    tooltip.className = 'helpTooltip';
    tooltip.textContent = text;
    
    helpIcon.appendChild(tooltip);
    label.appendChild(helpIcon);
    
    // Show/hide on hover and focus
    helpIcon.addEventListener('mouseenter', () => tooltip.classList.add('show'));
    helpIcon.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
    helpIcon.addEventListener('focus', () => tooltip.classList.add('show'));
    helpIcon.addEventListener('blur', () => tooltip.classList.remove('show'));
  }
}

function flush() {
  rafId = 0;
  const statusEl = el("status");
  const phaseEl = el("phaseLine");
  const progressEl = el("progress");
  
  if (statusPending !== null && statusEl) {
    statusEl.textContent = statusPending;
    statusPending = null;
  }
  if (phasePending !== null && phaseEl) {
    phaseEl.textContent = "Phase: " + phasePending;
    phasePending = null;
  }
  if (progressPending !== null && progressEl) {
    progressEl.value = progressPending;
    progressPending = null;
  }
}

function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(flush);
}

export function setStatus(msg) {
  statusPending = msg;
  schedule();
}

// Show/hide the collecting files spinner (animated dots)
export function showCollectingSpinner(on) {
  const s = document.getElementById("collectingSpinner");
  if (s) s.style.display = on ? "inline-flex" : "none";
}

// Update ETA display based on progress percentage and elapsed time
export function updateEta(pct) {
  const etaEl = document.getElementById("etaLine");
  if (!etaEl) return;

  if (pct <= 2) {
    // Not enough data yet
    _etaStartTime = Date.now();
    _etaLastPct = pct;
    etaEl.style.display = "none";
    return;
  }

  const elapsed = (Date.now() - _etaStartTime) / 1000;
  if (elapsed < 3 || pct <= _etaLastPct) {
    etaEl.style.display = "none";
    return;
  }

  _etaLastPct = pct;
  const rate = pct / elapsed; // % per second
  const remaining = (100 - pct) / rate;

  let label;
  if (remaining < 10)       label = "< 10s";
  else if (remaining < 60)  label = `~${Math.round(remaining)}s`;
  else if (remaining < 3600) label = `~${Math.round(remaining / 60)}m`;
  else                       label = `~${Math.round(remaining / 3600)}h`;

  etaEl.textContent = `ETA: ${label}`;
  etaEl.style.display = "inline";
}

export function resetEta() {
  _etaStartTime = Date.now();
  _etaLastPct = 0;
  const etaEl = document.getElementById("etaLine");
  if (etaEl) { etaEl.textContent = ""; etaEl.style.display = "none"; }
}

export function setPhase(msg) {
  phasePending = msg;
  schedule();
}

export function setProgress(pct) {
  progressPending = clamp(pct, 0, 100);
  schedule();
}

export function showSpinner(on) {
  const spinner = el("spinner");
  if (spinner) spinner.style.display = on ? "inline-block" : "none";
}

export function updateStats({ groups = 0, files = 0, totalBytes = 0, cacheHit = null, durationMs = null }) {
  const statGroups = el("statGroups");
  const statFiles = el("statFiles");
  const statSize = el("statSize");
  const statCacheHit = el("statCacheHit");
  const statDuration = el("statDuration");
  
  if (statGroups) statGroups.textContent = String(groups);
  if (statFiles) statFiles.textContent = String(files);
  if (statSize) statSize.textContent = bytesToHuman(totalBytes);
  if (statCacheHit) statCacheHit.textContent = cacheHit == null ? "—" : `${Math.round(cacheHit * 100)}%`;
  if (statDuration) statDuration.textContent = durationMs == null ? "—" : humanDuration(durationMs);
}

export function updateFilterStats(groups, files, filter) {
  const filterStatsEl = el("filterStats");
  if (filterStatsEl) {
    if (filter === "all") {
      filterStatsEl.textContent = "";
    } else {
      filterStatsEl.textContent = `(${groups} groups, ${files} files)`;
    }
  }
}

export function refreshActionButtons() {
  // Use the render module's selected count instead of DOM checkbox count
  // This fixes the bug where virtual scrolling would reset the visible count
  let checkedCount = 0;
  
  if (getSelectedCountFn) {
    checkedCount = getSelectedCountFn();
  } else {
    // Fallback to DOM count if provider not set (shouldn't happen after init)
    checkedCount = document.querySelectorAll('#resultsTbody input[type=checkbox]:checked').length;
  }
  
  const rowCount = document.querySelectorAll('#resultsTbody tr:not(.virtualSpacer)').length;
  
  const btnSelectAll = el("btnSelectAll");
  const btnSelectNone = el("btnSelectNone");
  const btnTrashNow = el("btnTrashNow");
  
  if (btnSelectAll) btnSelectAll.disabled = rowCount === 0;
  if (btnSelectNone) btnSelectNone.disabled = rowCount === 0;
  if (btnTrashNow) {
    btnTrashNow.disabled = checkedCount === 0;
    btnTrashNow.textContent = checkedCount > 0 ? `🗑️ Trash Selected (${checkedCount})` : '🗑️ Trash Selected';
  }
}

export function clearResults() {
  const tb = el("resultsTbody");
  if (tb) tb.innerHTML = "";
  refreshActionButtons();
  showEmptyState(true);
}

export function showEmptyState(show) {
  const emptyState = el("emptyState");
  const resultsTable = el("resultsTable");
  
  if (emptyState) emptyState.style.display = show ? "flex" : "none";
  if (resultsTable) resultsTable.style.display = show ? "none" : "table";
}

export function setSignedInUi(on, clientId = '') {
  const btnAuth = el("btnAuth");
  const clientIdDisplay = el("clientIdDisplay");
  const btnScan = el("btnScan");
  const btnPickFolders = el("btnPickFolders");
  const btnStop = el("btnStop");
  const btnDbClear = el("btnDbClear");
  const btnDbExport = el("btnDbExport");
  const btnDbImport = el("btnDbImport");
  
  if (on) {
    if (btnAuth) {
      btnAuth.textContent = "Sign Out";
      btnAuth.classList.remove("btnBlue");
      btnAuth.classList.add("btnGhost");
    }
    
    if (clientIdDisplay && clientId) {
      const truncated = clientId.length > 24 
        ? clientId.substring(0, 10) + '…' + clientId.substring(clientId.length - 10)
        : clientId;
      clientIdDisplay.textContent = truncated;
      clientIdDisplay.title = clientId;
      clientIdDisplay.style.display = "inline-block";
    }
    
    if (btnScan) btnScan.disabled = false;
    if (btnPickFolders) btnPickFolders.disabled = false;
    if (btnDbClear) btnDbClear.disabled = false;
    if (btnDbExport) btnDbExport.disabled = false;
    if (btnDbImport) btnDbImport.disabled = false;
  } else {
    if (btnAuth) {
      btnAuth.textContent = "Sign In";
      btnAuth.classList.remove("btnGhost");
      btnAuth.classList.add("btnBlue");
    }
    
    if (clientIdDisplay) {
      clientIdDisplay.textContent = "";
      clientIdDisplay.style.display = "none";
    }
    
    if (btnScan) btnScan.disabled = true;
    if (btnPickFolders) btnPickFolders.disabled = true;
    if (btnStop) btnStop.disabled = true;
    if (btnDbClear) btnDbClear.disabled = true;
    if (btnDbExport) btnDbExport.disabled = true;
    if (btnDbImport) btnDbImport.disabled = true;

    clearResults();
    
    const status = el("status");
    const phaseLine = el("phaseLine");
    const etaLine = el("etaLine");
    const progress = el("progress");
    
    if (status) status.textContent = "Idle.";
    if (phaseLine) phaseLine.textContent = "Phase: —";
    if (etaLine) { etaLine.textContent = ""; etaLine.style.display = "none"; }
    if (progress) progress.value = 0;

    resetEta();
    showCollectingSpinner(false);
    showSpinner(false);
  }
}

export function setSearchSummary(recursive, maxItems, useDb) {
  const el_ = el("searchSummary");
  if (!el_) return;
  
  const parts = [];
  parts.push(`Recursive: ${recursive ? 'yes' : 'no'}`);
  parts.push(`Max: ${maxItems > 0 ? maxItems : '∞'}`);
  parts.push(`DB: ${useDb ? 'yes' : 'no'}`);
  
  el_.textContent = parts.join(' • ');
}

export function showToast(message, type = 'info', duration = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

export function lockBodyScroll(lock) {
  document.body.style.overflow = lock ? 'hidden' : '';
}

export function setScanningState(scanning) {
  const btnScan = el("btnScan");
  const btnStop = el("btnStop");
  
  if (btnScan) {
    btnScan.style.display = scanning ? "none" : "inline-flex";
  }
  if (btnStop) {
    btnStop.style.display = scanning ? "inline-flex" : "none";
    btnStop.disabled = false;
  }
}

// Error viewing functionality
let currentErrors = [];

export function setHashingErrors(errors) {
  currentErrors = errors || [];
  
  // Show/hide the View Errors button
  const btnViewErrors = el("btnViewErrors");
  if (btnViewErrors) {
    btnViewErrors.style.display = currentErrors.length > 0 ? "inline-flex" : "none";
  }
}

export function getHashingErrors() {
  return currentErrors;
}

export function showErrorModal() {
  const modal = el("errorModal");
  const errorList = el("errorList");
  const errorSummary = el("errorSummary");
  
  if (!modal || !errorList) return;
  
  errorList.innerHTML = "";
  
  if (currentErrors.length === 0) {
    errorSummary.textContent = "No errors recorded.";
    return;
  }
  
  errorSummary.textContent = `${currentErrors.length} file(s) could not be processed:`;
  
  for (const err of currentErrors) {
    const row = document.createElement("div");
    row.className = "errorRow";
    row.innerHTML = `
      <div class="errorInfo">
        <strong>${escapeHtml(err.fileName || "Unknown")}</strong>
        <div class="errorPath muted">${escapeHtml(err.fileId || "")}</div>
        <div class="errorReason">Error: ${escapeHtml(err.error || "Unknown error")}</div>
      </div>
      <div class="errorActions">
        <a href="https://drive.google.com/file/d/${err.fileId}/view" target="_blank" rel="noopener" class="btnGhost btnSmall">View</a>
      </div>
    `;
    errorList.appendChild(row);
  }
  
  modal.style.display = "flex";
  lockBodyScroll(true);
}

export function hideErrorModal() {
  const modal = el("errorModal");
  if (modal) modal.style.display = "none";
  lockBodyScroll(false);
}

export function wireErrorModal() {
  const btnClose = el("btnErrorClose");
  const btnCloseFooter = el("btnErrorCloseFooter");
  const btnViewErrors = el("btnViewErrors");
  const modal = el("errorModal");
  
  if (btnClose) btnClose.onclick = hideErrorModal;
  if (btnCloseFooter) btnCloseFooter.onclick = hideErrorModal;
  if (btnViewErrors) btnViewErrors.onclick = showErrorModal;
  
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) hideErrorModal();
    };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
