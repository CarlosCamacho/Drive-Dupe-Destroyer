/*
 * Drive Dupe Destroyer (DDD) — confirm.js
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
// In-app confirmation dialog (#109).
//
// This app exists to decide which of two near-identical photographs to destroy,
// and every one of those decisions used to be made in a native confirm() —
// which cannot show either photograph. Ten call sites, including "Move to
// trash", "Clear the entire queue" and the keep-file warning.
//
// Native dialogs also block the main thread, cannot be styled or keyboard-
// navigated beyond OK/Cancel, and on mobile can be suppressed entirely by the
// browser's "prevent this page from creating additional dialogs" checkbox —
// after which every guarded action silently does nothing.
//
// The API is deliberately confirm()-shaped (one call, awaits a boolean) so the
// call sites read the same, but it takes structured detail rather than a string.

import { escapeHtml, bytesToHuman } from "./util.js";
import { lockBodyScroll } from "./ui.js";

const IMAGE_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3C/svg%3E";

/** Said once, everywhere a deletion is confirmed, so the reassurance cannot drift. */
export const UNDO_NOTE =
  "Files go to Google Drive Trash, and Undo (Ctrl+Z) restores them for the next 30 minutes.";

let modal = null;
let lastFocused = null;

function build() {
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "confirmModal";
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "confirmModalTitle");
  modal.style.display = "none";
  modal.innerHTML = `
    <div class="modalContent modalSmall">
      <div class="modalHeader">
        <h2 id="confirmModalTitle"></h2>
        <button type="button" class="btnClose" data-confirm="cancel" aria-label="Close">✕</button>
      </div>
      <div class="modalBody">
        <p id="confirmMessage"></p>
        <div id="confirmDetail" class="confirmDetail" hidden></div>
        <p id="confirmNote" class="muted confirmNote" hidden></p>
      </div>
      <div class="modalFooter">
        <button type="button" class="btnGhost" data-confirm="cancel">Cancel</button>
        <button type="button" class="btnDanger" data-confirm="ok"></button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

/** One file, shown the way the results table shows it. */
function fileRow(f) {
  const dims = f.imageMediaMetadata?.width && f.imageMediaMetadata?.height
    ? `${f.imageMediaMetadata.width} × ${f.imageMediaMetadata.height}` : "";
  const bits = [dims, f.size ? bytesToHuman(Number(f.size)) : "", f._path || ""].filter(Boolean);
  return `
    <div class="confirmFile">
      <img class="confirmThumb" src="${IMAGE_PLACEHOLDER}" data-file-id="${escapeHtml(f.id || "")}" alt="">
      <div class="confirmFileText">
        <b>${escapeHtml(f.name || f.id || "Untitled")}</b>
        <div class="muted">${escapeHtml(bits.join(" · "))}</div>
      </div>
    </div>`;
}

/**
 * @param {object}   o
 * @param {string}   o.title
 * @param {string}   o.message      what will happen, in plain language
 * @param {string}   [o.confirmLabel] the verb, never "OK" — see ui-ux button labels
 * @param {string}   [o.note]       consequence or reassurance, e.g. the undo window
 * @param {object[]} [o.files]      files at stake, shown with thumbnail and path
 * @param {boolean}  [o.danger]     styles the confirm button as destructive
 * @returns {Promise<boolean>}
 */
export function confirmAction({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Confirm",
  note = "",
  files = [],
  danger = true,
} = {}) {
  const m = build();
  m.querySelector("#confirmModalTitle").textContent = title;
  m.querySelector("#confirmMessage").textContent = message;

  const detail = m.querySelector("#confirmDetail");
  const shown = files.slice(0, 4);
  detail.innerHTML = shown.map(fileRow).join("") +
    (files.length > shown.length
      ? `<div class="muted confirmMore">and ${files.length - shown.length} more</div>` : "");
  detail.hidden = files.length === 0;

  const noteEl = m.querySelector("#confirmNote");
  noteEl.textContent = note;
  noteEl.hidden = !note;

  const okBtn = m.querySelector('[data-confirm="ok"]');
  okBtn.textContent = confirmLabel;
  okBtn.className = danger ? "btnDanger" : "btnBlue";

  lastFocused = document.activeElement;
  m.style.display = "flex";
  lockBodyScroll(true);
  // Focus the SAFE choice, synchronously. A destructive dialog should never be
  // dismissible by a stray Enter on the button that destroys something, and a
  // deferred focus leaves a window in which the previous element still has it.
  m.querySelector('.modalFooter [data-confirm="cancel"]')?.focus();

  return new Promise((resolve) => {
    const done = (answer) => {
      m.style.display = "none";
      lockBodyScroll(false);
      m.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      try { lastFocused?.focus?.(); } catch { /* element may be gone */ }
      resolve(answer);
    };

    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    // Capture, so Escape closes this dialog rather than the modal underneath it.
    document.addEventListener("keydown", onKey, true);

    m.onclick = (e) => {
      const act = e.target?.closest?.("[data-confirm]")?.dataset.confirm;
      if (act === "ok") done(true);
      else if (act === "cancel" || e.target === m) done(false);
    };
  });
}
