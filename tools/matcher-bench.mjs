/*
 * Drive Dupe Destroyer (DDD) — tools/matcher-bench.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Measures the matching phase AND guards it against regression (#69, #127).
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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = pw;

const BASELINE = fileURLToPath(new URL('./matcher-bench.baseline.json', import.meta.url));
const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const sizeArg = args.find(a => /^\d+$/.test(a));
// The guard runs at ONE fixed size, so the baseline compares like with like.
const GUARD_N = 6000;
const N = sizeArg ? Number(sizeArg) : GUARD_N;
const GUARDING = !sizeArg;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
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

  // A machine-speed yardstick, timed in this same page on this same run.
  // Every number below is reported as a MULTIPLE of this, so a baseline
  // recorded on one machine still means something on another. The loop is
  // deliberately ordinary integer and typed-array work -- the same shape as the
  // Hamming inner loop -- rather than anything the JIT can elide.
  const calibrate = () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) & 0xff;
    const t0 = performance.now();
    let acc = 0;
    for (let pass = 0; pass < 3000; pass++) {
      for (let i = 0; i < buf.length; i++) acc = (acc + (buf[i] ^ pass)) & 0xffff;
    }
    const ms = performance.now() - t0;
    return { ms, acc };
  };
  const calib = calibrate();

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

  // --- the comparator on its own -------------------------------------------
  //
  // The matching pass above is dominated by index construction, Map work,
  // union-find and emission: an 8x slowdown injected into hammingBytes32 moved
  // its score by only 1.13x, which is well inside any tolerance worth having.
  // The distance functions are the hottest pure code in the app and the part
  // most likely to be "optimised" into something slower, so they get their own
  // measurement where nothing else can hide them.
  const { bestDist } = await import('/js/common.js');
  const pairs = [];
  {
    const ids = [...entries.keys()];
    for (let i = 0; i < 150000; i++) {
      pairs.push([entries.get(ids[i % ids.length]), entries.get(ids[(i * 7919) % ids.length])]);
    }
  }
  const tD0 = performance.now();
  let distAcc = 0;
  for (const [a, c] of pairs) distAcc += bestDist(a, c, false, true);
  const distMs = performance.now() - tD0;

  return {
    n: N,
    calibMs: calib.ms,
    dist: { ms: distMs, pairs: pairs.length, acc: distAcc },
    main: { ms: mainThread.ms, worstGap: mainThread.worstGap, fps: mainThread.fps, groups: mainThread.r.groups.length, emitted: mainEmitted },
    worker: { ms: worker.ms, worstGap: worker.worstGap, fps: worker.fps, groups: worker.r.groups.length, emitted: workerEmitted },
  };
}, N);

console.log(`images: ${out.n}`);
console.log(`  main thread (yielding):  ${String(out.main.ms).padStart(6)}ms   worst frame gap ${String(out.main.worstGap).padStart(4)}ms   ~${out.main.fps} fps   ${out.main.groups} groups   ${out.main.emitted} emissions`);
console.log(`  worker:                  ${String(out.worker.ms).padStart(6)}ms   worst frame gap ${String(out.worker.worstGap).padStart(4)}ms   ~${out.worker.fps} fps   ${out.worker.groups} groups   ${out.worker.emitted} emissions`);
console.log(`  same grouping: ${out.main.groups === out.worker.groups}`);
console.log(`  wall clock:    ${(out.main.ms / out.worker.ms).toFixed(2)}x faster in the worker`);
console.log(`  bestDist:      ${out.dist.ms.toFixed(1)}ms over ${out.dist.pairs.toLocaleString()} pairs`);
console.log(`  calibration:   ${out.calibMs.toFixed(1)}ms for the yardstick loop`);

await b.close();

// ---------------------------------------------------------------------------
// The guard (#127)
// ---------------------------------------------------------------------------
if (!GUARDING) {
  console.log(`\n(exploring at n=${out.n}; the baseline guard only runs at n=${GUARD_N})`);
  process.exit(0);
}

// Scores, not milliseconds. Dividing by the calibration loop measured in the
// same run is what makes a stored baseline portable across machines.
const score = {
  workerMs: out.worker.ms / out.calibMs,
  mainMs: out.main.ms / out.calibMs,
  distMs: out.dist.ms / out.calibMs,
};

// --- assertions that need no baseline at all -------------------------------
// These are the ones that actually catch the documented 7x transport
// regression, and they are machine-independent, so they are the ones to trust
// first if the scored checks ever get noisy.
ck(out.main.groups === out.worker.groups,
   `#127 worker and main thread agree on the grouping (${out.worker.groups} vs ${out.main.groups})`);
ck(out.dist.acc > 0,
   `#127 the comparator really ran (summed distance ${out.dist.acc}) — a loop optimised away would time fast and mean nothing`);
ck(out.worker.emitted > 0 && out.main.emitted > 0,
   `#127 both sides really emitted (${out.main.emitted} / ${out.worker.emitted}) — an empty run would time fast and mean nothing`);
ck(out.worker.ms <= out.main.ms,
   `#127 the worker is not slower than the yielding main thread (${out.worker.ms}ms vs ${out.main.ms}ms)`);
ck(out.worker.worstGap < out.main.worstGap,
   `#127 and it holds the UI thread for less time (worst frame gap ${out.worker.worstGap}ms vs ${out.main.worstGap}ms)`);

// --- the scored baseline ---------------------------------------------------
// Tolerances per metric, set from measured run-to-run spread rather than
// picked. Over five consecutive runs on this machine the end-to-end passes
// varied 0.95-1.21x and the comparator 0.77-1.30x at 20,000 pairs; the
// comparator loop was lengthened to 150,000 pairs specifically so its spread
// would tighten enough to justify a smaller tolerance.
//
// The end-to-end numbers stay loose on purpose: they are dominated by index
// construction, Map work, union-find and emission, and they run on shared CI
// hardware. They are for catching a 7x, not a 7%. The comparator is a tight
// loop over fixed data, so it can be held to a tighter figure -- which matters,
// because an 8x slowdown injected into hammingBytes32 moves the END-TO-END
// score by only 1.13x and would sail through any tolerance worth having there.
const TOLERANCE = { workerMs: 2.5, mainMs: 2.5, distMs: 1.6 };

if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({
    n: GUARD_N,
    tolerance: TOLERANCE,
    recordedAt: new Date().toISOString().slice(0, 10),
    note: "Scores are ms divided by the calibration loop measured in the same run, "
        + "so they are comparable across machines. Re-record with --update only when a "
        + "change is MEANT to move them, and say why in the commit.",
    score,
  }, null, 2) + '\n');
  console.log(`\nBaseline ${existsSync(BASELINE) && !UPDATE ? 'created' : 'updated'}: `
    + `worker ${score.workerMs.toFixed(2)}, main ${score.mainMs.toFixed(2)} (calibration units)`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
for (const [key, label] of [
  ['workerMs', 'the worker matching pass'],
  ['mainMs',   'the main-thread matching pass'],
  ['distMs',   `bestDist over ${out.dist.pairs.toLocaleString()} pairs`],
]) {
  const now = score[key], was = base.score[key];
  const ratio = now / was;
  const tol = TOLERANCE[key];
  ck(ratio <= tol,
     `#127 ${label} is within ${tol}x of the baseline `
     + `(${now.toFixed(2)} vs ${was.toFixed(2)} calibration units, ${ratio.toFixed(2)}x)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
