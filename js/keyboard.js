/*
 * Drive Dupe Destroyer (DDD) v14.0 — keyboard.js
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
// Keyboard navigation

import { el } from "./util.js";
import { showToast } from "./ui.js";

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
    
    if (e.key === "Escape") {
      const btnSelectNone = el("btnSelectNone");
      if (btnSelectNone && !btnSelectNone.disabled) btnSelectNone.click();
      return;
    }
    
    if (e.key === "?") {
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

function showKeyboardHelp() {
  showToast("⌨️ Space=toggle, D=delete, ↑↓=navigate, Ctrl+A=all, Esc=none", "info", 4000);
}
