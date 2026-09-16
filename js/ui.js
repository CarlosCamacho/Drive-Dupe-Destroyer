/*
 * Drive Dupe Destroyer (DDD) — ui.js
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
// Added: ETA display, collecting spinner, folder picker bulk actions
// Security: user-controlled data escaped in all DOM insertions - v9.4
// UI utilities and state management
// Fixed selection count bug - now uses render module's selected Set

import { el, clamp, bytesToHuman, humanDuration, getCurrentYear, HELP_TEXT, APP_VERSION } from "./util.js";

// Re-exported so existing importers (exporter.js) keep working; the value
// itself is defined once in util.js.
export { APP_VERSION };

let statusPending = null;
let phasePending = null;
let progressPending = null;
let _etaStartTime = 0;
let _etaLastPct = 0;
let rafId = 0;

// Store a reference to the getSelectedCount function from render.js
let getSelectedCountFn = null;
let getRowCountFn = null;

/**
 * How many rows the result set HAS, which is not how many are painted.
 *
 * The table is virtualised, so `#resultsTbody tr` counts the visible window and
 * two spacers. renderGroups() clears the tbody, then calls refreshActionButtons
 * BEFORE the rAF that paints the first window -- so the DOM count was 0 exactly
 * when the toolbar was being enabled, and nothing called it again afterwards.
 * The selected count was moved off the DOM for this same reason; the row count
 * was left behind (#113).
 */
export function setRowCountProvider(fn) {
  getRowCountFn = fn;
}

let getSizeStatsFn = null;

/**
 * Where the reclaimable figure comes from (#114). Read from inside
 * refreshActionButtons rather than called separately, because the events that
 * change it -- selection, pinning a keeper, filtering, deleting -- are exactly
 * the events that already refresh the toolbar. One wiring point, no call site
 * left behind.
 */
export function setSizeStatsProvider(fn) {
  getSizeStatsFn = fn;
}

export function setSelectedCountProvider(fn) {
  getSelectedCountFn = fn;
}

