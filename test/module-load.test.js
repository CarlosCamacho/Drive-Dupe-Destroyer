/*
 * Drive Dupe Destroyer (DDD) — test/module-load.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Every module the suite imports must LOAD in a bare JavaScript environment.
//
// This exists because of a failure I caused and did not see. js/hashing.js sized
// its worker pool from a bare `navigator.hardwareConcurrency` at module scope.
// Node 22 — what I develop on — defines `navigator`. Node 20 — what CI pins —
// does not, so the identifier threw ReferenceError the instant anything
// imported the module, and two whole test files failed to load. Locally: 210
// passing. On CI: 181 run, 2 files dead. Four releases of red builds, and the
// only signal was an email.
//
// A browser global read at module scope is also a real hazard in the app, not
// just in tests: these modules are imported by workers, where `window` and
// `document` do not exist either.
//
// The module list is derived from what the tests actually import, so adding a
// test that reaches a new module extends this check automatically.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Globals a browser provides and a plain JS runtime does not. `navigator` is
// the one that bit us — Node added it in 21, so it is present on a modern
// runtime and absent on the pinned one, which is the worst case: it works
// everywhere you look.
const BROWSER_GLOBALS = [
  "navigator", "window", "document", "self", "location",
  "localStorage", "sessionStorage", "indexedDB", "caches", "Worker",
];

/** Every js/ module reached by an import in test/*.test.js, transitively. */
function modulesUnderTest() {
  const seen = new Set();
  const queue = [];

  for (const f of readdirSync(TEST_DIR).filter((n) => n.endsWith(".test.js"))) {
    const src = readFileSync(TEST_DIR + f, "utf8");
    for (const m of src.matchAll(/from\s+"\.\.\/(js\/[\w-]+\.js)"/g)) queue.push(m[1]);
  }
  while (queue.length) {
    const mod = queue.pop();
    if (seen.has(mod)) continue;
    seen.add(mod);
    const src = readFileSync(ROOT + mod, "utf8");
    for (const m of src.matchAll(/from\s+"\.\/([\w-]+\.js)"/g)) queue.push("js/" + m[1]);
  }
  return [...seen].sort();
}

const MODULES = modulesUnderTest();

describe("modules load without the browser", () => {
  before(() => {
    // A guard on the guard: if the import scan breaks, every test below would
    // pass vacuously.
    assert.ok(MODULES.length >= 5, `expected several modules, found ${MODULES.join(", ")}`);
    assert.ok(MODULES.includes("js/hashing.js"), "hashing.js is the one this was written for");
  });

  for (const mod of MODULES) {
    test(`${mod} imports with no browser globals defined`, () => {
      // A child process, so deleting the globals cannot leak into this one.
      const script =
        `for (const g of ${JSON.stringify(BROWSER_GLOBALS)}) { try { delete globalThis[g]; } catch {} }\n` +
        `await import(${JSON.stringify(ROOT + mod)});`;
      try {
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "ignore", "pipe"], timeout: 20000,
        });
      } catch (e) {
        const detail = String(e.stderr || e.message).split("\n").slice(0, 6).join("\n");
        assert.fail(
          `${mod} does not load without the browser. A browser global read at ` +
          `MODULE SCOPE is the usual cause — read it through globalThis and give ` +
          `it a default.\n\n${detail}`
        );
      }
    });
  }
});
