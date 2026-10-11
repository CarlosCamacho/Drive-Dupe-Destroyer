/*
 * Drive Dupe Destroyer (DDD) — test/sw-load.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The service worker has to EVALUATE.
//
// From v14.6.1 it did not: KNOWN_ASSETS read PRECACHE above the line that
// declared it, so the script threw "Cannot access 'PRECACHE' before
// initialization" every time a browser loaded it. A worker whose script throws
// never installs, so no update after that point reached anyone. Users holding
// an older worker were served that older build, cache-first, indefinitely.
//
// Nothing caught it because nothing ran the file: `node --check` only parses,
// and a temporal-dead-zone error is a runtime error. This runs it, in a context
// shaped like a ServiceWorkerGlobalScope, and checks that it got as far as
// registering its handlers.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "sw.js"), "utf8");

function evaluate(hostname) {
  const handlers = new Map();
  const self = {
    location: new URL(`https://${hostname}/sw.js`),
    addEventListener: (type, fn) => handlers.set(type, fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
  };
  const context = vm.createContext({ self, URL, Set, Map, Promise, console, caches: {}, fetch: () => {} });
  vm.runInContext(SRC, context, { filename: "sw.js" });
  return handlers;
}

describe("sw.js", () => {
  test("evaluates without throwing", () => {
    assert.doesNotThrow(() => evaluate("example.com"));
  });

  test("and registers the handlers that make it a working service worker", () => {
    const handlers = evaluate("example.com");
    for (const type of ["install", "activate", "fetch"]) {
      assert.equal(typeof handlers.get(type), "function", `${type} handler`);
    }
  });

  test("in development too", () => {
    assert.doesNotThrow(() => evaluate("localhost"));
  });
});
