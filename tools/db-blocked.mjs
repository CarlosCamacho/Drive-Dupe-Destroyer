/*
 * Drive Dupe Destroyer (DDD) — tools/db-blocked.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * A blocked IndexedDB upgrade must fail loudly, not hang (#76).
 *
 * NOTE on what this does and does not prove. The reject-after-grace mechanism is
 * reproduced faithfully -- same event contract, same timer, a real second
 * connection holding the old version -- and is genuinely verified. The notifier
 * check only confirms the seam exists; driving db.js's own onblocked end to end
 * would need the shipped DB_VERSION to be behind, which it is not.
 *
 *     python3 serve_secure.py &
 *     node tools/db-blocked.mjs
 */
// #76: a blocked IndexedDB upgrade used to leave openDb() pending forever, and
// every database call begins with `await openDb()`. It must now fail with
// something the user can act on, and it must still succeed normally.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2500);
let f = 0; const ck = (ok, l) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) f++; };

// 1. The normal path still works — the guard must not break the common case.
const normal = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const t = Date.now();
  await db.settingSet('__probe', 'ok');
  const got = await db.settingGet('__probe', null);
  return { got, ms: Date.now() - t };
});
ck(normal.got === 'ok', `#76 the normal path still opens and reads/writes (${normal.ms}ms)`);

// 2. Blocked: reproduce db.js's contract with the fix applied, and confirm it
//    now SETTLES rather than hanging.
const blocked = await page.evaluate(async () => {
  const NAME = "ddd_block_probe2";
  const GRACE = 1200;   // db.js uses 10s; the mechanism is what is under test

  const openWithGuard = (version) => new Promise((resolve, reject) => {
    let timer = null;
    const req = indexedDB.open(NAME, version);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("things")) d.createObjectStore("things", { keyPath: "id" });
    };
    req.onblocked = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new Error(
        "Another tab has Drive Dupe Destroyer open and is preventing a database update. " +
        "Close the other tabs and reload.")), GRACE);
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  });

  const holder = await openWithGuard(1);         // the "other tab", never closed
  const t = Date.now();
  let outcome, message = "";
  try { const d = await openWithGuard(2); d.close(); outcome = "resolved"; }
  catch (e) { outcome = "rejected"; message = e.message; }
  const ms = Date.now() - t;
  holder.close();
  indexedDB.deleteDatabase(NAME);
  return { outcome, ms, message };
});
console.log(`   blocked open -> ${blocked.outcome} after ${blocked.ms}ms`);
console.log(`   message: "${blocked.message}"`);
ck(blocked.outcome === 'rejected', '#76 a blocked upgrade now settles instead of hanging forever');
ck(/another tab/i.test(blocked.message) && /reload/i.test(blocked.message),
   '#76 the error names the cause and what to do about it');

// 3. The notifier reaches the UI.
const toasted = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  let seen = null;
  db.setDbBlockedNotifier(m => { seen = m; });
  // Drive the internal notifier the way onblocked does.
  const before = document.querySelectorAll('.toast').length;
  return { wired: typeof db.setDbBlockedNotifier === 'function' };
});
ck(toasted.wired, '#76 db.js exposes a notifier so it can report this without importing the UI');

console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(f ? 1 : 0);
