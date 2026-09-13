/*
 * Drive Dupe Destroyer (DDD) — app.js
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
// Security-hardened: localStorage replaced with IndexedDB for all persistence
// Main application entry point

import { el, APP_VERSION } from "./util.js";
import { uiInit, setSignedInUi, setStatus, showEmptyState, setScanningState, showToast, wireErrorModal, setSelectedCountProvider, lockBodyScroll } from "./ui.js";
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
import { settingGet, settingSet, requestPersistentStorage, getStorageEstimate } from "./db.js";
import { initPersistentSettings } from "./settings.js";
import { toggleTelemetry } from "./telemetry.js";
import { undoLastDelete, loadUndoStack } from "./undo.js";
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
        // Consume the resume offer on the first scan after boot; a later scan in
        // the same session starts clean.
        const resume = takePendingResume();

        await runScan({
          folderIds,
          folders: getIncludedFolders(), // For scan history tracking
          exclusions: getExclusions(),
          signal: abortCtrl.signal,
          resume,
          renderCb: async (data) => {
            // Final, authoritative render (includes folder paths + final sort).
            endProgressive();
            // Pass the same options the table rendered with, so the export names
            // the same keep file and reports the same similarity.
            setExportState({
              groups: data.groups,
              pathMap: data.pathMap,
              idToEntry: data.idToEntry,
              keepRule: data.keepRule,
              folderPriority: data.folderPriority,
              bitsCount: data.bitsCount,
              withVariants: data.withVariants
            });
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

function wireAboutModal() {
  const btn = document.getElementById("btnAbout");
  const modal = document.getElementById("aboutModal");
  if (!btn || !modal) return;

  // Same open/close contract as the other modals in the app: overlay click,
  // Escape, the header X and the footer button all close it, and the body
  // scroll is locked while it is open.
  const open = () => {
    modal.style.display = "flex";
    lockBodyScroll(true);
    document.getElementById("aboutModalOk")?.focus();
  };

  const close = () => {
    modal.style.display = "none";
    lockBodyScroll(false);
    btn.focus();
  };

  btn.onclick = open;
  document.getElementById("aboutModalClose")?.addEventListener("click", close);
  document.getElementById("aboutModalOk")?.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "flex") close();
  });
}

function wireTelemetryButton() {
  const btn = document.getElementById("btnTelemetry");
  if (btn) btn.onclick = () => toggleTelemetry();
}

function wireUndoButton() {
  const btn = document.getElementById("btnUndo");
  if (btn) btn.onclick = () => undoLastDelete();

  // The undo stack is persisted, so a refresh (including the one sw.js triggers
  // when a new service worker activates) no longer discards it. Rehydrate on
  // boot so the button reflects what is actually still restorable.
  loadUndoStack().catch(e => console.warn("[Undo] Load failed:", e?.message || e));
}

// Collection frontier offered to the next scan, or null. Set by
// checkResumeState() at boot and consumed exactly once by the scan handler.
//
// The comment that used to sit at the bottom of this function claimed "the
// scan.js layer will detect the state and use it". It did not — nothing read
// the saved state, so clicking OK ran a full rescan. Worse, the state was only
// cleared on Cancel, so the prompt reappeared on every load for its full 24h
// lifetime.
let pendingResume = null;

export function takePendingResume() {
  const r = pendingResume;
  pendingResume = null;
  return r;
}

async function checkResumeState() {
  const state = await loadResumeState().catch(() => null);
  if (!state) return;

  // Only worth offering if there is actually work left to skip.
  if (!state.pendingFolderIds?.length) {
    await clearResumeState();
    return;
  }

  const desc = formatResumeDescription(state);
  const confirmed = confirm(
    `Resume previous scan?

${desc}

Click OK to resume, Cancel to start fresh.`
  );

  if (confirmed) {
    pendingResume = state;
  } else {
    await clearResumeState();
  }
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
    // The SW carries its own version literal (it cannot import util.js). If it has
    // drifted from APP_VERSION, the cache name derived from it has drifted too and
    // the app may be running against a stale precache. Surface it rather than
    // letting it fail silently, which is how stale-asset bugs go unnoticed.
    if (ev.data?.type === 'VERSION' && ev.data.version !== APP_VERSION) {
      console.warn(
        `[SW] Version mismatch: service worker reports v${ev.data.version}, app is v${APP_VERSION}. ` +
        `Bump SW_VERSION in sw.js to match APP_VERSION in js/util.js.`
      );
    }
  });

  // Ask the active worker to report its version so the check above can run.
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: 'VERSION_CHECK' }))
    .catch(() => {});
}

async function init() {
  console.log(`Drive Dupe Destroyer v${APP_VERSION} initializing…`);

  // Ask the browser not to evict our IndexedDB under storage pressure. Without
  // this the hash cache and the user's rejected-pairs list can vanish silently.
  // Non-blocking: a refusal is not an error, just a weaker guarantee.
  requestPersistentStorage()
    .then(async (granted) => {
      const est = await getStorageEstimate();
      if (est) {
        console.log(
          `[DB] Storage ${granted ? "persistent" : "best-effort"}: ` +
          `${(est.usage / 1048576).toFixed(1)} MB used of ` +
          `${(est.quota / 1048576).toFixed(0)} MB (${est.pctUsed.toFixed(1)}%)`
        );
      }
    })
    .catch(() => {});

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
  wireAboutModal();
  await initPersistentSettings();
  await checkResumeState();
  
  setSignedInUi(false);
  showEmptyState(true);
  setScanningState(false);
  
  setStatus("Ready. Sign in to start.");
  console.log(`Drive Dupe Destroyer v${APP_VERSION} ready.`);
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
