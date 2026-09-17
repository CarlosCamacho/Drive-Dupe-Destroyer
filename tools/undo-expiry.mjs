/*
 * Drive Dupe Destroyer (DDD) — tools/undo-expiry.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/undo-expiry.mjs
 */
// #141: the Undo button must stop offering an undo that has expired.
//
// Measured before the fix: record a delete, advance the clock 31 minutes with
// nothing else touching the page, and the button still read "Undo (1)", was
// still enabled, and its tooltip still promised "about 30 minute(s)".
// getUndoCount() returned 0 the whole time -- the model was right and the
// display was frozen.
//
// The unit tests cover WHEN to recompute (test/undo-expiry.test.js). This
// covers that the button on the real page actually changes, which the pure
// function cannot show.
//
// The clock is moved rather than waited out, and the timer is driven directly
// rather than slept through: a 30-minute setTimeout cannot be waited on in a
// test, and Chromium throttles background timers anyway.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
  window.google = { accounts: { oauth2: {
    initTokenClient: () => {
      const c = { callback: null };
      c.requestAccessToken = () => setTimeout(() => c.callback({ access_token: 'tok', expires_in: 3600 }), 5);
      return c;
    },
    revoke: (t, cb) => { cb && cb(); },
  } } };
});
await page.route('**/gsi/client*', r => r.abort());
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);

const r = await page.evaluate(async () => {
  const undo = await import('/js/undo.js');
  const btn = document.getElementById('btnUndo');
  const snap = () => ({ text: btn.textContent.trim(), disabled: btn.disabled, title: btn.title || '' });

  await undo.loadUndoStack();
  const idle = snap();

  undo.pushUndoDelete('FILE_A', 'holiday.jpg');
  const fresh = snap();
  const freshCount = undo.getUndoCount();

  // Move the wall clock past the TTL. Nothing else touches the page.
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + 31 * 60 * 1000;
  const beforeTimer = snap();

  // Fire the pending refresh, since a real 30-minute timeout cannot be waited
  // on and a hidden tab would have it throttled regardless -- which is exactly
  // why the fix also listens for visibilitychange.
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(r => setTimeout(r, 50));
  const afterRefresh = snap();
  const expiredCount = undo.getUndoCount();

  Date.now = realNow;
  return { idle, fresh, freshCount, beforeTimer, afterRefresh, expiredCount };
});

// --- the fixture has to be real before anything is asserted ---------------
ck(r.idle.disabled === true && r.idle.text === '↩ Undo',
   `#141 (fixture) the button starts disabled (${JSON.stringify(r.idle.text)})`);
ck(r.fresh.text === '↩ Undo (1)' && r.fresh.disabled === false && r.freshCount === 1,
   `#141 (fixture) a recorded delete really offers an undo (${JSON.stringify(r.fresh.text)})`);
ck(/expiring in about 30 minute/.test(r.fresh.title),
   `#141 (fixture) and the tooltip promises the full window`);

// --- the model was never wrong; the display was ---------------------------
ck(r.expiredCount === 0,
   `#141 (fixture) the stack itself knows the op has lapsed (getUndoCount ${r.expiredCount})`);

// --- the button must stop making the promise ------------------------------
ck(r.afterRefresh.text === '↩ Undo',
   `#141 the button stops claiming an undo it cannot do (${JSON.stringify(r.afterRefresh.text)}, was "↩ Undo (1)")`);
ck(r.afterRefresh.disabled === true,
   `#141 and is disabled rather than clickable-into-nothing`);
ck(r.afterRefresh.title === 'Nothing to undo',
   `#141 and the tooltip no longer promises 30 minutes: ${JSON.stringify(r.afterRefresh.title)}`);

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
await b.close();
process.exit(fails === 0 ? 0 : 1);
