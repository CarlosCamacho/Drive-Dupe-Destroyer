/*
 * Drive Dupe Destroyer (DDD) — tools/matcher-bench.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Measures the matching phase: worker versus the yielding main thread (#69).
 *
 * BOTH sides must be given the same callbacks. An earlier version left onGroups
 * off the main-thread call, which skips flushDirty entirely, and so compared
 * "no emission" against "full emission" — making the worker look 20x slower
 * when it is in fact faster.
 *
 *     python3 serve_secure.py &
 *     node tools/matcher-bench.mjs 12000
 */
// Honest comparison at a size where matching actually costs something.
// Main thread WITH cooperative yielding is the behaviour that shipped before
// #69, so that is what the worker has to be measured against — not against an
// unyielding loop nobody ran.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2000);

const out = await page.evaluate(async (N) => {
  const { runMatching, packEntries } = await import('/js/matcher.js');
  const hashFrom = (seed, bytes, flips) => {
    const h = new Uint8Array(bytes);
    let s = seed >>> 0;
    for (let i = 0; i < bytes; i++) { s = (s * 1664525 + 1013904223) >>> 0; h[i] = s & 0xff; }
    for (let k = 0; k < flips; k++) h[k % bytes] ^= 1 << (k % 8);
    return h;
  };
  const entries = new Map();
  for (let i = 0; i < N; i++) {
    const seed = 1000 + Math.floor(i / 4);
    entries.set(`f${i}`, { base12: hashFrom(seed, 18, i % 4), base8: hashFrom(seed, 8, (i % 4) ? 1 : 0) });
  }
  const opts = { hamThresh: 8, allIds: [...entries.keys()], emitInterval: 25 };

  // Watch how long the UI thread is held, and how many frames it misses.
  const watch = async (run) => {
    let last = performance.now(), worst = 0, frames = 0, stop = false;
    const tick = () => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; frames++; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    const r = await run();
    const ms = performance.now() - t0;
    stop = true;
    return { ms: Math.round(ms), worstGap: Math.round(worst), fps: Math.round(frames / (ms / 1000)), r };
  };

  const yieldFn = () => new Promise(r => setTimeout(r, 0));
    // Both sides must do the SAME work. An earlier run left onGroups off the
  // main-thread call, which skips flushDirty entirely — so it compared "no
  // emission" against "full emission" and made the worker look 20x slower.
  let mainEmitted = 0;
  const mainThread = await watch(() => runMatching({ entries, ...opts, yieldFn, onGroups: ({ batch }) => { mainEmitted += batch.length; } }));

  const w = new Worker('/js/worker-match.js', { type: 'module' });
  let workerEmitted = 0;
  const worker = await watch(() => new Promise((res, rej) => {
    w.onmessage = (ev) => { if (ev.data.type === 'groups') workerEmitted += ev.data.batch.length; else if (ev.data.type === 'done') res(ev.data); else if (ev.data.type === 'error') rej(new Error(ev.data.message)); };
    const { payload: packed, transfer } = packEntries(entries);
    w.postMessage({ type: 'run', payload: { packed, ...opts } }, transfer);
  }));
  w.terminate();

  return {
    n: N,
    main: { ms: mainThread.ms, worstGap: mainThread.worstGap, fps: mainThread.fps, groups: mainThread.r.groups.length, emitted: mainEmitted },
    worker: { ms: worker.ms, worstGap: worker.worstGap, fps: worker.fps, groups: worker.r.groups.length, emitted: workerEmitted },
  };
}, Number(process.argv[2] || 4000));

console.log(`images: ${out.n}`);
console.log(`  main thread (yielding):  ${String(out.main.ms).padStart(6)}ms   worst frame gap ${String(out.main.worstGap).padStart(4)}ms   ~${out.main.fps} fps   ${out.main.groups} groups   ${out.main.emitted} emissions`);
console.log(`  worker:                  ${String(out.worker.ms).padStart(6)}ms   worst frame gap ${String(out.worker.worstGap).padStart(4)}ms   ~${out.worker.fps} fps   ${out.worker.groups} groups   ${out.worker.emitted} emissions`);
console.log(`  same grouping: ${out.main.groups === out.worker.groups}`);
console.log(`  wall clock:    ${(out.main.ms / out.worker.ms).toFixed(2)}x faster in the worker`);
await b.close();
