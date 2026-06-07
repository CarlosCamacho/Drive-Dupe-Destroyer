/*
 * Drive Dupe Destroyer (DDD) v14.0 — app.js
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
// Security-hardened: localStorage replaced with IndexedDB for all persistence
// Main application entry point

import { el } from "./util.js";
import { uiInit, setSignedInUi, setStatus, showEmptyState, setScanningState, showToast, wireErrorModal, setSelectedCountProvider } from "./ui.js";
import { wireAuth } from "./auth.js";
import { runScan, setupBackgroundDetection } from "./scan.js";
import { renderGroups, wireRenderControls, getSelectedCount, beginProgressive, pushProgressiveMatch, endProgressive } from "./render.js";
import { wireCompare } from "./compare.js";
import { wireCrop } from "./crop.js";
import { wireFolderPicker, getIncludedFolderIds, getIncludedFolders, getExclusions } from "./folderPicker.js";
import { wireKeyboard } from "./keyboard.js";
import { wireActions } from "./actions.js";
import { wireExport, setExportState } from "./exporter.js";
import { applyAllSecurityPolicies } from "./security.js";
import { settingGet, settingSet } from "./db.js";
import { initPersistentSettings } from "./settings.js";
import { toggleTelemetry } from "./telemetry.js";
import { undoLastDelete } from "./undo.js";
import { loadResumeState, clearResumeState, formatResumeDescription } from "./resume.js";
import { wireQueue } from "./queue.js";
import { dbClearImages, dbCountImages, dbExportImages, dbImportImages } from "./db.js";
import { releaseAllThumbBlobs } from "./hashing.js";

let abortCtrl = null;

// Slider value maps
const MAX_ITEMS_VALUES = [500, 1000, 2500, 5000, 10000, 15000, 0]; // 0 = infinity
const PAGE_SIZE_VALUES = [100, 250, 500, 750, 1000];

function wireSliders() {
  // Simple sliders
  const simpleSliders = [
    { id: "sensitivityLevel", displayId: "sensitivityVal" },
    { id: "hamThresh", displayId: "hamThreshVal" }
  ];
  
  for (const { id, displayId } of simpleSliders) {
    const slider = el(id);
    const display = el(displayId);
    
    if (slider && display) {
      slider.oninput = () => display.textContent = slider.value;
      display.textContent = slider.value;
    }
  }
  
  // Max Items slider (with infinity)
  const maxItemsSlider = el("maxItems");
  const maxItemsVal = el("maxItemsVal");
  if (maxItemsSlider && maxItemsVal) {
    const updateMaxItems = () => {
      const idx = parseInt(maxItemsSlider.value, 10);
      const val = MAX_ITEMS_VALUES[idx];
      maxItemsVal.textContent = val === 0 ? "∞" : val.toLocaleString();
      maxItemsSlider.dataset.actualValue = val;
    };
    maxItemsSlider.oninput = updateMaxItems;
    updateMaxItems();
  }
  
  // Page Size slider
  const pageSizeSlider = el("pageSize");
  const pageSizeVal = el("pageSizeVal");
  if (pageSizeSlider && pageSizeVal) {
    const updatePageSize = () => {
      const idx = parseInt(pageSizeSlider.value, 10);
      const val = PAGE_SIZE_VALUES[idx];
      pageSizeVal.textContent = val;
      pageSizeSlider.dataset.actualValue = val;
    };
    pageSizeSlider.oninput = updatePageSize;
    updatePageSize();
  }
}

async function wireThemeToggle() {
  const btn = el("btnTheme");
  if (!btn) return;
  // Use IndexedDB — not localStorage — for all persistent settings
  const saved = await settingGet("destroyer_app_theme", "dark").catch(() => "dark");
  document.documentElement.dataset.theme = saved;
  btn.textContent = saved === "dark" ? "☀️" : "🌙";
  btn.onclick = async () => {
    const current = document.documentElement.dataset.theme || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    await settingSet("destroyer_app_theme", next).catch(() => {});
    btn.textContent = next === "dark" ? "☀️" : "🌙";
  };
}

function wireMatchMode() {
  const matchExact = el("matchExact");
  const matchSimilar = el("matchSimilar");
  const similarOptions = el("similarOptions");
  
  const update = () => {
    const mode = document.querySelector('input[name="matchMode"]:checked')?.value;
    if (similarOptions) {
      similarOptions.style.display = mode === "similar" ? "block" : "none";
    }
  };
  
  if (matchExact) matchExact.onchange = update;
  if (matchSimilar) matchSimilar.onchange = update;
  
  update();
}

function wireKeepRule() {
  const keepRule = el("keepRule");
  const folderPriorityRow = el("folderPriorityRow");
  
  if (keepRule && folderPriorityRow) {
    keepRule.onchange = () => {
      folderPriorityRow.style.display = keepRule.value === "folderPriority" ? "block" : "none";
    };
    folderPriorityRow.style.display = keepRule.value === "folderPriority" ? "block" : "none";
  }
}

function wireScanControls() {
  const btnScan = el("btnScan");
  const btnStop = el("btnStop");
  
  if (btnScan) {
    btnScan.onclick = async () => {
      const folderIds = getIncludedFolderIds();
      
      if (folderIds.length === 0) {
        showToast("Please select at least one folder to scan", "info");
        const btnPickFolders = el("btnPickFolders");
        if (btnPickFolders) btnPickFolders.click();
        return;
      }
      
      abortCtrl = new AbortController();
      
      try {
        await runScan({
          folderIds,
          folders: getIncludedFolders(), // For scan history tracking
          exclusions: getExclusions(),
          signal: abortCtrl.signal,
          renderCb: async (data) => {
            // Final, authoritative render (includes folder paths + final sort).
            endProgressive();
            setExportState({ groups: data.groups, pathMap: data.pathMap, idToEntry: data.idToEntry });
            await renderGroups(data);
          },
          onProgressiveMatch: (evt) => {
            // Live results: show matches the moment they're found and let the
            // user open / Compare / select / delete them while the scan runs.
            if (!evt) return;
            if (evt.type === "start") {
              const dhashSize = parseInt(el("dhashSize")?.value || "12", 10);
              const withVariants = el("checkVariants")?.checked || el("checkVariants")?.value === "yes";
              beginProgressive({
                idToEntry: evt.idToEntry || undefined,
                keepRule: el("keepRule")?.value || "hires",
                folderPriority: el("folderPriority")?.value || "",
                bitsCount: dhashSize * dhashSize,
                withVariants
              });
              showToast("Live results on — matches appear as they're found", "info", 4000);
            } else if (evt.type === "match") {
              pushProgressiveMatch(evt);
            } else if (evt.type === "complete") {
              // renderCb runs right after and re-renders cleanly; just stop the
              // live session here as a safety net.
              endProgressive();
            }
          },
          emitGroupsCb: null
        });
      } catch (e) {
        if (e.message !== "Scan stopped.") {
          console.error("Scan error:", e);
          showToast("Scan failed: " + e.message, "error");
          setStatus("Scan failed.");
        }
      } finally {
        endProgressive();
        abortCtrl = null;
      }
    };
  }
  
  if (btnStop) {
    btnStop.onclick = () => {
      if (abortCtrl) {
        abortCtrl.abort();
        setStatus("Stopping…");
        showToast("Scan stopped", "info");
      }
    };
  }
}

function wireDbControls() {
  const btnDbClear = el("btnDbClear");
  const btnDbExport = el("btnDbExport");
  const btnDbImport = el("btnDbImport");
  const dbImportFile = el("dbImportFile");
  const dbCount = el("dbCount");
  
  const updateCount = async () => {
    if (dbCount) {
      try {
        const count = await dbCountImages();
        dbCount.textContent = count.toLocaleString();
      } catch {
        dbCount.textContent = "—";
      }
    }
  };
  
  updateCount();
  
  // Clear button now does full reset (clear cache + service worker + reload)
  if (btnDbClear) {
    btnDbClear.onclick = async () => {
      if (!confirm("Clear all cached hashes and reload?\n\nThis ensures a clean state for scanning.")) {
        return;
      }
      
      try {
        btnDbClear.disabled = true;
        btnDbClear.textContent = "Clearing...";
        
        // Clear IndexedDB hash cache
        await dbClearImages();
        releaseAllThumbBlobs();
        console.log("[DDD] Cleared IndexedDB cache");
        
        // Unregister service worker
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (const reg of registrations) {
            await reg.unregister();
            console.log("[DDD] Unregistered service worker");
          }
        }
        
        // Clear browser caches
        if ('caches' in window) {
          const names = await caches.keys();
          for (const name of names) {
            await caches.delete(name);
            console.log("[DDD] Deleted cache:", name);
          }
        }
        
        // Security: Client ID is stored in IndexedDB only — no localStorage to clear
        // (localStorage.clear() removed: no sensitive data lives there)
        
        console.log("[DDD] Reset complete, reloading...");
        window.location.reload(true);
      } catch (e) {
        console.error("[DDD] Reset failed:", e);
        showToast("Reset failed: " + e.message, "error");
        btnDbClear.disabled = false;
        btnDbClear.textContent = "Clear";
      }
    };
  }
  
  if (btnDbExport) {
    btnDbExport.onclick = async () => {
      try {
        btnDbExport.disabled = true;
        btnDbExport.textContent = "Exporting...";
        
        const data = await dbExportImages((done, total, complete) => {
          if (!complete) {
            btnDbExport.textContent = `Exporting... ${done}`;
          }
        });
        
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `ddd-cache-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        showToast(`Exported ${data.length} cached entries`, "success");
      } catch (e) {
        showToast("Export failed: " + e.message, "error");
      } finally {
        btnDbExport.disabled = false;
        btnDbExport.textContent = "Export";
      }
    };
  }
  
  if (btnDbImport && dbImportFile) {
    btnDbImport.onclick = () => dbImportFile.click();
    
    dbImportFile.onchange = async () => {
      const file = dbImportFile.files?.[0];
      if (!file) return;
      
      try {
        btnDbImport.disabled = true;
        btnDbImport.textContent = "Importing...";
        
        const text = await file.text();
        const data = JSON.parse(text);
        
        if (!Array.isArray(data)) throw new Error("Invalid cache file format");
        
        await dbImportImages(data, (done, total) => {
          btnDbImport.textContent = `Importing... ${done}/${total}`;
        });
        
        await updateCount();
        showToast(`Imported ${data.length} cached entries`, "success");
      } catch (e) {
        showToast("Import failed: " + e.message, "error");
      } finally {
        dbImportFile.value = "";
        btnDbImport.disabled = false;
        btnDbImport.textContent = "Import";
      }
    };
  }
}

function wireCollapsibles() {
  document.querySelectorAll(".sectionHeader").forEach(header => {
    header.addEventListener("click", () => {
      const section = header.closest(".section");
      if (section) section.classList.toggle("collapsed");
    });
    
    header.setAttribute("tabindex", "0");
    header.setAttribute("role", "button");
    
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        header.click();
      }
    });
  });
}

function wireScrollToTop() {
  const btn = el("btnScrollTop");
  const tableWrap = document.querySelector(".tableWrap");
  
  if (!btn || !tableWrap) return;
  
  tableWrap.addEventListener("scroll", () => {
    btn.style.display = tableWrap.scrollTop > 300 ? "flex" : "none";
  });
  
  btn.onclick = () => tableWrap.scrollTo({ top: 0, behavior: "smooth" });
}

function wireTelemetryButton() {
  const btn = document.getElementById("btnTelemetry");
  if (btn) btn.onclick = () => toggleTelemetry();
}

function wireUndoButton() {
  const btn = document.getElementById("btnUndo");
  if (btn) btn.onclick = () => undoLastDelete();
}

async function checkResumeState() {
  const state = await loadResumeState().catch(() => null);
  if (!state) return;
  const desc = formatResumeDescription(state);
  const confirmed = confirm(
    `Resume previous scan?

${desc}

Click OK to resume, Cancel to start fresh.`
  );
  if (!confirmed) {
    await clearResumeState();
  }
  // If confirmed, the scan.js layer will detect the state and use it
}

// Register service worker (non-blocking)
// Listens for SW_UPDATED message and reloads automatically so stale caches never block users
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('./sw.js')
    .then((reg) => {
      console.log('[SW] Registered:', reg.scope);
      // When a new SW activates, reload the page to get fresh files
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'activated' && navigator.serviceWorker.controller) {
            console.log('[SW] New version activated — reloading for fresh files');
            window.location.reload();
          }
        });
      });
    })
    .catch((err) => console.warn('[SW] Registration failed:', err));

  // Also handle the SW_UPDATED postMessage from the new service worker
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'SW_UPDATED') {
      console.log('[SW] Received update signal v' + ev.data.version + ' — reloading');
      window.location.reload();
    }
  });
}

async function init() {
  console.log("Drive Dupe Destroyer v14.0 initializing…");

  // Apply all security policies before anything else
  try { applyAllSecurityPolicies(); } catch(e) { console.warn("Security init failed:", e); }

  // Register service worker in background (non-blocking)
  registerServiceWorker();
  
  setupBackgroundDetection();
  
  uiInit();
  
  // Wire up the selected count provider so UI can get accurate count
  setSelectedCountProvider(getSelectedCount);
  
  wireAuth({ onSignedIn: async () => {} });
  wireFolderPicker();
  wireRenderControls();
  wireCompare();
  wireCrop();
  wireKeyboard();
  wireActions();
  wireExport();
  wireQueue();
  
  wireSliders();
  wireMatchMode();
  wireErrorModal();
  wireKeepRule();
  wireScanControls();
  wireImageTypeToggles();
  wireDbControls();
  wireCollapsibles();
  wireScrollToTop();
  wireThemeToggle();
  wireTelemetryButton();
  wireUndoButton();
  await initPersistentSettings();
  await checkResumeState();
  
  setSignedInUi(false);
  showEmptyState(true);
  setScanningState(false);
  
  setStatus("Ready. Sign in to start.");
  console.log("Drive Dupe Destroyer v14.0 ready.");
}

// v14: 🖼️ Image Types panel. The master "Select all" box toggles every format
// box, and a live count badge shows how many formats are enabled. The scan
// reads the individual boxes at scan time (see scan.js), so no global state is
// needed here — this only manages the panel's own UI behaviour.
function wireImageTypeToggles() {
  const master = document.getElementById("imgTypeAll");
  const countEl = document.getElementById("imgTypeCount");
  const boxes = () => Array.from(document.querySelectorAll(".imgTypeToggle"));

  const updateMasterAndCount = () => {
    const all = boxes();
    const on = all.filter(b => b.checked);
    if (countEl) countEl.textContent = String(on.length);
    if (master) {
      master.checked = on.length === all.length && all.length > 0;
      master.indeterminate = on.length > 0 && on.length < all.length;
    }
  };

  if (master) {
    master.addEventListener("change", () => {
      for (const b of boxes()) b.checked = master.checked;
      updateMasterAndCount();
    });
  }
  for (const b of boxes()) b.addEventListener("change", updateMasterAndCount);
  updateMasterAndCount();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();}
