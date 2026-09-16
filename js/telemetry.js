/*
 * Drive Dupe Destroyer (DDD) — telemetry.js
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
// Hashing speed & pipeline telemetry overlay - Feature #3

import { el } from "./util.js";
import { confirmAction } from "./confirm.js";
import { clearRejections, getRejectionStats } from "./rejection.js";
import { showToast } from "./ui.js";

let panel = null;
let visible = false;
let lastStats = null;

function createPanel() {
  if (panel) return;
  panel = document.createElement("div");
  panel.id = "telemetryPanel";
  panel.className = "telemetry-panel";
  panel.innerHTML = `
    <div class="telemetry-header">
      <span>⚡ Scan Telemetry</span>
      <button id="btnCloseTelemetry" class="telemetry-close">×</button>
    </div>
    <div class="telemetry-body" id="telemetryBody">—</div>
  `;
  document.body.appendChild(panel);
  el("btnCloseTelemetry").onclick = () => hideTelemetry();
}

export async function showTelemetry() {
  createPanel();
  panel.style.display = "block";
  visible = true;
  // Render immediately rather than waiting for the next scan to push stats:
  // the rejected-pairs count and its Clear action have to be reachable at any
  // time, including before a scan has run in this session (#101).
  const rejectedPairs = await getRejectionStats().then(s => s.count).catch(() => 0);
  updateTelemetry({ ...(lastStats || {}), rejectedPairs });
}

export function hideTelemetry() {
  if (panel) panel.style.display = "none";
  visible = false;
}

export function toggleTelemetry() {
  if (visible) hideTelemetry(); else showTelemetry();
}

export function updateTelemetry(stats) {
  if (stats) lastStats = stats;
  if (!visible) return;
  const body = el("telemetryBody");
  if (!body || !stats) return;

  const fmt = (n, unit = "") => (isFinite(n) ? n.toLocaleString() + unit : "—");
  const pct = (n) => (isFinite(n) ? (n * 100).toFixed(1) + "%" : "—");

  const rows = [
    ["Images hashed",   fmt(stats.success)],
    ["Failed",          fmt(stats.failed)],
    ["Retried",         fmt(stats.retried)],
    ["Cache hits",      fmt(stats.cacheHits)],
    ["Cache hit rate",  pct(stats.cacheHits / Math.max(1, stats.success + stats.cacheHits))],
    ["Hash rate",       fmt(+stats.rate, " img/s")],
    // Three rows used to report a WASM-versus-JS split. There was never a
    // split: the WASM binary was never shipped, so "WASM active" always read
    // "✗ No" -- which looks like a browser limitation rather than a missing
    // file -- and every image went down the one path. See #47.
    ["Images hashed",   fmt(stats.hashed)],
    ["SAB active",      stats.sabAvailable ? "✓ Yes" : "✗ No"],
    ["Duration",        stats.duration > 0 ? (stats.duration / 1000).toFixed(1) + "s" : "—"],
    ["MD5 exact dupes", fmt(stats.md5Exact ?? 0)],
    ["Rejected pairs",  fmt(stats.rejectedPairs ?? 0)],
  ];

  body.innerHTML = rows.map(([k, v]) =>
    `<div class="telemetry-row"><span class="tk">${k}</span><span class="tv">${v}</span></div>`
  ).join("");

  // "Rejected pairs" was a number with nothing attached to it. Every other
  // cache in the app can be cleared; a "not a duplicate" decision could not be,
  // by any route -- clearRejections() existed, exported, with no caller, and the
  // full-reset button deliberately leaves rejections alone. So one mis-press in
  // the compare modal suppressed that pair in every future scan, permanently,
  // and this panel is where the user finds out rejections exist at all (#101).
  if ((stats.rejectedPairs ?? 0) > 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnClearRejections";
    btn.className = "telemetry-action";
    btn.textContent = "Forget rejected pairs";
    btn.title = "Stop suppressing the pairs you marked as not duplicates. They reappear on the next scan.";
    btn.onclick = async () => {
      const n = stats.rejectedPairs ?? 0;
      if (!await confirmAction({
        title: "Forget rejected pairs?",
        message: `${n.toLocaleString()} pair(s) you marked as "not a duplicate" will be offered again on the next scan.`,
        confirmLabel: "Forget them",
        note: "This cannot be undone.",
      })) return;
      btn.disabled = true;
      try {
        await clearRejections();
        updateTelemetry({ ...stats, rejectedPairs: (await getRejectionStats()).count });
        showToast("Rejected pairs forgotten", "success");
      } catch (e) {
        btn.disabled = false;
        showToast("Could not clear rejected pairs: " + (e?.message || e), "error");
      }
    };
    body.appendChild(btn);
  }
}

export function isTelemetryVisible() {
  return visible;
}
