/*
 * Drive Dupe Destroyer (DDD) — test/theme-parity.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The light palette is declared TWICE in styles.css and must not drift.
//
// One copy backs the explicit toggle ([data-theme="light"]). The other backs the
// operating system's preference, inside @media (prefers-color-scheme: light), so
// a light-desktop user gets the right colours on FIRST PAINT — the theme is
// resolved from IndexedDB, which is async, and an inline <head> script to
// pre-empt the flash is impossible because script-src carries no 'unsafe-inline'.
//
// Two copies is the cost of that. This is the thing that stops them diverging:
// a comment saying "keep these in sync" has never once caught a violation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");

// Pull the declarations out of one rule body, ignoring comments and whitespace.
function declarations(body) {
  const out = new Map();
  for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const name = decl.slice(0, i).trim();
    if (!name) continue;
    out.set(name, decl.slice(i + 1).trim().replace(/\s+/g, " "));
  }
  return out;
}

function ruleBody(selectorPattern) {
  const m = CSS.match(selectorPattern);
  assert.ok(m, `could not find the rule matching ${selectorPattern}`);
  const from = CSS.indexOf("{", m.index) + 1;
  return CSS.slice(from, CSS.indexOf("}", from));
}

describe("light palette parity", () => {
  const explicit = declarations(ruleBody(/\[data-theme="light"\]\s*\{/));
  const system = declarations(ruleBody(/:root:not\(\[data-theme="dark"\]\):not\(\[data-theme="light"\]\)\s*\{/));

  test("both copies exist and are not empty", () => {
    assert.ok(explicit.size > 5, `explicit light block has ${explicit.size} declarations`);
    assert.ok(system.size > 5, `system light block has ${system.size} declarations`);
  });

  test("they declare exactly the same properties", () => {
    assert.deepEqual([...system.keys()].sort(), [...explicit.keys()].sort());
  });

  test("every property has the same value in both", () => {
    const drift = [];
    for (const [name, value] of explicit) {
      if (system.get(name) !== value) drift.push(`${name}: "${value}" vs "${system.get(name)}"`);
    }
    assert.deepEqual(drift, [], "the two light palettes have diverged");
  });

  test("the system block is gated so an explicit choice always wins", () => {
    // Without both :not()s, toggling to dark on a light desktop would leave the
    // light variables applied and the page would not change.
    assert.match(CSS, /@media \(prefers-color-scheme: light\)/);
    assert.match(CSS, /:root:not\(\[data-theme="dark"\]\):not\(\[data-theme="light"\]\)/);
  });

  test("the dark palette stays the unconditional default on :root", () => {
    // A user on a dark or unknown OS, and every browser without the media query,
    // must still get a complete palette from :root alone.
    const root = declarations(ruleBody(/^:root\s*\{/m));
    for (const name of explicit.keys()) {
      assert.ok(root.has(name), `:root must define ${name} so it never falls back to nothing`);
    }
  });
});
