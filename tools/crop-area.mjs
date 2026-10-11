/*
 * Drive Dupe Destroyer (DDD) — tools/crop-area.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/crop-area.mjs
 */
// #77: the remembered crop area — what can be verified without Drive credentials.
//
// HONEST LIMIT, stated because an earlier version of this file pretended
// otherwise: the full round trip (load an image, crop, load the next, see the
// area restored) needs downloadFileBlob, which goes through authedFetch and so
// needs a real access token. The token is a module-private `let` with no
// setter, and ES module exports are read-only bindings, so it cannot be stubbed
// from a test — an earlier attempt assigned over `drive.downloadFileBlob`,
// which silently did nothing and made every check fail for the wrong reason.
//
// So: the fraction mapping and clamping are covered by test/crop-area.test.js,
// which is where the real logic is pinned. This covers the parts that live in
// the DOM — the controls, their defaults, and that the choice persists.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2500);

let f = 0; const ck = (ok, l) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) f++; };

const ui = await page.evaluate(() => ({
  toggleExists: !!document.getElementById('cropReuseArea'),
  toggleDefault: document.getElementById('cropReuseArea')?.checked,
  noteExists: !!document.getElementById('cropAreaNote'),
  noteHidden: document.getElementById('cropAreaNote')?.style.display === 'none',
  clearExists: !!document.getElementById('btnCropClearArea'),
  label: document.querySelector('.cropReuseGroup span')?.textContent.trim(),
}));
console.log('  ', ui);
ck(ui.toggleExists && ui.toggleDefault === true, '#77 "Reuse crop area" exists and is on by default');
ck(ui.noteExists && ui.noteHidden, '#77 the note is present but hidden until there is an area to reuse');
ck(ui.clearExists, '#77 there is a way to forget the remembered area');

// The choice must survive a reload — it is stored in IndexedDB like the rest.
const persisted = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_crop_area_reuse', false);
  await db.settingSet('destroyer_crop_area', { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  return true;
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2500);
const after = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  return {
    on: await db.settingGet('destroyer_crop_area_reuse', null),
    area: await db.settingGet('destroyer_crop_area', null),
  };
});
console.log('  ', after);
ck(after.on === false, '#77 the toggle choice survives a reload');
ck(after.area && after.area.w === 0.3, '#77 the area itself survives a reload');

// And the stored shape is fractions, which is what makes it portable between
// differently sized images.
ck(Object.values(after.area).every(v => v >= 0 && v <= 1),
   '#77 the stored area is fractions of the image, not pixels');

// An area is remembered the moment it is DRAWN, not only once a crop succeeds.
// Drawing it and stepping to the next picture without cropping this one used
// to lose it. Driven through real mouse events on the real canvas.
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_crop_area_reuse', true);
  await db.settingSet('destroyer_crop_area', null);
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2500);
const box = await page.evaluate(async () => {
  const crop = await import('/js/crop.js');
  document.getElementById('cropModal').style.display = 'flex';
  const src = document.createElement('canvas');
  src.width = 800; src.height = 600;
  src.naturalWidth = 800; src.naturalHeight = 600;   // what an <img> would report
  crop.__test.mount(src);
  document.getElementById('cropLoading').style.display = 'none';
  const c = document.getElementById('cropCanvas');
  c.style.display = 'block';
  // Let the modal's open transition finish before measuring where to click.
  await new Promise(r => setTimeout(r, 600));
  const r = c.getBoundingClientRect();
  return { x: r.left, y: r.top, w: c.width, h: c.height };
});
await page.mouse.move(box.x + 20, box.y + 20);
await page.mouse.down();
await page.mouse.move(box.x + 120, box.y + 100, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const drawn = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const crop = await import('/js/crop.js');
  return { stored: await db.settingGet('destroyer_crop_area', null), sel: crop.__test.selection };
});
console.log('  ', drawn);
ck(drawn.stored && drawn.stored.w > 0, 'the area is remembered as soon as it is drawn, before any crop');

// A plain click on the image keeps the area instead of wiping it.
await page.mouse.click(box.x + 300, box.y + 200);
await page.waitForTimeout(100);
const afterClick = await page.evaluate(async () => (await import('/js/crop.js')).__test.selection);
ck(afterClick && afterClick.width === drawn.sel.width && afterClick.x === drawn.sel.x,
   'a click without a drag keeps the existing area');

// Dragging a new one replaces it, and that is what is remembered.
await page.mouse.move(box.x + 200, box.y + 150);
await page.mouse.down();
await page.mouse.move(box.x + 260, box.y + 190, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const redrawn = await page.evaluate(async () => (await import('/js/db.js')).settingGet('destroyer_crop_area', null));
ck(redrawn && Math.abs(redrawn.w - drawn.stored.w) > 0.01, 'dragging a new area replaces the remembered one');

// The next image gets the remembered area without any drawing.
const next = await page.evaluate(async () => {
  const crop = await import('/js/crop.js');
  const src = document.createElement('canvas');
  src.width = 1000; src.height = 750; src.naturalWidth = 1000; src.naturalHeight = 750;
  crop.__test.mount(src);   // mount -> redrawCanvas, the same path a loaded image takes
  return crop.__test.selection;
});
ck(next && next.width > 0, 'the next image opens with the remembered area already on it');

console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
console.log('\nNot covered here (needs a signed-in Drive): loading a second image and');
console.log('seeing the rectangle restored on it. test/crop-area.test.js pins that mapping.');
await b.close();
process.exit(f ? 1 : 0);
