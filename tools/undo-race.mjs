/*
 * Drive Dupe Destroyer (DDD) — tools/undo-race.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/undo-race.mjs
 */
// #95: a delete recorded while the undo stack is still loading.
//
// This needs a real page: the defect is a race between an IndexedDB read and a
// fire-and-forget write, both against module state that only the browser
// instance owns. Each case imports js/undo.js under a fresh query string so
// `loadPromise` is null and the REAL first-load path runs — the module is
// already loaded in the page, and a second call to loadUndoStack() on that
// instance measures nothing.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2000);

const r = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const KEY = 'destroyer_undo_stack_v1';
  const names = (stack) => (stack || []).flatMap(o => o.files.map(f => f.fileName));
  const seed = (files) => db.stateSet(KEY, [{
    opId: 'previous-session', trashedAt: Date.now(),
    files: files.map(n => ({ fileId: n, fileName: n })),
  }]);
  const settle = () => new Promise(r => setTimeout(r, 300));

  // --- a delete lands while the load is in flight ---------------------------
  await seed(['a.jpg', 'b.jpg', 'c.jpg']);
  const undo = await import('/js/undo.js?fresh=' + Date.now());
  const p = undo.loadUndoStack();
  undo.pushUndoDeleteBatch([{ id: 'new1', name: 'just-deleted.jpg' }]);
  await p;
  await settle();
  const race = {
    memoryFiles: undo.getUndoFileCount(),
    memoryOps: undo.getUndoCount(),
    inDb: names(await db.stateGet(KEY)),
  };

  // --- two concurrent loads must agree -------------------------------------
  await seed(['x.jpg', 'y.jpg']);
  const undo2 = await import('/js/undo.js?fresh=' + (Date.now() + 1));
  const [n1, n2] = await Promise.all([undo2.loadUndoStack(), undo2.loadUndoStack()]);
  const concurrent = { n1, n2, files: undo2.getUndoFileCount() };

  // --- the ordinary path is unchanged --------------------------------------
  await seed(['p.jpg']);
  const undo3 = await import('/js/undo.js?fresh=' + (Date.now() + 2));
  await undo3.loadUndoStack();
  undo3.pushUndoDeleteBatch([{ id: 'q', name: 'q.jpg' }]);
  await settle();
  const normal = { files: undo3.getUndoFileCount(), inDb: names(await db.stateGet(KEY)) };

  return { race, concurrent, normal };
});

console.log('  ', r);

ck(r.race.memoryOps === 2 && r.race.memoryFiles === 4,
   '#95 a delete recorded during the load survives in memory, alongside the stored history');
ck(r.race.inDb.join() === 'a.jpg,b.jpg,c.jpg,just-deleted.jpg',
   '#95 and storage keeps both, oldest first — the new delete does not overwrite the history');

ck(r.concurrent.n1 === r.concurrent.n2,
   '#95 two concurrent loads return the same count');
ck(r.concurrent.files === 2,
   '#95 and the stack is loaded once, not doubled');

ck(r.normal.files === 2 && r.normal.inDb.join() === 'p.jpg,q.jpg',
   '#95 the ordinary load-then-delete path is unchanged');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
