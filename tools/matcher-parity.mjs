/*
 * Drive Dupe Destroyer (DDD) — tools/matcher-parity.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Proves the worker and main-thread matching paths agree EXACTLY (#69).
 *
 * The matching loop decides which files are duplicates, so a port that merely
 * looks right is not good enough. Both paths import js/matcher.js, so what this
 * actually exercises is the transport: payload packing, unpacking, and the
 * streamed emissions — which is where a port breaks.
 *
 * Not part of `npm test`: that suite is deliberately dependency-free node:test,
 * and this needs Playwright and a running server.
 *
 *     python3 serve_secure.py &
 *     node tools/matcher-parity.mjs
 */
// #69: the matching loop moved into a worker. The property that matters is not
// "the worker works" but "the worker and the main thread produce the SAME
// grouping" — the loop decides which files are duplicates, so a port that is
// merely plausible is not good enough.
//
// Both paths import js/matcher.js, so this is checking the transport, the
// payload serialisation and the streaming, which is exactly where a port breaks.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2500);

let f = 0; const ck = (ok, l) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) f++; };

const out = await page.evaluate(async () => {
  const { runMatching, packEntries } = await import('/js/matcher.js');

  const hashFrom = (seed, bytes, flips) => {
    const h = new Uint8Array(bytes);
    let s = seed >>> 0;
    for (let i = 0; i < bytes; i++) { s = (s * 1664525 + 1013904223) >>> 0; h[i] = s & 0xff; }
    for (let k = 0; k < flips; k++) h[k % bytes] ^= 1 << (k % 8);
    return h;
  };
  // 600 images in clusters of 3, plus singletons — a realistic mix.
  const entries = new Map();
  for (let i = 0; i < 600; i++) {
    const seed = 1000 + Math.floor(i / 3);
    entries.set(`f${i}`, { base12: hashFrom(seed, 18, i % 3), base8: hashFrom(seed, 8, (i % 3) ? 1 : 0) });
  }
  const allIds = [...entries.keys()];
  const opts = { hamThresh: 6, allIds, emitInterval: 5 };

  const norm = (groups) => groups.map(g => [...g].sort().join(',')).sort();

  // --- main thread ---------------------------------------------------------
  const mainStream = [];
  const t0 = performance.now();
  const mainRes = await runMatching({ entries, ...opts, onGroups: ({ batch }) => { for (const b of batch) mainStream.push([...b.group].sort().join(',')); } });
  const mainMs = performance.now() - t0;

  // --- worker --------------------------------------------------------------
  const w = new Worker('/js/worker-match.js', { type: 'module' });
  const workerStream = [];
  const t1 = performance.now();
  const workerRes = await new Promise((resolve, reject) => {
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'groups') { for (const b of m.batch) workerStream.push([...b.group].sort().join(',')); }
      else if (m.type === 'done') resolve(m);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'worker error'));
    { const { payload: packed, transfer } = packEntries(entries); w.postMessage({ type: 'run', payload: { packed, ...opts } }, transfer); }
  });
  const workerMs = performance.now() - t1;
  w.terminate();

  return {
    mainGroups: norm(mainRes.groups), workerGroups: norm(workerRes.groups),
    mainMatches: mainRes.matches, workerMatches: workerRes.matches,
    mainComparisons: mainRes.comparisons, workerComparisons: workerRes.comparisons,
    mainStreamCount: mainStream.length, workerStreamCount: workerStream.length,
    streamSame: JSON.stringify([...new Set(mainStream)].sort()) === JSON.stringify([...new Set(workerStream)].sort()),
    mainMs: Math.round(mainMs), workerMs: Math.round(workerMs),
  };
});

console.log(`  groups: main ${out.mainGroups.length}, worker ${out.workerGroups.length}`);
console.log(`  matches: main ${out.mainMatches}, worker ${out.workerMatches}   comparisons: ${out.mainComparisons} / ${out.workerComparisons}`);
console.log(`  streamed groups: main ${out.mainStreamCount}, worker ${out.workerStreamCount}`);
console.log(`  wall clock: main ${out.mainMs}ms, worker ${out.workerMs}ms`);

ck(JSON.stringify(out.mainGroups) === JSON.stringify(out.workerGroups), '#69 worker and main thread produce IDENTICAL groupings');
ck(out.mainMatches === out.workerMatches, '#69 the same number of matching pairs');
ck(out.mainComparisons === out.workerComparisons, '#69 the same number of comparisons — no candidate set drift');
ck(out.workerStreamCount > 0, '#69 groups still stream out progressively from the worker');
ck(out.streamSame, '#69 the streamed groups are the same set on both paths');
// Responsiveness is NOT asserted here: at this size the whole run fits inside a
// single frame, so a frame-gap comparison would measure scheduling noise. That
// belongs in tools/matcher-bench.mjs, which runs at a size where matching
// genuinely costs something.

console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(f ? 1 : 0);
