/*
 * Drive Dupe Destroyer (DDD) — tools/crop-frame-cost.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/crop-frame-cost.mjs
 */
// #118: the crop modal must not rescale the source image once per frame.
//
// The old animation loop called drawImage(originalImage, ...) on every frame,
// OUTSIDE the `if (selection)` guard -- so a 24 MP photograph was rescaled to
// the canvas 60 times a second for as long as the modal was open, whether or
// not anything was moving and whether or not there was a selection at all.
//
// Two kinds of check here, because timing alone is not trustworthy on shared
// hardware:
//
//   1. BEHAVIOURAL -- a sentinel pixel painted onto the image canvas survives
//      hundreds of ant frames. It could only survive if nothing repaints that
//      canvas. This is the check that actually pins the fix.
//   2. TIMING, against a control the harness runs itself: the same frame with
//      the old full drawImage restored, on the same canvases, in the same
//      page. A ratio, not an absolute, so it means something on CI hardware.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);

const out = await page.evaluate(async () => {
  const crop = await import('/js/crop.js');
  const { __test } = crop;

  // A 6000x4000 source -- 24 MP, the size of an ordinary phone or camera photo
  // and the case the old loop was rescaling every frame.
  //
  // It has to be a real <img>: getTransformedDimensions() reads naturalWidth /
  // naturalHeight, which a <canvas> does not have. Passing a canvas made the
  // crop canvas 0x0, and three of these checks then PASSED on nothing -- the
  // sentinel survived because there were no pixels to disturb. Hence the size
  // assertion below, so that can never quietly happen again.
  const scratch = document.createElement('canvas');
  scratch.width = 6000; scratch.height = 4000;
  const sctx = scratch.getContext('2d');
  const grad = sctx.createLinearGradient(0, 0, 6000, 4000);
  grad.addColorStop(0, '#3a6'); grad.addColorStop(1, '#249');
  sctx.fillStyle = grad; sctx.fillRect(0, 0, 6000, 4000);
  const blob = await new Promise(r => scratch.toBlob(r, 'image/jpeg', 0.6));
  const src = new Image();
  src.src = URL.createObjectURL(blob);
  await src.decode();

  const modal = document.getElementById('cropModal');
  modal.style.display = 'flex';
  document.getElementById('cropLoading').style.display = 'none';
  document.getElementById('cropCanvas').style.display = 'block';
  document.getElementById('cropOverlay').style.display = 'block';

  __test.mount(src);

  const canvas  = document.getElementById('cropCanvas');
  const overlay = document.getElementById('cropOverlay');
  const ctx = canvas.getContext('2d');

  const result = { srcW: src.naturalWidth, srcH: src.naturalHeight,
                   canvasW: canvas.width, canvasH: canvas.height,
                   overlayW: overlay.width, overlayH: overlay.height };

  __test.setSelection({ x: 40, y: 30, width: Math.round(canvas.width * 0.5),
                        height: Math.round(canvas.height * 0.5) });

  // --- 1. behavioural: does anything repaint the image canvas? -------------
  // A sentinel in a corner the selection does not cover.
  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(canvas.width - 4, canvas.height - 4, 4, 4);
  const readSentinel = () => {
    const d = ctx.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  };
  result.sentinelBefore = readSentinel();

  const FRAMES = 300;
  for (let i = 0; i < FRAMES; i++) __test.drawOverlay();
  result.sentinelAfterOverlayFrames = readSentinel();

  // The overlay itself IS being painted -- otherwise "nothing repaints the
  // image canvas" would also be true of a no-op.
  const octx = overlay.getContext('2d');
  const inDim = octx.getImageData(2, 2, 1, 1).data;
  result.overlayPainted = inDim[3] > 0;

  // --- 2. timing, against the old frame as a control -----------------------
  const timeIt = (fn, n) => {
    fn(); // warm
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    return (performance.now() - t0) / n;
  };

  const newFrame = () => __test.drawOverlay();
  const oldFrame = () => {
    // Exactly what the loop used to do first, every frame.
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(0);
    ctx.drawImage(src, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
    ctx.restore();
    __test.drawOverlay();
  };

  result.newMs = timeIt(newFrame, 120);
  result.oldMs = timeIt(oldFrame, 120);

  // --- 3. an idle frame, with no selection, must do no drawing -------------
  __test.setSelection(null);
  __test.drawOverlay();                    // the one clearing frame
  result.idleMs = timeIt(() => __test.drawOverlay(), 200);

  // --- 4. the dataset mirror is written on CHANGE, not only while animating -
  __test.stopAnts();
  __test.setSelection({ x: 11, y: 22, width: 123, height: 234 });
  __test.drawOverlay();
  result.mirrorWhileStopped = canvas.dataset.selection;
  __test.setSelection(null);
  __test.drawOverlay();
  result.mirrorCleared = canvas.dataset.selection === undefined;

  modal.style.display = 'none';
  return result;
});

console.log('   ', out);

ck(out.srcW === 6000 && out.canvasW > 100 && out.canvasH > 100,
   `#118 the fixture is a real 24 MP image on a real canvas (${out.srcW}x${out.srcH} -> ${out.canvasW}x${out.canvasH})`);
ck(out.overlayW === out.canvasW && out.overlayH === out.canvasH,
   `#118 the overlay tracks the image canvas exactly (${out.overlayW}x${out.overlayH})`);
ck(out.overlayPainted, '#118 the overlay really is being drawn');
ck(out.sentinelAfterOverlayFrames === out.sentinelBefore,
   `#118 300 ant frames leave the image canvas untouched (sentinel ${out.sentinelBefore} -> ${out.sentinelAfterOverlayFrames})`);
ck(out.newMs * 3 < out.oldMs,
   `#118 an ant frame is far cheaper than the old one: ${out.newMs.toFixed(3)}ms vs ${out.oldMs.toFixed(3)}ms `
   + `(${(out.oldMs / out.newMs).toFixed(1)}x)`);
ck(out.idleMs < out.newMs,
   `#118 with no selection a frame costs less still (${out.idleMs.toFixed(3)}ms)`);
ck(/^11,22,123,234$/.test(out.mirrorWhileStopped || ''),
   `#118 the selection mirror is written when the selection changes, not only while animating ("${out.mirrorWhileStopped}")`);
ck(out.mirrorCleared, '#118 and is dropped when the selection goes away');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