export function uiInit() {
  try {
    const vEl = el("appVersion");
    if (vEl) vEl.textContent = "v" + APP_VERSION;
    document.title = `Drive Dupe Destroyer (DDD) v${APP_VERSION}`;
    
    // The header subtitle no longer carries the copyright — it moved into the
    // About modal. #copyrightYear is still honoured if present so older markup
    // keeps working; #aboutYear and #aboutVersion are the current targets.
    const yearEl = el("copyrightYear");
    if (yearEl) yearEl.textContent = getCurrentYear();

    const aboutYearEl = el("aboutYear");
    if (aboutYearEl) aboutYearEl.textContent = getCurrentYear();

    const aboutVerEl = el("aboutVersion");
    if (aboutVerEl) aboutVerEl.textContent = APP_VERSION;
    
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

// The most recent phase, kept so the progress bar can describe itself.
let lastPhase = "";

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
    lastPhase = phasePending;
    phasePending = null;
  }
  if (progressPending !== null && progressEl) {
    progressEl.value = progressPending;
    // A bare number tells a screen-reader user nothing about what is happening.
    // The phase is the useful half, and #status is a live region that announces
    // it -- this is for anyone who navigates to the bar itself (#104).
    progressEl.setAttribute(
      "aria-valuetext",
      `${Math.round(progressPending)}%${lastPhase ? " — " + lastPhase : ""}`
    );
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

/**
 * "Reclaimable: 8.3 GB — 1.2 GB selected" (#114).
 *
 * A floor, not a promise, when Drive reported no size for some files: saying
 * "at least" is the difference between a number the user can trust and one
 * that quietly over-promises.
 */
export function updateSizeStats() {
  const reclaimEl = el("statReclaimable");
  const selEl = el("statSelectedBytes");
  if (!reclaimEl && !selEl) return;

  const s = getSizeStatsFn ? getSizeStatsFn() : null;
  if (!s) {
    if (reclaimEl) reclaimEl.textContent = "—";
    if (selEl) { selEl.textContent = ""; selEl.title = ""; }
    return;
  }

  if (reclaimEl) {
    reclaimEl.title = s.unknown > 0
      ? `At least this much: Google Drive reported no size for ${s.unknown} duplicate(s), so they are not counted.`
      : "The total size of every duplicate that is not its group's keeper.";
    reclaimEl.textContent = s.reclaimable <= 0
      ? "—"
      : s.unknown > 0 ? `≥ ${bytesToHuman(s.reclaimable)}` : bytesToHuman(s.reclaimable);
  }
  if (selEl) {
    selEl.textContent = s.selected > 0 ? ` — ${bytesToHuman(s.selected)} selected` : "";
  }
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
  
  const rowCount = getRowCountFn
    ? getRowCountFn()
    : document.querySelectorAll('#resultsTbody tr:not(.virtualSpacer)').length;
  
  const btnSelectAll = el("btnSelectAll");
  const btnSelectNone = el("btnSelectNone");
  const btnTrashNow = el("btnTrashNow");
  const btnQueueSelected = el("btnQueueSelected");
  
  if (btnSelectAll) btnSelectAll.disabled = rowCount === 0;
  if (btnSelectNone) btnSelectNone.disabled = rowCount === 0;
  if (btnTrashNow) {
    btnTrashNow.disabled = checkedCount === 0;
    btnTrashNow.textContent = checkedCount > 0 ? `🗑️ Trash Selected (${checkedCount})` : '🗑️ Trash Selected';
  }
  // #113: the queue's bulk entry point. Tracks the same selection as Trash
  // Selected, because the two are the same decision -- now versus later.
  if (btnQueueSelected) {
    btnQueueSelected.disabled = checkedCount === 0;
    btnQueueSelected.textContent = checkedCount > 0 ? `📋 Queue Selected (${checkedCount})` : '📋 Queue Selected';
  }

  updateSizeStats();
}

export function clearResults() {
  const tb = el("resultsTbody");
  if (tb) tb.innerHTML = "";
  refreshActionButtons();
  showEmptyState(true);
}

/**
 * The panel where results go, when there are none.
 *
 * It used to say "No duplicates found" from the very first paint -- a verdict
 * on a scan that had never run, above a toolbar of ten disabled controls. That
 * is the first thing a new user reads (#103). Three states, because they are
 * three different situations:
 *
 *   before-signin : nothing has been attempted, and the next step is sign-in
 *   ready         : signed in, nothing scanned yet
 *   none-found    : a scan really did run and really did find nothing -- the
 *                   only state in which the old copy was true
 */
const EMPTY_STATES = {
  "before-signin": {
    icon: "🖼️",
    title: "Find duplicate photos in Google Drive",
    body: "Sign in to get started.",
    steps: ["Sign in with Google", "Choose the folders to search", "Start the scan"],
  },
  ready: {
    icon: "📂",
    title: "Ready to scan",
    body: "Choose the folders to search, then start the scan.",
    steps: null,
  },
  "none-found": {
    icon: "✅",
    title: "No duplicates found",
    body: "Nothing in the folders you scanned looks like a duplicate.",
    steps: null,
  },
};

let emptyStateKind = "before-signin";

/** @param {'before-signin'|'ready'|'none-found'} kind */
export function setEmptyState(kind, detail = "") {
  const s = EMPTY_STATES[kind] || EMPTY_STATES["before-signin"];
  emptyStateKind = kind;

  const icon = el("emptyIcon");
  const title = el("emptyTitle");
  const body = el("emptyBody");
  const steps = el("emptySteps");

  if (icon) icon.textContent = s.icon;
  if (title) title.textContent = s.title;
  // `detail` says what was actually searched, so "no duplicates" is a finding
  // rather than an assertion: "No duplicates among 4,812 images in 12 folders."
  if (body) body.textContent = detail || s.body;
  if (steps) {
    steps.hidden = !s.steps;
    if (s.steps) steps.innerHTML = s.steps.map((t) => `<li>${t}</li>`).join("");
  }
}

export function getEmptyStateKind() {
  return emptyStateKind;
}

export function showEmptyState(show) {
  const emptyState = el("emptyState");
  const resultsTable = el("resultsTable");

  if (emptyState) emptyState.style.display = show ? "flex" : "none";
  if (resultsTable) resultsTable.style.display = show ? "none" : "table";
}

export function setSignedInUi(on, clientId = '') {
  // The first-run state is only true before sign-in (#103).
  if (getEmptyStateKind() !== "none-found" || !on) {
    setEmptyState(on ? "ready" : "before-signin");
  }
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

// Toasts stack instead of replacing each other.
//
// There used to be exactly one slot and a new message removed whatever was in
// it. That is not a rare collision -- the trash path emits two messages back to
// back BY DESIGN ("Trashed 40 file(s)" then "Failed to trash 3"), so on a
// partially failed run the user saw only the failure and never the count that
// succeeded or the mention of Undo (#107).
const TOAST_MAX = 3;

function toastContainer() {
  let c = document.getElementById("toastStack");
  if (!c) {
    c = document.createElement("div");
    c.id = "toastStack";
    c.className = "toastStack";
    // Errors interrupt; everything else waits its turn.
    c.setAttribute("aria-live", "polite");
    c.setAttribute("aria-atomic", "false");
    document.body.appendChild(c);
  }
  return c;
}

function dismissToast(toast) {
  if (!toast || toast.dataset.leaving) return;
  toast.dataset.leaving = "1";
  toast.classList.remove("show");
  setTimeout(() => toast.remove(), 300);
}

/**
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 * @param {number} duration  ms; errors default to persisting until dismissed
 * @param {{label: string, onClick: function}} [action] optional inline action
 */
export function showToast(message, type = 'info', duration = null, action = null) {
  const container = toastContainer();

  // Collapse an identical message rather than stacking duplicates.
  const twin = [...container.children].find(
    (t) => t.dataset.message === message && !t.dataset.leaving
  );
  if (twin) {
    const n = (Number(twin.dataset.count) || 1) + 1;
    twin.dataset.count = String(n);
    const badge = twin.querySelector(".toastCount");
    if (badge) { badge.textContent = `×${n}`; badge.hidden = false; }
    return twin;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.dataset.message = message;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  const text = document.createElement("span");
  text.className = "toastText";
  text.textContent = message;
  toast.appendChild(text);

  const count = document.createElement("span");
  count.className = "toastCount";
  count.hidden = true;
  toast.appendChild(count);

  if (action?.label && typeof action.onClick === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toastAction";
    btn.textContent = action.label;
    btn.onclick = () => { dismissToast(toast); action.onClick(); };
    toast.appendChild(btn);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toastClose";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  close.onclick = () => dismissToast(toast);
  toast.appendChild(close);

  container.appendChild(toast);
  // Evict over the cap by walking a SNAPSHOT of the live toasts, not by
  // re-reading container.children. dismissToast only marks a toast and removes
  // it 300ms later, so `while (children.length > MAX) dismissToast(first)` never
  // terminates -- the first child is still a child on the next iteration, and
  // the second dismissToast returns early because it is already leaving. That
  // spun the renderer until Chromium killed the tab, which is how it showed up:
  // as tools/trash-partial.mjs losing the page, not as a visible UI bug.
  const live = [...container.children].filter((t) => !t.dataset.leaving);
  while (live.length > TOAST_MAX) dismissToast(live.shift());

  requestAnimationFrame(() => toast.classList.add('show'));

  // An error stays until the user deals with it; a confirmation does not need
  // to. A toast carrying an action gets longer, since it has to be reachable.
  const ms = duration != null ? duration
    : type === "error" ? 0
    : action ? 10000
    : 4000;
  if (ms > 0) setTimeout(() => dismissToast(toast), ms);

  return toast;
}

/**
 * Report a deletion with the way back attached.
 *
 * Every trash path used to say "— use Undo to restore" in prose, in a toast
 * that vanished in 3 seconds, against an undo window of 30 MINUTES (#106). The
 * action belongs in the message, not a description of where to find it.
 *
 * `onUndo` is injected rather than imported so ui.js stays free of a dependency
 * on undo.js, which imports ui.js for showToast.
 */
export function showTrashedToast(count, onUndo) {
  const what = count === 1 ? "1 file" : `${count.toLocaleString()} files`;
  return showToast(
    `Moved ${what} to Google Drive Trash`,
    "success",
    null,
    typeof onUndo === "function" ? { label: "Undo", onClick: onUndo } : null
  );
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
