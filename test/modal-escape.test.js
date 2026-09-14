/*
 * Drive Dupe Destroyer (DDD) — test/modal-escape.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Tests for anyModalOpen() in js/util.js.
//
// Escape used to have two owners: each modal closed itself, and keyboard.js
// independently clicked "Select none". One keypress therefore dismissed a
// dialog AND discarded the user's whole deletion selection, which has no undo.
// This predicate is what keeps the second owner out of the way.
//
// The DOM surface it touches is three calls wide — querySelectorAll, an element's
// inline .style.display, and getComputedStyle — so it is stubbed here rather
// than pulling in a DOM library the project does not otherwise need.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { anyModalOpen } from "../js/util.js";

// Each "modal" is {inline, computed}: the inline style.display the app sets,
// and what a stylesheet would resolve to when no inline style is present.
function installDom(modals) {
  const nodes = modals.map(m => ({ style: { display: m.inline ?? "" }, _computed: m.computed ?? "none" }));
  globalThis.document = { querySelectorAll: (sel) => (sel === ".modal" ? nodes : []) };
  globalThis.getComputedStyle = (node) => ({ display: node._computed });
  return nodes;
}

describe("anyModalOpen", () => {
  beforeEach(() => { delete globalThis.document; delete globalThis.getComputedStyle; });
  afterEach(()  => { delete globalThis.document; delete globalThis.getComputedStyle; });

  test("no modals in the document at all", () => {
    installDom([]);
    assert.equal(anyModalOpen(), false);
  });

  test("all seven modals hidden, as on a freshly loaded page", () => {
    installDom(Array.from({ length: 7 }, () => ({ inline: "none" })));
    assert.equal(anyModalOpen(), false);
  });

  // Every modal in index.html is opened with style.display = "flex".
  test("one modal opened the way the app opens them", () => {
    installDom([{ inline: "none" }, { inline: "flex" }, { inline: "none" }]);
    assert.equal(anyModalOpen(), true);
  });

  test("a modal shown by a stylesheet rule rather than an inline style", () => {
    installDom([{ inline: "", computed: "block" }]);
    assert.equal(anyModalOpen(), true, "an inline style is not the only way to be visible");
  });

  test("an empty inline display that computes to none is closed", () => {
    installDom([{ inline: "", computed: "none" }]);
    assert.equal(anyModalOpen(), false);
  });

  // The one that matters for the bug: a closed dialog must not keep Escape from
  // clearing the selection, which is the behaviour the shortcut is meant to have.
  test("closing the last modal hands Escape back to the selection", () => {
    const nodes = installDom([{ inline: "flex" }]);
    assert.equal(anyModalOpen(), true);
    nodes[0].style.display = "none";
    assert.equal(anyModalOpen(), false);
  });
});
