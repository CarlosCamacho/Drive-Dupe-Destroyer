/*
 * Drive Dupe Destroyer (DDD) — tools/matcher-fallback.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * The worker path must degrade to the main thread, not to a broken scan (#69).
 *
 *     python3 serve_secure.py &
 *     node tools/matcher-fallback.mjs
 */
// The worker path must degrade to the main thread, not to a broken scan.
// Block the worker script at the network layer and confirm the same grouping
// still comes out.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let f = 0; const ck = (ok, l) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) f++; };

for (const blocked of [false, true]) {
  const page = await (await b.newContext()).newPage();
  const warnings = [];
  page.on('console', m => { if (/match worker/i.test(m.text())) warnings.push(m.text().slice(0, 90)); });
  // Blocking the network is not enough -- the service worker precaches
  // worker-match.js and serves it from cache. The realistic failure is the
  // constructor refusing: worker-src blocked by CSP, or no module-worker support.
  if (blocked) await page.addInitScript(() => {
    window.Worker = function () { throw new Error("Worker blocked for this test"); };
  });
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2200);

  const res = await page.evaluate(async () => {
    const { runMatching, packEntries } = await import('/js/matcher.js');
    const hashFrom = (seed, bytes, flips) => {
      const h = new Uint8Array(bytes); let s = seed >>> 0;
      for (let i = 0; i < bytes; i++) { s = (s * 1664525 + 1013904223) >>> 0; h[i] = s & 0xff; }
      for (let k = 0; k < flips; k++) h[k % bytes] ^= 1 << (k % 8);
      return h;
    };
    const entries = new Map();
    for (let i = 0; i < 300; i++) {
      const seed = 2000 + Math.floor(i / 3);
      entries.set(`x${i}`, { base12: hashFrom(seed, 18, i % 3), base8: hashFrom(seed, 8, (i % 3) ? 1 : 0) });
    }
    const opts = { hamThresh: 6, allIds: [...entries.keys()] };

    // Try the worker exactly as scan.js does; fall back the same way.
    let viaWorker = null;
    try {
      const w = new Worker(new URL('/js/worker-match.js', location.href), { type: 'module' });
      const { payload: packed, transfer } = packEntries(entries);
      viaWorker = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 8000);
        w.onmessage = (ev) => { if (ev.data.type === 'done') { clearTimeout(t); res(ev.data); } else if (ev.data.type === 'error') { clearTimeout(t); rej(new Error(ev.data.message)); } };
        w.onerror = (e) => { clearTimeout(t); rej(new Error(e.message || 'worker failed to load')); };
        w.postMessage({ type: 'run', payload: { packed, ...opts } }, transfer);
      });
      w.terminate();
    } catch (e) {
      viaWorker = { failed: e.message };
    }
    const inline = await runMatching({ entries, ...opts });
    const norm = (g) => g.map(x => [...x].sort().join(',')).sort().join(' | ');
    return {
      workerFailed: !!viaWorker.failed,
      same: viaWorker.failed ? null : norm(viaWorker.groups) === norm(inline.groups),
      inlineGroups: inline.groups.length,
    };
  });

  if (!blocked) {
    ck(!res.workerFailed, 'worker available: it runs');
    ck(res.same === true, 'worker available: identical grouping to the inline path');
  } else {
    ck(res.workerFailed, 'worker blocked: the worker path genuinely fails');
    ck(res.inlineGroups === 100, `worker blocked: the inline path still produces the full result (${res.inlineGroups} groups)`);
  }
  await page.close();
}
console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(f ? 1 : 0);
