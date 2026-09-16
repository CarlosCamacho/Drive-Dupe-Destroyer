/*
 * Drive Dupe Destroyer (DDD) — keyboard.js
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
// Keyboard navigation

import { el, anyModalOpen } from "./util.js";
import { showToast, lockBodyScroll } from "./ui.js";

function focusRow(row) {
  if (!row) return;
  row.focus();
  row.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function allRows() {
  return Array.from(document.querySelectorAll("[data-item]"));
}

export function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
      return;
    }
    
    const active = document.activeElement;
    
    if (active && active.matches?.("[data-item]")) {
      const rows = allRows();
      const idx = rows.indexOf(active);
      if (idx < 0) return;

      if (e.key === " ") {
        e.preventDefault();
        const cb = active.querySelector('input[type="checkbox"]');
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      
      if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        const cb = active.querySelector('input[type="checkbox"]');
        if (cb && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        focusRow(rows[idx + 1]);
        return;
      }
      
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        focusRow(rows[idx - 1]);
        return;
      }
      
      if (e.key === "Home") {
        e.preventDefault();
        focusRow(rows[0]);
        return;
      }
      
      if (e.key === "End") {
        e.preventDefault();
        focusRow(rows[rows.length - 1]);
        return;
      }
    }
    
    // The one shortcut people try by reflex after deleting something by
    // accident, and it was not bound -- Ctrl+A was, Ctrl+Z was not (#106).
    // Guarded on modals so it cannot fire while a dialog owns the keyboard, and
    // on the browser's own undo inside a text field.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (anyModalOpen()) return;
      if (e.target?.matches?.("input, textarea, select, [contenteditable]")) return;
      const btnUndo = el("btnUndo");
      if (btnUndo && !btnUndo.disabled) {
        e.preventDefault();
        btnUndo.click();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      const resultsArea = document.querySelector(".tableWrap");
      if (resultsArea?.contains(document.activeElement) || 
          document.activeElement?.matches?.("[data-item]")) {
        e.preventDefault();
        const btnSelectAll = el("btnSelectAll");
        if (btnSelectAll && !btnSelectAll.disabled) btnSelectAll.click();
      }
      return;
    }
    
    // Escape clears the selection ONLY when nothing is stacked on top. Every
    // modal already closes itself on Escape; without this guard the same
    // keypress also discarded the user's entire deletion selection, which has
    // no undo. One keypress, one action.
    if (e.key === "Escape") {
      if (anyModalOpen()) return;
      const btnSelectNone = el("btnSelectNone");
      if (btnSelectNone && !btnSelectNone.disabled) btnSelectNone.click();
      return;
    }
    
    if (e.key === "?") {
      if (anyModalOpen()) return;
      showKeyboardHelp();
      return;
    }
  });

  document.addEventListener("focusin", (e) => {
    if (e.target.matches?.("[data-item]")) e.target.classList.add("focused");
  });

  document.addEventListener("focusout", (e) => {
    if (e.target.matches?.("[data-item]")) e.target.classList.remove("focused");
  });
}

/**
 * Open the shortcuts panel.
 *
 * This used to be a single-line toast that vanished after four seconds, listing
 * five of the app's twenty shortcuts and omitting every modal-specific one --
 * and nothing anywhere told the user that "?" did anything at all (#110).
 */
export function showKeyboardHelp() {
  const modal = el("shortcutsModal");
  if (!modal) return;
  modal.style.display = "flex";
  lockBodyScroll(true);
  modal.querySelector("#btnShortcutsClose")?.focus();
}

export function hideKeyboardHelp() {
  const modal = el("shortcutsModal");
  if (!modal) return;
  modal.style.display = "none";
  lockBodyScroll(false);
}

export function wireKeyboardHelp() {
  el("btnShortcuts")?.addEventListener("click", showKeyboardHelp);
  el("btnShortcutsClose")?.addEventListener("click", hideKeyboardHelp);
  const modal = el("shortcutsModal");
  modal?.addEventListener("click", (e) => { if (e.target === modal) hideKeyboardHelp(); });
  // Listen on document, not the modal: a <div> is not focusable, so Escape
  // never reaches it otherwise -- the same reason the queue modal does this.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal?.style.display === "flex") hideKeyboardHelp();
  });
}
