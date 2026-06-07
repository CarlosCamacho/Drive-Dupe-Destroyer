/*
 * Drive Dupe Destroyer (DDD) v14.0 — telemetry.js
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
// Hashing speed & pipeline telemetry overlay - Feature #3

import { el } from "./util.js";

let panel = null;
let visible = false;

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

export function showTelemetry() {
  createPanel();
  panel.style.display = "block";
  visible = true;
}

export function hideTelemetry() {
  if (panel) panel.style.display = "none";
  visible = false;
}

export function toggleTelemetry() {
  if (visible) hideTelemetry(); else showTelemetry();
}

export function updateTelemetry(stats) {
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
    ["WASM active",     stats.wasmAvailable ? "✓ Yes" : "✗ No"],
    ["WASM used",       fmt(stats.wasmUsed)],
    ["JS fallback",     fmt(stats.jsUsed)],
    ["SAB active",      stats.sabAvailable ? "✓ Yes" : "✗ No"],
    ["Duration",        stats.duration > 0 ? (stats.duration / 1000).toFixed(1) + "s" : "—"],
    ["MD5 exact dupes", fmt(stats.md5Exact ?? 0)],
    ["Rejected pairs",  fmt(stats.rejectedPairs ?? 0)],
  ];

  body.innerHTML = rows.map(([k, v]) =>
    `<div class="telemetry-row"><span class="tk">${k}</span><span class="tv">${v}</span></div>`
  ).join("");
}

export function isTelemetryVisible() {
  return visible;
}
