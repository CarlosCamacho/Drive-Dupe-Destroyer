/*
 * Drive Dupe Destroyer (DDD) v14.0 — exporter.js
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
// Export results to JSON

import { el } from "./util.js";
import { showToast } from "./ui.js";
import { APP_VERSION } from "./ui.js";

let exportState = {
  groups: [],
  pathMap: new Map(),
  idToEntry: new Map()
};

export function setExportState(state) {
  exportState = state;
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
}

function buildExportItems(groups, pathMap, idToEntry) {
  return groups.map((g, gi) => {
    const keepIdx = g.findIndex(f => f._isKeep);
    return g.map((f, fi) => {
      const entry = idToEntry?.get(f.id);
      const dist = f._matchDist;
      const pct = dist != null && isFinite(dist) ? Math.round(100 * (1 - dist / 144)) : null;
      return {
        group: gi + 1,
        role: fi === keepIdx ? "KEEP" : "DUPLICATE",
        id: f.id,
        name: f.name,
        path: pathMap.get(f.id) || "",
        size: Number(f.size || 0) || 0,
        modifiedTime: f.modifiedTime || "",
        createdTime: f.createdTime || "",
        md5Checksum: f.md5Checksum || "",
        mimeType: f.mimeType || "",
        width: f.imageMediaMetadata?.width || null,
        height: f.imageMediaMetadata?.height || null,
        similarityPct: pct,
        matchType: f._matchType || "structural",
        webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`
      };
    });
  }).flat();
}

function itemsToCsv(items) {
  const cols = ["group","role","name","path","size","modifiedTime","md5Checksum",
                "mimeType","width","height","similarityPct","matchType","id","webViewLink"];
  const esc = v => {
    const s = v == null ? "" : String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  return [cols.join(","), ...items.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}

export function wireExport() {
  const btnExportJson = el("btnExportJson");
  const btnExportCsv = el("btnExportCsv");

  if (btnExportJson) {
    btnExportJson.onclick = () => {
      if (!exportState.groups.length) { showToast("No results to export", "info"); return; }
      try {
        const items = buildExportItems(exportState.groups, exportState.pathMap, exportState.idToEntry);
        const blob = new Blob([JSON.stringify({
          exportedAt: new Date().toISOString(),
          version: APP_VERSION,
          totalGroups: exportState.groups.length,
          totalFiles: items.length,
          items
        }, null, 2)], { type: "application/json" });
        download(`ddd-results-${getTimestamp()}.json`, blob);
        showToast(`Exported ${items.length} files as JSON`, "success");
      } catch (e) {
        showToast("Export failed: " + e.message, "error");
      }
    };
  }

  if (btnExportCsv) {
    btnExportCsv.onclick = () => {
      if (!exportState.groups.length) { showToast("No results to export", "info"); return; }
      try {
        const items = buildExportItems(exportState.groups, exportState.pathMap, exportState.idToEntry);
        const blob = new Blob([itemsToCsv(items)], { type: "text/csv;charset=utf-8;" });
        download(`ddd-results-${getTimestamp()}.csv`, blob);
        showToast(`Exported ${items.length} rows as CSV`, "success");
      } catch (e) {
        showToast("Export failed: " + e.message, "error");
      }
    };
  }
}

export function getExportState() {
  return exportState;
}
