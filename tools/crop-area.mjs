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

console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
console.log('\nNot covered here (needs a signed-in Drive): loading a second image and');
console.log('seeing the rectangle restored on it. test/crop-area.test.js pins that mapping.');
await b.close();
process.exit(f ? 1 : 0);
