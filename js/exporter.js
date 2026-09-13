/*
 * Drive Dupe Destroyer (DDD) — exporter.js
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
import { chooseKeepIndex, bestDist, distToPercent, DEFAULT_KEEP_RULE } from "./common.js";

let exportState = {
  groups: [],
  pathMap: new Map(),
  idToEntry: new Map(),
  // Needed to reproduce exactly what the results table decided. Without them the
  // export cannot name the keep file or compute a similarity, which is how it
  // ended up labelling every row DUPLICATE.
  keepRule: DEFAULT_KEEP_RULE,
  folderPriority: "",
  bitsCount: 144,
  withVariants: false
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

/**
 * Build the rows written to CSV/JSON.
 *
 * This used to read three properties -- _isKeep, _matchDist and _matchType --
 * that nothing in the codebase ever assigned. findIndex returned -1, so
 * `fi === keepIdx` was never true and EVERY row exported as DUPLICATE, including
 * the file the app had chosen to keep; similarity was always null. Anyone acting
 * on the export would have deleted the originals along with the copies.
 *
 * The keep file and the distance are now derived the same way the results table
 * derives them -- chooseKeepIndex and bestDist over idToEntry -- so the export
 * and the UI cannot disagree about which file is the keeper.
 */
export function buildExportItems(groups, pathMap, idToEntry, opts = {}) {
  const keepRule = opts.keepRule || DEFAULT_KEEP_RULE;
  const folderPriority = opts.folderPriority || "";
  const bitsCount = opts.bitsCount || 144;
  const withVariants = !!opts.withVariants;

  return groups.map((g, gi) => {
    // Resolve folder paths first: chooseKeepIndex's folderPriority rule matches
    // on _path, and the export may run before the table has populated it.
    for (const f of g) {
      if (f && !f._path && pathMap?.get(f.id)) f._path = pathMap.get(f.id);
    }

    const keepIdx = chooseKeepIndex(g, keepRule, folderPriority);
    const keepFile = g[keepIdx] || g[0];
    const keepEntry = idToEntry?.get(keepFile?.id);

    return g.map((f, fi) => {
      const entry = idToEntry?.get(f.id);

      // Distance to the KEEP file, which is what the table's Sim column shows.
      let pct = null;
      let matchType = "structural";
      if (f.id === keepFile?.id) {
        pct = 100;
        matchType = "keep";
      } else if (keepEntry?.base12 && entry?.base12) {
        pct = distToPercent(bestDist(keepEntry, entry, withVariants, true), bitsCount);
      } else if (f.md5Checksum && keepFile?.md5Checksum && f.md5Checksum === keepFile.md5Checksum) {
        // Exact duplicates found by checksum are never hashed (the MD5 fast
        // path skips them), so they have no entry to measure -- but they are
        // byte-identical, which is a stronger statement than any hash distance.
        pct = 100;
        matchType = "exact-md5";
      }

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
        matchType,
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
        const items = buildExportItems(exportState.groups, exportState.pathMap, exportState.idToEntry, exportState);
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
        const items = buildExportItems(exportState.groups, exportState.pathMap, exportState.idToEntry, exportState);
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
