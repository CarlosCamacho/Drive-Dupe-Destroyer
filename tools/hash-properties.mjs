/*
 * Drive Dupe Destroyer (DDD) — tools/hash-properties.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/hash-properties.mjs
 */
// The hashing core, driven end to end through the real worker (#97).
//
// js/worker-hash.js computes every hash the rest of the app reasons about, and
// had no coverage of any kind. It cannot be imported: it is a worker script
// whose entire surface is `self.onmessage`, and it needs OffscreenCanvas and
// createImageBitmap. So this drives it exactly as js/hashing.js does — by
// posting a real ImageBitmap and reading the hashes back.
//
// These are PROPERTIES, not golden values. A golden hash would pin this to one
// browser's resampling; what matters is the relationships the matcher relies on.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);

const r = await page.evaluate(async () => {
  const { bestCropDist, hammingBytes32 } = await import('/js/distance.js');

  const w = new Worker(new URL('/js/worker-hash.js', location.href), { type: 'module' });
  let id = 0; const pend = new Map();
  w.onmessage = (ev) => { const p = pend.get(ev.data.id); if (p) { pend.delete(ev.data.id); p(ev.data); } };
  const hash = (bitmap, opts = {}) => new Promise((res) => {
    const myId = ++id; pend.set(myId, res);
    w.postMessage({ id: myId, bitmap, withVariants: false, withCropDetect: false,
                    withColorMatch: false, withPHash: false, withRotation: false, ...opts }, [bitmap]);
  });

  // A structured picture with real horizontal gradients, so dHash has something
  // to bite on. `alpha` leaves the background transparent instead of white.
  function paint(ctx, W, H, { alpha = false } = {}) {
    if (!alpha) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = `hsl(${i * 45}, 70%, ${20 + i * 7}%)`;
      ctx.fillRect((i % 4) * W / 4, Math.floor(i / 4) * H / 2, W / 4, H / 2);
    }
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, W / 60);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, H); ctx.stroke();
    ctx.beginPath(); ctx.arc(W * 0.7, H * 0.3, W * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
  }
  const bitmapOf = async (W, H, draw) => {
    const c = new OffscreenCanvas(W, H);
    draw(c.getContext('2d'), W, H);
    return await createImageBitmap(c);
  };
  const make = (W, H, opts) => bitmapOf(W, H, (ctx) => paint(ctx, W, H, opts));
  const makeCrop = (W, H) => bitmapOf(Math.round(W * 0.6), Math.round(H * 0.6), async () => {});

  const out = {};

  // --- determinism, and the pooled canvas not leaking between images --------
  const a1 = await hash(await make(800, 600));
  await hash(await make(640, 640));                   // a different image in between
  const a2 = await hash(await make(800, 600));
  out.sameImageTwice = hammingBytes32(a1.base12, a2.base12);

  // --- transparency, composited onto white ---------------------------------
  // A PNG with alpha and its JPEG export are the single most common way a real
  // duplicate pair arises. The pooled canvas fills white before drawing for
  // exactly this reason; with a transparent base the pair measured 22/144,
  // beyond even the loosest threshold, so it could never match at ANY setting.
  //
  // The shapes must NOT cover the canvas, or there is no transparency to test
  // and the check passes for the wrong reason -- which is what the first
  // version of this harness did, and only removing the white fill and watching
  // it still pass revealed it.
  const sparse = (ctx, W, H) => {
    ctx.fillStyle = '#1b3a6b';
    ctx.fillRect(W * 0.08, H * 0.12, W * 0.34, H * 0.30);
    ctx.fillStyle = '#c8452d';
    ctx.beginPath(); ctx.arc(W * 0.70, H * 0.34, W * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#123'; ctx.lineWidth = Math.max(3, W / 50);
    ctx.beginPath(); ctx.moveTo(W * 0.12, H * 0.82); ctx.lineTo(W * 0.88, H * 0.62); ctx.stroke();
    ctx.fillStyle = '#e8b21f';
    ctx.fillRect(W * 0.30, H * 0.66, W * 0.18, H * 0.20);
  };
  const withAlpha = await hash(await bitmapOf(800, 600, sparse));
  const flattened = await hash(await bitmapOf(800, 600, (ctx, W, H) => {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    sparse(ctx, W, H);
  }));
  out.transparentVsFlattened = hammingBytes32(withAlpha.base12, flattened.base12);

  // A control: the same drawing flattened onto BLACK must NOT match, or the
  // check above would pass for any pair of images at all.
  const onBlack = await hash(await bitmapOf(800, 600, (ctx, W, H) => {
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, W, H);
    sparse(ctx, W, H);
  }));
  out.transparentVsBlackFlattened = hammingBytes32(withAlpha.base12, onBlack.base12);

  // --- scale invariance -----------------------------------------------------
  const half = await hash(await make(400, 300), { withPHash: true });
  const full = await hash(await make(800, 600), { withPHash: true });
  out.dHashHalfSize = hammingBytes32(full.base12, half.base12);
  out.pHashHalfSize = hammingBytes32(full.pHashBits, half.pHashBits);

  // --- a real crop against the original's crop hashes -----------------------
  const src = await bitmapOf(800, 600, (ctx, W, H) => paint(ctx, W, H));
  const cropBmp = await (async () => {
    const s = new OffscreenCanvas(800, 600);
    paint(s.getContext('2d'), 800, 600);
    const cw = 480, ch = 360;
    const c = new OffscreenCanvas(cw, ch);
    c.getContext('2d').drawImage(s, 160, 120, cw, ch, 0, 0, cw, ch);
    return await createImageBitmap(c);
  })();
  const orig = await hash(src, { withCropDetect: true });
  const crop = await hash(cropBmp, { withCropDetect: true });
  out.cropVsOriginalPlainDHash = hammingBytes32(orig.base12, crop.base12);
  out.bestCropDist = bestCropDist(orig, crop);
  out.cropMatchesCenter60 = hammingBytes32(
    crop.base12, orig.cropHashes.find(c => c.name === 'center60').hash);

  // --- rotation variants ----------------------------------------------------
  const withRot = await hash(await make(800, 600), { withRotation: true });
  const rot90 = await hash(await (async () => {
    const s = new OffscreenCanvas(800, 600);
    paint(s.getContext('2d'), 800, 600);
    const c = new OffscreenCanvas(600, 800);
    const ctx = c.getContext('2d');
    ctx.translate(300, 400); ctx.rotate(Math.PI / 2); ctx.drawImage(s, -400, -300);
    return await createImageBitmap(c);
  })());
  out.rot90VsPlainDHash = hammingBytes32(withRot.base12, rot90.base12);
  out.rot90VsBestVariant = Math.min(...withRot.variants.map(v => hammingBytes32(v.base12, rot90.base12)));

  // --- discrimination floor on unrelated pictures ---------------------------
  // pHash was inert until #84, so this is the first time its calibration has
  // been measured against anything. The matcher's pHash threshold is
  // ceil(hamThresh * 64 / 144), which is 9 at the loosest sensitivity (20).
  const rnd = (s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const picture = (seed) => bitmapOf(512, 384, (ctx, W, H) => {
    const R = rnd(seed + 1);
    ctx.fillStyle = `hsl(${R() * 360},${30 + R() * 60}%,${20 + R() * 60}%)`;
    ctx.fillRect(0, 0, W, H);
    const n = 6 + Math.floor(R() * 18);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `hsl(${R() * 360},${40 + R() * 55}%,${10 + R() * 80}%)`;
      const x = R() * W, y = R() * H, s = 20 + R() * 220;
      if (R() < 0.5) ctx.fillRect(x, y, s, s * (0.3 + R()));
      else { ctx.beginPath(); ctx.arc(x, y, s / 2, 0, Math.PI * 2); ctx.fill(); }
    }
    for (let i = 0; i < 5; i++) {
      ctx.strokeStyle = `hsl(${R() * 360},70%,${20 + R() * 60}%)`;
      ctx.lineWidth = 1 + R() * 10;
      ctx.beginPath(); ctx.moveTo(R() * W, R() * H); ctx.lineTo(R() * W, R() * H); ctx.stroke();
    }
  });
  const hs = [];
  for (let i = 0; i < 24; i++) hs.push(await hash(await picture(i * 7919), { withPHash: true }));
  let pMin = Infinity, dMin = Infinity, pairs = 0;
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
    pairs++;
    pMin = Math.min(pMin, hammingBytes32(hs[i].pHashBits, hs[j].pHashBits));
    dMin = Math.min(dMin, hammingBytes32(hs[i].base12, hs[j].base12));
  }
  out.unrelatedPairs = pairs;
  out.pHashFloor = pMin;
  out.dHashFloor = dMin;

  w.terminate();
  return out;
});

