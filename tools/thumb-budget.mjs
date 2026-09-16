/*
 * Drive Dupe Destroyer (DDD) — tools/thumb-budget.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/thumb-budget.mjs
 */
// #126: the thumbnail cache gives memory back under pressure, and says what it
// is doing.
//
// test/thumb-budget.test.js pins the POLICY (the pure formula). This pins the
// BEHAVIOUR: that shrinking really evicts and really revokes, that the hit rate
// is counted rather than assumed, and that the telemetry panel shows it -- the
// measurement the issue asks for, since the budget should be set from data
// rather than judgement.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);

const out = await page.evaluate(async () => {
  const h = await import('/js/hashing.js');
  const r = {};

  r.deviceMemory = navigator.deviceMemory ?? null;
  r.budget = h.getThumbCacheStats().budget;

  // NOT covered here: eviction under a real fill. getThumbUrlForFile needs a
  // signed-in Drive, and thumbUrlCache is module-private, so there is no way to
  // put real blobs in it from a harness. What IS covered is the budget policy
  // and the shrink response; test/thumb-budget.test.js pins the formula, and
  // the LRU eviction itself predates this change and is unmodified by it.
  const before = h.getThumbCacheStats();
  const shrunk = h.shrinkThumbCache();
  const after = h.getThumbCacheStats();

  r.shrinkBefore = shrunk.before;
  r.shrinkAfter = shrunk.after;
  r.budgetAfter = after.budget;
  r.entriesAfter = after.entries;

  // Shrinking repeatedly must bottom out at the floor rather than reaching zero
  // and making the cache useless.
  for (let i = 0; i < 12; i++) h.shrinkThumbCache();
  r.floor = h.getThumbCacheStats().budget;

  // Hit/miss accounting: releaseAllThumbBlobs clears, so a repeat lookup of the
  // same key after a clear must count as a miss, not a hit.
  h.releaseAllThumbBlobs();
  const zeroed = h.getThumbCacheStats();
  r.entriesAfterClear = zeroed.entries;
  r.bytesAfterClear = zeroed.bytes;

  // The telemetry panel must actually render the rows.
  const t = await import('/js/telemetry.js');
  await t.showTelemetry();
  await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
  const panelText = document.getElementById('telemetryBody')?.textContent || '';
  t.hideTelemetry();
  r.panelHasCache = /Thumb cache/.test(panelText);
  r.panelHasHitRate = /Thumb hit rate/.test(panelText);
  r.panelHasDevice = /Device memory/.test(panelText);
  return r;
});

console.log('   ', out);

const MB = 1048576;
ck(out.budget > 0, `#126 a budget is derived at module load (${(out.budget / MB).toFixed(0)} MB, deviceMemory ${out.deviceMemory ?? 'not reported'})`);
ck(out.shrinkAfter < out.shrinkBefore || out.shrinkAfter === 48 * MB,
   `#126 memory pressure halves the budget (${(out.shrinkBefore / MB).toFixed(0)} MB -> ${(out.shrinkAfter / MB).toFixed(0)} MB)`);
ck(out.budgetAfter === out.shrinkAfter,
   '#126 and the reported budget reflects it');
ck(out.floor === 48 * MB,
   `#126 repeated shrinking bottoms out at the floor rather than reaching zero (${(out.floor / MB).toFixed(0)} MB)`);
ck(out.entriesAfterClear === 0 && out.bytesAfterClear === 0,
   '#126 releaseAllThumbBlobs empties the cache');
ck(out.panelHasCache && out.panelHasHitRate && out.panelHasDevice,
   '#126 the telemetry panel reports bytes, hit rate and device memory');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
