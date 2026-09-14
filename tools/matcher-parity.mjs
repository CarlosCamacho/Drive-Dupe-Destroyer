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

// ---------------------------------------------------------------------------
// The same property with pHash mode on (#84)
// ---------------------------------------------------------------------------
//
// The run above carries no optional fields, so it agreed on both paths while
// pHash was being dropped in transit -- the field was packed under a name
// nothing reads, and the feature silently did nothing for every scan since #69.
// Parity has to be checked with the optional fields present, through the real
// worker, or it only proves the common case.
const ph = await page.evaluate(async () => {
  const { runMatching, packEntries } = await import('/js/matcher.js');

  // 30 pairs. Within a pair the dHashes are 4 bits apart -- above the threshold
  // of 2, so dHash alone rejects them, but close enough that the index still
  // offers the pair as a candidate. Across pairs the dHashes are unrelated.
  // Each pair carries its own pHash, identical within the pair. So the grouping
  // is a direct read-out of whether pHash reached the matcher.
  const rnd = (seed, bytes) => {
    const h = new Uint8Array(bytes);
    let x = (seed * 2654435761) >>> 0;
    for (let i = 0; i < bytes; i++) { x = (x * 1664525 + 1013904223) >>> 0; h[i] = (x >>> 16) & 0xff; }
    return h;
  };
  const entries = new Map();
  for (let pair = 0; pair < 30; pair++) {
    for (const half of [0, 1]) {
      const base12 = rnd(pair + 1, 18);
      const base8 = rnd(pair + 1, 8);
      if (half) { base12[5] ^= 0xF0; base8[5] ^= 0xF0; }   // 4 bits
      const pHashBits = new Uint8Array(8); pHashBits.fill(pair);
      entries.set(`p${pair}_${half}`, { base12, base8, pHashBits });
    }
  }
  const allIds = [...entries.keys()];
  const opts = { hamThresh: 2, withPHash: true, allIds, emitInterval: 5, lshForceMode: 'loose' };
  const norm = (groups) => groups.map(g => [...g].sort().join(',')).sort();

  const mainRes = await runMatching({ entries, ...opts });

  const w = new Worker('/js/worker-match.js', { type: 'module' });
  const workerRes = await new Promise((resolve, reject) => {
    w.onmessage = (ev) => {
      if (ev.data.type === 'done') resolve(ev.data);
      else if (ev.data.type === 'error') reject(new Error(ev.data.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'worker error'));
    const { payload: packed, transfer } = packEntries(entries);
    w.postMessage({ type: 'run', payload: { packed, ...opts } }, transfer);
  });
  w.terminate();

  // The control: the identical entries with pHash removed must NOT group, or
  // the fixture is matching on dHash and proves nothing about pHash.
  const stripped = new Map([...entries].map(([id, e]) => [id, { base12: e.base12, base8: e.base8 }]));
  const controlRes = await runMatching({ entries: stripped, ...opts });

  return {
    mainGroups: norm(mainRes.groups),
    workerGroups: norm(workerRes.groups),
    controlGroups: controlRes.groups.length,
  };
});

console.log(`  pHash groups: main ${ph.mainGroups.length}, worker ${ph.workerGroups.length}, control (no pHash) ${ph.controlGroups}`);
ck(ph.controlGroups === 0, '#84 control: without pHash these pairs are too far apart to group');
ck(ph.mainGroups.length === 30, `#84 pHash groups the 30 pairs on the main thread (got ${ph.mainGroups.length})`);
ck(JSON.stringify(ph.mainGroups) === JSON.stringify(ph.workerGroups), '#84 and the worker produces the IDENTICAL grouping');

// ---------------------------------------------------------------------------
// The same property with crop detection on (#86)
// ---------------------------------------------------------------------------
//
// cropHashes was not carried by the payload at all, so bestCropDist returned
// Infinity for every pair in the worker. Same class as #84, same blind spot:
// the parity fixture carried no optional fields.
const cr = await page.evaluate(async () => {
  const { runMatching, packEntries } = await import('/js/matcher.js');

  const rnd = (seed, n) => {
    const h = new Uint8Array(n);
    let x = (seed * 2654435761) >>> 0;
    for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; h[i] = (x >>> 16) & 0xff; }
    return h;
  };
  // 20 photo/crop pairs. Unrelated dHashes -- a crop shares no bands with its
  // original, which is the premise -- but the crop's own hash equals the
  // original's centre-region hash, and the colour/edge profile survives cropping.
  const entries = new Map();
  for (let p = 0; p < 20; p++) {
    const centre = rnd(1000 + p, 18);
    const colorHist = new Uint8Array(32).fill(80 + (p % 5));
    const edgeHist = new Uint8Array(16).fill(40 + (p % 5));
    entries.set(`orig${p}`, {
      base12: rnd(p + 1, 18), base8: rnd(p + 1, 8), colorHist, edgeHist,
      cropHashes: [{ name: 'center', hash: centre }],
    });
    const c2 = new Uint8Array(colorHist); c2[0] += 2;
    const e2 = new Uint8Array(edgeHist); e2[0] += 2;
    entries.set(`crop${p}`, {
      base12: centre, base8: rnd(500 + p, 8), colorHist: c2, edgeHist: e2,
      cropHashes: [{ name: 'center', hash: rnd(9000 + p, 18) }],
    });
  }
  const allIds = [...entries.keys()];
  const opts = { hamThresh: 8, withCropDetect: true, withColorMatch: true, allIds, emitInterval: 5, lshForceMode: 'loose' };
  const norm = (groups) => groups.map(g => [...g].sort().join(',')).sort();

  const mainRes = await runMatching({ entries, ...opts });

  const w = new Worker('/js/worker-match.js', { type: 'module' });
  const workerRes = await new Promise((resolve, reject) => {
    w.onmessage = (ev) => {
      if (ev.data.type === 'done') resolve(ev.data);
      else if (ev.data.type === 'error') reject(new Error(ev.data.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'worker error'));
    const { payload: packed, transfer } = packEntries(entries);
    w.postMessage({ type: 'run', payload: { packed, ...opts } }, transfer);
  });
  w.terminate();

  // The control: identical entries with the crop hashes removed must NOT group.
  const stripped = new Map([...entries].map(([id, e]) =>
    [id, { base12: e.base12, base8: e.base8, colorHist: e.colorHist, edgeHist: e.edgeHist }]));
  const controlRes = await runMatching({ entries: stripped, ...opts });

  // And crop detection on its own, with colour matching NOT ticked (#86).
  const aloneRes = await runMatching({ entries, ...opts, withColorMatch: false });

  return {
    mainGroups: norm(mainRes.groups),
    workerGroups: norm(workerRes.groups),
    controlGroups: controlRes.groups.length,
    aloneGroups: aloneRes.groups.length,
  };
});

console.log(`  crop groups: main ${cr.mainGroups.length}, worker ${cr.workerGroups.length}, control (no cropHashes) ${cr.controlGroups}, crop-only ${cr.aloneGroups}`);
ck(cr.controlGroups === 0, '#86 control: without cropHashes these pairs do not group');
ck(cr.mainGroups.length === 20, `#86 crop detection groups the 20 pairs on the main thread (got ${cr.mainGroups.length})`);
ck(JSON.stringify(cr.mainGroups) === JSON.stringify(cr.workerGroups), '#86 and the worker produces the IDENTICAL grouping');
ck(cr.aloneGroups === 20, `#86 crop detection works without colour matching ticked (got ${cr.aloneGroups})`);

console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(f ? 1 : 0);
