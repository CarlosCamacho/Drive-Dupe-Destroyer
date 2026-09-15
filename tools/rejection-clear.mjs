/*
 * Drive Dupe Destroyer (DDD) — tools/rejection-clear.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/rejection-clear.mjs
 */
// #101: a "not a duplicate" decision must be reversible.
//
// rejection.js is storage plus a telemetry panel button, so the thing worth
// testing is whether the user can actually reach the clear — which means
// driving the real panel, not calling clearRejections() directly. Calling the
// function proved nothing: it always worked, it simply had no caller.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.evaluate(() => { window.confirm = () => true; });

const r = await page.evaluate(async () => {
  const rej = await import('/js/rejection.js');
  const tel = await import('/js/telemetry.js');
  const db = await import('/js/db.js');
  const paths = await import('/js/paths.js');
  const settle = () => new Promise(r => setTimeout(r, 120));

  const h = (fill) => { const a = new Uint8Array(18); a.fill(fill); return a; };
  const A = { base12: h(0x11) }, B = { base12: h(0x22) }, C = { base12: h(0x22) };

  await rej.clearRejections();
  await rej.recordRejection(A, B);
  const afterPress = (await rej.getRejectionStats()).count;

  // Keyed on the hash pair, so it reaches beyond the two files the user saw.
  const suppressesOther = await rej.isRejectedPair(A, C);

  // The full-reset button clears hashes and paths. It leaves user judgement
  // alone, which is right -- but then something else has to be able to clear it.
  await db.dbClearImages();
  await paths.clearPathCaches();
  const survivesFullReset = (await rej.getRejectionStats()).count;

  // Open the panel the way the ⚡ button does, with no scan having run.
  tel.hideTelemetry();
  await tel.showTelemetry();
  await settle();
  const btn = document.getElementById('btnClearRejections');
  const reachableBeforeAnyScan = !!btn;

  let afterClick = null, toldTheUser = null;
  if (btn) {
    btn.click();
    await settle();
    afterClick = (await rej.getRejectionStats()).count;
    toldTheUser = !!document.getElementById('btnClearRejections') === false;
  }

  // And it disappears once there is nothing to forget.
  await tel.showTelemetry();
  await settle();
  const hiddenWhenEmpty = !document.getElementById('btnClearRejections');

  tel.hideTelemetry();
  return { afterPress, suppressesOther, survivesFullReset, reachableBeforeAnyScan, afterClick, toldTheUser, hiddenWhenEmpty };
});

console.log('  ', r);
ck(r.afterPress === 1, '#101 one press of "not a duplicate" is recorded');
ck(r.suppressesOther === true, '#101 and it suppresses any pair sharing those hashes — which is why it must be reversible');
ck(r.survivesFullReset === 1, '#101 the full-reset button leaves it alone (hashes and paths only)');
ck(r.reachableBeforeAnyScan === true, '#101 the Clear action is in the telemetry panel before any scan has run');
ck(r.afterClick === 0, '#101 clicking it actually forgets them');
ck(r.hiddenWhenEmpty === true, '#101 and the action is gone once there is nothing to forget');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
