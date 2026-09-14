/*
 * Drive Dupe Destroyer (DDD) — settings.js
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
// Persistent scan settings using IndexedDB settings store
// Feature #1: Persistent scan settings

import { settingGet, settingSet } from "./db.js";
import { el } from "./util.js";

// All persistable controls with their defaults
const PERSISTABLE = [
  { id: "recursiveMode",   type: "checkbox", default: true },
  { id: "useDb",           type: "checkbox", default: true },
  { id: "checkVariants",   type: "checkbox", default: false },
  { id: "cropDetect",      type: "checkbox", default: false },
  { id: "colorMatch",      type: "checkbox", default: false },
  { id: "pHashMode",       type: "checkbox", default: false },
  { id: "rotationVariants",type: "checkbox", default: false },
  { id: "sensitivityLevel",type: "range",    default: "3" },
  { id: "hamThresh",       type: "range",    default: "2" },
  { id: "maxItems",        type: "range",    default: "3" },
  { id: "pageSize",        type: "range",    default: "2" },
  { id: "keepRule",        type: "select",   default: "hires" },
  { id: "folderPriority",  type: "text",     default: "" },
  { id: "matchMode",       type: "radio",    default: "similar", name: "matchMode" },
  { id: "dhashSize",       type: "select",   default: "12" },
  { id: "imgMinSize",      type: "number",   default: "0" },
  { id: "imgMaxSize",      type: "number",   default: "0" },
  { id: "aspectFilter",    type: "checkbox", default: false },
  // 20, matching index.html -- the range is 0..50, so the old "2" here was a
  // copy of hamThresh's default and never a valid aspect tolerance.
  { id: "aspectTolerance", type: "range",    default: "20" },
  { id: "lshMode",         type: "select",   default: "auto" },
];

// Assigning `.value` or `.checked` from script does NOT fire input/change, so
// every handler that derives state from a control keeps whatever it computed
// from the HTML default. That is not cosmetic. The "Max images" and "Page size"
// sliders are indexes into a lookup table and keep their real value in
// `dataset.actualValue`, written only by their `oninput` handler -- and
// scan.js reads that attribute, not the slider. A restored "Max images" of
// 5,000 was therefore scanned as unlimited and a restored page size of 100 as
// 500, while the sliders sat at the positions the user had chosen.
//
// Dispatch what a real interaction would, so a restore is indistinguishable
// from the user moving the control.
function notifyRestored(node) {
  if (!node) return;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

async function loadSettings() {
  const saved = await settingGet("destroyer_scan_settings_v1", null).catch(() => null);
  if (!saved) return;

  const restored = [];
  for (const def of PERSISTABLE) {
    const val = saved[def.id];
    if (val === undefined || val === null) continue;
    if (def.type === "radio") {
      const radio = document.querySelector(`input[name="${def.name}"][value="${val}"]`);
      if (radio) { radio.checked = true; restored.push(radio); }
    } else {
      const el2 = el(def.id);
      if (!el2) continue;
      if (def.type === "checkbox") el2.checked = val;
      else el2.value = val;
      restored.push(el2);
    }
  }

  // Dispatch only once every control holds its restored value. A handler that
  // reads a sibling control -- the match-mode panels do -- would otherwise see
  // a half-applied mixture of saved and default state.
  for (const node of restored) notifyRestored(node);
}

async function saveSettings() {
  const out = {};
  for (const def of PERSISTABLE) {
    if (def.type === "radio") {
      const checked = document.querySelector(`input[name="${def.name}"]:checked`);
      out[def.id] = checked ? checked.value : def.default;
    } else {
      const el2 = el(def.id);
      if (!el2) continue;
      out[def.id] = def.type === "checkbox" ? el2.checked : el2.value;
    }
  }
  await settingSet("destroyer_scan_settings_v1", out).catch(() => {});
}

export async function initPersistentSettings() {
  await loadSettings();
  // Fire any dependent update handlers after load
  document.querySelectorAll('input, select').forEach(el2 => {
    el2.addEventListener("change", () => saveSettings(), { passive: true });
  });
  // Sliders use input event
  document.querySelectorAll('input[type="range"]').forEach(el2 => {
    el2.addEventListener("input", () => saveSettings(), { passive: true });
  });
}