console.log('  ', r);

ck(r.sameImageTwice === 0, 'the same image hashes identically, with another image hashed in between');
ck(r.transparentVsFlattened === 0, 'a transparent image and its white-flattened copy hash identically');
ck(r.transparentVsBlackFlattened > 8, `control: the same drawing on BLACK does not match (${r.transparentVsBlackFlattened} bits apart)`);
ck(r.dHashHalfSize === 0, 'dHash is scale-invariant (same picture at half size)');
ck(r.pHashHalfSize === 0, 'pHash is scale-invariant');
ck(r.cropVsOriginalPlainDHash > 8, 'the crop fixture is genuinely out of plain dHash range');
ck(r.bestCropDist === 0, 'a centre crop matches the original through its crop hashes');
ck(r.cropMatchesCenter60 === 0, "and specifically against the original's center60 region");
ck(r.rot90VsPlainDHash > 8, 'the rotation fixture is genuinely out of plain dHash range');
ck(r.rot90VsBestVariant === 0, 'a 90-degree re-save matches one of the rotation variants exactly');

// The loosest sensitivity the UI offers is hamThresh 20 -> a pHash threshold of
// 9. A floor at or below that would mean pHash grouping unrelated photographs.
ck(r.pHashFloor > 9, `pHash separates unrelated pictures (floor ${r.pHashFloor} over ${r.unrelatedPairs} pairs, threshold 9)`);
ck(r.dHashFloor > 20, `dHash separates unrelated pictures (floor ${r.dHashFloor}, loosest threshold 20)`);

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
