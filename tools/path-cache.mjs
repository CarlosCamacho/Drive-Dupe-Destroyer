/*
 * Drive Dupe Destroyer (DDD) — tools/path-cache.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/path-cache.mjs
 */
// #79: the durable folder-path cache must survive a scan ending, and stale rows
// must expire on age — which is what the ts index has existed for since v1.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2500);
let f = 0; const ck = (ok, l) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) f++; };

const r = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const paths = await import('/js/paths.js');
  await db.pathCacheClear();

  // Fresh rows, as a scan writes them.
  await db.pathCacheSetBatch([
    { id: 'n1', path: '/My Drive/Photos/2019' },
    { id: 'n2', path: '/My Drive/Photos/2020' },
  ]);

  // What runScan's finally does now.
  paths.clearMemoryPathCaches();
  const survivesScanEnd = (await db.pathCacheGetBatch(['n1', 'n2'])).size;

  // An old row, written straight into the store with a past timestamp.
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  await new Promise((res, rej) => {
    indexedDB.open('drive_dupe_destroyer_db_v1').onsuccess = (e) => {
      const d = e.target.result;
      const tx = d.transaction('pathCache', 'readwrite');
      tx.objectStore('pathCache').put({ id: 'stale1', path: '/Old/Place', ts: old });
      tx.oncomplete = () => { d.close(); res(); };
      tx.onerror = () => { d.close(); rej(tx.error); };
    };
  });
  const beforePrune = (await db.pathCacheGetBatch(['n1', 'n2', 'stale1'])).size;

  const removed = await db.pathCachePrune(14);
  const afterPrune = await db.pathCacheGetBatch(['n1', 'n2', 'stale1']);

  // And the explicit Clear cache path still empties everything.
  await paths.clearPathCaches();
  const afterExplicitClear = (await db.pathCacheGetBatch(['n1', 'n2'])).size;

  return {
    survivesScanEnd, beforePrune, removed,
    keptFresh: afterPrune.size,
    staleGone: !afterPrune.has('stale1'),
    freshKept: afterPrune.has('n1') && afterPrune.has('n2'),
    afterExplicitClear,
  };
});
console.log('  ', r);
ck(r.survivesScanEnd === 2, '#79 resolved paths survive the end of a scan');
ck(r.beforePrune === 3, '#79 the stale row was seeded');
ck(r.removed === 1 && r.staleGone, '#79 a row older than the limit is pruned');
ck(r.freshKept, '#79 fresh rows are kept — the prune is by age, not a wipe');
ck(r.afterExplicitClear === 0, '#79 "Clear cache" still empties the path cache explicitly');
console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(f ? 1 : 0);
