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

function evaluate(hostname, { caches = {} } = {}) {
  const handlers = new Map();
  const self = {
    location: new URL(`https://${hostname}/sw.js`),
    addEventListener: (type, fn) => handlers.set(type, fn),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
  };
  const context = vm.createContext({ self, URL, Set, Map, Promise, console, caches, Request, fetch: () => {} });
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

// The precache must come from the SERVER. cache.addAll with plain URLs goes
// through the browser's HTTP cache, and GitHub Pages serves everything with
// max-age=600: a visit in the ten minutes before a release left the OLD files
// there, and the new worker filled its new cache with them -- the app then
// reported the new version number while serving the old code.
describe("sw.js install", () => {
  async function install() {
    const added = [];
    const caches = { open: async () => ({ addAll: async (reqs) => { added.push(...reqs); } }) };
    const handlers = evaluate("example.com", { caches });
    let pending = null;
    handlers.get("install")({ waitUntil: (p) => { pending = p; } });
    await pending;
    return added;
  }

  test("pre-caches the app shell and every module", async () => {
    const added = await install();
    const urls = added.map(r => new URL(r.url).pathname);
    assert.ok(urls.some(u => u.endsWith("/index.html")), "index.html");
    assert.ok(urls.some(u => u.endsWith("/js/app.js")), "js/app.js");
    assert.ok(added.length > 30, `${added.length} files`);
  });

  test("and fetches every one of them past the HTTP cache", async () => {
    const added = await install();
    const stale = added.filter(r => r.cache !== "reload").map(r => r.url);
    assert.deepEqual(stale, [], "these would be served from a possibly stale HTTP cache");
  });
});
