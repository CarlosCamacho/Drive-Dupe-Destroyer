/*
 * Drive Dupe Destroyer (DDD) — tools/trash-partial.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/trash-partial.mjs
 */
// #81 and #82: what the trash queue and the auth paths do when the session
// dies part-way through.
//
// These need a real page: auth.js keeps its token in module state that only the
// browser instance owns, and the behaviour under test is a race between a GIS
// callback and the code that clears that state. Note that the fake GIS below
// is installed via addInitScript and the real gsi/client script is aborted --
// otherwise Google's own bundle overwrites window.google after we set it.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';
let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.route('**/gsi/client*', r => r.abort());

await page.addInitScript(() => {
  window.__gisOk = true;
  window.__grants = 0;          // every trip to GIS, successful or not
  window.__gisLatency = 5;
  window.__tokenTtl = 3600;
  window.google = { accounts: { oauth2: {
    initTokenClient: () => {
      const c = { callback: null };
      c.requestAccessToken = () => setTimeout(() => {
        window.__grants++;
        if (window.__gisOk) c.callback({ access_token: 'tok' + window.__grants, expires_in: window.__tokenTtl });
        else c.callback({ error: 'interaction_required' });
      }, window.__gisLatency);
      return c;
    },
    revoke: (t, cb) => { (window.__revoked ||= []).push(t); cb && cb(); },
  } } };
  // processQueue now awaits the in-app confirm dialog rather than a native
  // confirm() (#109), so `window.confirm = () => true` does nothing here any
  // more -- there are no native confirms left in js/. Answer the real dialog
  // instead, which is what the old stub effectively did.
  setInterval(() => {
    document.querySelector('#confirmModal [data-confirm="ok"]')?.click();
  }, 30);
});

await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.evaluate(async (id) => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_oauth_client_id', id);
}, CLIENT_ID);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);

// ---------------------------------------------------------------------------
// #81 — the session expires between chunks of a 250-file queue run
// ---------------------------------------------------------------------------
const queueRun = (mode) => page.evaluate(async (mode) => {
  const db = await import('/js/db.js');
  const q = await import('/js/queue.js');
  const undo = await import('/js/undo.js');
  const auth = await import('/js/auth.js');

  await db.queueClear();
  await undo.loadUndoStack();
  const undoBefore = undo.getUndoFileCount();

  const ids = Array.from({ length: 250 }, (_, i) => 'file' + String(i).padStart(4, '0'));
  for (const id of ids) await db.queueAdd({ id, name: id + '.jpg', size: 1000, path: '/x' });

  // A one-second token, so every ensureValidToken really does go back to GIS.
  window.__tokenTtl = 1;
  await auth.signOut();
  window.__gisOk = true;
  window.__grants = 0;

  const trashedForReal = [];
  let batches = 0, patches = 0;
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/batch/drive/v3')) {
      batches++;
      const parts = [...String(opts.body || '').matchAll(/^Content-ID: (.+)$/gm)].map(m => m[1].trim());
      // mode "batch": the first batch succeeds, then the session dies.
      // mode "fallback": the endpoint itself is down, so batchTrash degrades to
      // per-file PATCHes -- and the session dies on the first of them.
      if (mode === 'fallback') { window.__gisOk = false; return new Response('', { status: 503 }); }
      parts.forEach(id => trashedForReal.push(id));
      window.__gisOk = false;
      const bound = 'batch_resp';
      return new Response(
        parts.map(id => `--${bound}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n`).join('') + `--${bound}--`,
        { status: 200, headers: { 'Content-Type': `multipart/mixed; boundary=${bound}` } });
    }
    if (u.includes('/drive/v3/files/')) { patches++; return new Response('{"error":{"code":401}}', { status: 401 }); }
    return realFetch(url, opts);
  };

  let trashedEvent = 0;
  const onTrashed = (e) => { trashedEvent += e.detail.ids.length; };
  window.addEventListener('ddd:trashed', onTrashed);
  await q.processQueue();
  window.removeEventListener('ddd:trashed', onTrashed);
  window.fetch = realFetch;

  await undo.loadUndoStack();
  return {
    batches, patches,
    trashedForReal: trashedForReal.length,
    stillInQueue: (await db.queueList()).length,
    undoRecorded: undo.getUndoFileCount() - undoBefore,
    trashedEvent,
    grants: window.__grants,
  };
}, mode);

const a = await queueRun('batch');
console.log('   ', a);
ck(a.trashedForReal === 100, '#81 the run really trashed the first chunk before the session died');
ck(a.undoRecorded === a.trashedForReal, '#81 every file actually trashed is recorded for Undo');
ck(a.stillInQueue === 250 - a.trashedForReal, '#81 trashed files leave the queue; the untried ones stay');
ck(a.trashedEvent === a.trashedForReal, '#81 ddd:trashed fires for what was trashed, so the results view updates');

// The per-file fallback must stop once the session is gone rather than issuing
// a doomed PATCH -- and a fresh doomed GIS attempt -- for each of 100 ids.
const c = await queueRun('fallback');
console.log('   ', c);
// No PATCH reaches the network in this scenario either way -- driveFetch's own
// ensureValidToken fails first -- so the cost of NOT stopping is measured where
// it actually lands: two doomed GIS attempts per file. 204 without the guard, 4
// with it.
ck(c.grants <= 6, `#81 the fallback stops on a dead session instead of re-asking GIS per file (${c.grants} attempts)`);
ck(c.patches === 0, '#81 and issues no doomed PATCH');
ck(c.stillInQueue === 250, '#81 nothing was trashed, so nothing leaves the queue');
ck(c.undoRecorded === 0, '#81 and nothing false is recorded for Undo');

// ---------------------------------------------------------------------------
// #82 — signing out while a token request is in flight
// ---------------------------------------------------------------------------
const s = await page.evaluate(async () => {
  const auth = await import('/js/auth.js');
  window.__tokenTtl = 3600;
  window.__gisOk = true;
  window.__gisLatency = 400;
  await auth.signOut();
  window.__revoked = [];

  const p = auth.ensureToken().catch(e => e);
  await new Promise(r => setTimeout(r, 80));
  await auth.signOut();                         // user signs out mid-flight
  const atSignOut = { token: auth.getAccessToken(), signedIn: !!auth.isSignedIn() };
  await new Promise(r => setTimeout(r, 700));   // the GIS callback lands in here
  const err = await p;
  // Read the state BEFORE signing in again, or the fresh token masks the bug.
  const after = { token: auth.getAccessToken(), signedIn: !!auth.isSignedIn() };

  // And a fresh sign-in afterwards must still work.
  window.__gisLatency = 5;
  await auth.ensureToken();
  return {
    atSignOut,
    after,
    superseded: err?.authError === 'superseded',
    recoverable: err?.recoverable === true,
    revokedSuperseded: (window.__revoked || []).length,
    signsInAgain: !!auth.isSignedIn(),
  };
});
console.log('   ', s);
ck(!s.atSignOut.signedIn && s.atSignOut.token === null, '#82 sign-out clears the token immediately');
ck(!s.after.signedIn && s.after.token === null, '#82 and the in-flight GIS callback does NOT sign the user back in');
ck(s.superseded && s.recoverable, '#82 the superseded request rejects recoverably, so the Client ID survives');
ck(s.revokedSuperseded >= 1, '#82 the token minted for the ended session is revoked, not left live');
ck(s.signsInAgain, '#82 a fresh sign-in afterwards still works');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
