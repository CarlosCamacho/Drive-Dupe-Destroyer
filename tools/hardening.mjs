/*
 * Drive Dupe Destroyer (DDD) — tools/hardening.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/hardening.mjs
 */
// The v14.8.1 hardening pass, checked through the real UI.
//
// Every check here drives the page the way a user would -- clicks, keys, the
// real confirmation dialog -- against a fake Drive, and reads the outcome from
// what the app recorded or rendered. Run against v14.8.0, each one fails.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';
let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// --- the service worker installs, and a first visit does not reload ---------
{
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  let navigations = 0;
  page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++; });
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
  const sw = await page.evaluate(async () => {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(r => setTimeout(() => r(null), 8000)),
    ]);
    return { active: !!reg?.active, state: reg?.active?.state || null };
  });
  await page.waitForTimeout(2500);
  ck(sw.active, `the service worker installs and activates (${sw.state})`);
  ck(navigations === 1, `a first visit is not reloaded by the activating worker (${navigations} navigation(s))`);
  await ctx.close();
}

// --- the results page ------------------------------------------------------
const ctx = await b.newContext();
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.route('**/gsi/client*', r => r.abort());
await page.addInitScript(() => {
  window.__gisOk = true;
  window.__tokenTtl = 3600;
  window.google = { accounts: { oauth2: {
    initTokenClient: () => {
      const c = { callback: null };
      c.requestAccessToken = () => setTimeout(() => {
        if (window.__gisOk) c.callback({ access_token: 'tok', expires_in: window.__tokenTtl });
        else c.callback({ error: 'interaction_required' });
      }, 5);
      return c;
    },
    revoke: (t, cb) => { cb && cb(); },
  } } };
});
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.evaluate(async (id) => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_oauth_client_id', id);
}, CLIENT_ID);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);

// Fake Drive: record trash and restore PATCHes; the batch endpoint can be told
// to let the session die after its first chunk.
await page.evaluate(async () => {
  const auth = await import('/js/auth.js');
  await auth.ensureToken({ forcePrompt: true });
  window.__trashed = [];
  window.__restored = [];
  window.__dieAfterFirstBatch = false;
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/batch/drive/v3')) {
      const parts = [...String(opts.body || '').matchAll(/^Content-ID: (.+)$/gm)].map(m => m[1].trim());
      parts.forEach(id => window.__trashed.push(id));
      if (window.__dieAfterFirstBatch) { window.__gisOk = false; window.__tokenTtl = 1; }
      const bound = 'batch_resp';
      return new Response(
        parts.map(id => `--${bound}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n`).join('') + `--${bound}--`,
        { status: 200, headers: { 'Content-Type': `multipart/mixed; boundary=${bound}` } });
    }
    if (u.includes('/drive/v3/files/') && opts?.method === 'PATCH') {
      const id = u.split('/files/')[1].split('?')[0];
      if (String(opts.body || '').includes('"trashed":false')) window.__restored.push(id);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('thumbnail') || u.includes('alt=media')) return new Response('', { status: 404 });
    return realFetch(url, opts);
  };
});

const render = (groupCount, perGroup = 2) => page.evaluate(async ({ groupCount, perGroup }) => {
  const render = await import('/js/render.js');
  const ui = await import('/js/ui.js');
  ui.setSignedInUi(true, 'x');
  const groups = [];
  for (let g = 0; g < groupCount; g++) {
    const grp = [];
    for (let i = 0; i < perGroup; i++) {
      const id = `g${g}f${i}`;
      // f0 is the largest, so the "hires" rule keeps it.
      grp.push({ id, name: `${id}.jpg`, size: String(1e6 * (perGroup - i)), parents: ['p'],
                 createdTime: '2020-01-01T00:00:00Z', modifiedTime: '2020-01-01T00:00:00Z',
                 imageMediaMetadata: { width: 800 - i, height: 600 - i } });
    }
    groups.push(grp);
  }
  await render.renderGroups({ groups, idToEntry: new Map(), pathMap: new Map(), keepRule: 'hires' });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}, { groupCount, perGroup });
const settle = () => page.waitForTimeout(150);
const selectedCount = () => page.evaluate(async () => (await import('/js/render.js')).getSelectedCount());
const answerConfirm = async (ok) => {
  await page.waitForSelector('#confirmModal', { state: 'visible', timeout: 3000 });
  await page.click(`#confirmModal [data-confirm="${ok ? 'ok' : 'cancel'}"] >> nth=-1`);
};

// --- keepers and the selection ---------------------------------------------
await page.evaluate(async () => { (await import('/js/render.js')).wireRenderControls(); });
await render(3);
await page.click('#btnSelectAll');
const allSel = await selectedCount();
await page.evaluate(() => {
  const s = document.getElementById('resultSearch');
  if (s) { s.value = 'g0f'; s.dispatchEvent(new Event('input', { bubbles: true })); }
});
await page.waitForTimeout(400);
const afterSearch = await selectedCount();
ck(allSel === 3 && afterSearch === 1,
   `a search that hides rows drops them from the selection (${allSel} -> ${afterSearch})`);
await page.evaluate(() => {
  const s = document.getElementById('resultSearch');
  if (s) { s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); }
});
await page.waitForTimeout(400);

// Pin the duplicate, tick the old keeper, unpin: the old keeper is the keeper
// again and must not still be selected.
await render(1);
await page.click('#resultsTbody tr[data-file-id="g0f1"] [data-action="pin-keep"]');
await settle();
await page.click('#resultsTbody tr[data-file-id="g0f0"] input[type=checkbox]');
const tickedOldKeeper = await selectedCount();
await page.click('#resultsTbody tr[data-file-id="g0f1"] [data-action="unpin-keep"]');
await settle();
ck(tickedOldKeeper === 1 && await selectedCount() === 0,
   'unpinning does not leave the restored keeper selected (it has no checkbox to show it)');

// A pin survives a re-render of the same groups -- what a rescan or a reload does.
await page.click('#resultsTbody tr[data-file-id="g0f1"] [data-action="pin-keep"]');
await settle();
await render(1);
const keepAfterRerender = await page.evaluate(() =>
  document.querySelector('#resultsTbody tr.keepRow')?.dataset.fileId);
ck(keepAfterRerender === 'g0f1', `a pinned keeper is still the keeper after the results re-render (${keepAfterRerender})`);

// Compare shows the pinned keeper as the keeper.
await page.click('#resultsTbody tr[data-file-id="g0f0"] [data-action="compare"]');
await page.waitForSelector('#compareModal', { state: 'visible' });
const badges = await page.evaluate(() => {
  const left = document.getElementById('compareLeftTitle')?.textContent;
  const leftKeep = document.getElementById('compareLeftKeep')?.style.display !== 'none';
  const rightKeep = document.getElementById('compareRightKeep')?.style.display !== 'none';
  return { left, leftKeep, rightKeep };
});
ck(/g0f1/.test(badges.left || '') ? badges.leftKeep : badges.rightKeep,
   `Compare badges the pinned keeper as KEEP (${JSON.stringify(badges)})`);

// Ctrl+A under the Compare modal does not select the table behind it.
await page.keyboard.press('Control+a');
await settle();
ck(await selectedCount() === 0, 'Ctrl+A inside Compare does not select the table behind it');

// "3" (delete both) asks first; Cancel trashes nothing.
const trashedBefore = await page.evaluate(() => window.__trashed.length);
await page.keyboard.press('3');
await answerConfirm(false);
await settle();
ck(await page.evaluate(() => window.__trashed.length) === trashedBefore,
   'Compare "3" asks before deleting both copies, and Cancel deletes nothing');

// "2" on the KEEP side asks too. Find which key targets the keeper.
const keeperKey = badges.leftKeep ? '1' : '2';
await page.keyboard.press(keeperKey);
const askedForKeeper = await page.waitForSelector('#confirmModal', { state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
if (askedForKeeper) await answerConfirm(false);
ck(askedForKeeper, 'Compare asks before deleting the KEEP file');
await page.keyboard.press('Escape');
await settle();

// --- keyboard shortcuts in the table ----------------------------------------
await page.click('#btnSelectNone').catch(() => {});
await render(2);
await page.focus('#resultsTbody tr[data-file-id="g1f1"]');
await page.keyboard.press(' ');
await settle();
ck(await selectedCount() === 1, 'Space on a focused row selects it (the shortcut used to do nothing)');
await page.keyboard.press('ArrowUp');
const focusedAfterUp = await page.evaluate(() => document.activeElement?.dataset?.fileId);
ck(focusedAfterUp === 'g1f0', `the arrow keys move between rows (${focusedAfterUp})`);

// --- per-toast Undo -----------------------------------------------------------
await render(2);
await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
// The duplicate in each group, whichever file a pin left keeping it.
const dupOf = (g) => page.evaluate((g) =>
  document.querySelector(`#resultsTbody tr[data-group-id="${g}"]:not(.keepRow)`)?.dataset.fileId, g);
const firstDup = await dupOf(1);
await page.click(`#resultsTbody tr[data-file-id="${firstDup}"] [data-action="delete"]`);
await answerConfirm(true);
await page.waitForTimeout(400);
const secondDup = await dupOf(1);
await page.click(`#resultsTbody tr[data-file-id="${secondDup}"] [data-action="delete"]`);
await answerConfirm(true);
await page.waitForTimeout(400);
const toastCount = await page.evaluate(() => document.querySelectorAll('.toast .toastAction').length);
ck(toastCount === 2, `two deletes give two Undo toasts, not one merged "×2" (${toastCount})`);
await page.click('.toast .toastAction >> nth=0');
await page.waitForTimeout(600);
const restored = await page.evaluate(() => window.__restored.slice());
ck(JSON.stringify(restored) === JSON.stringify([firstDup]),
   `Undo on the FIRST toast restores the first delete, not the latest (${JSON.stringify(restored)})`);

// --- bulk trash that stops part-way ------------------------------------------
// A one-second session. Sign out first: ensureToken returns a still-valid
// token without asking, and the hour-long one from setup would outlive the
// run. Sign-out clears the results, so they are rendered after.
await page.evaluate(async () => {
  const auth = await import('/js/auth.js');
  await auth.signOut();
  window.__tokenTtl = 1;
  window.__gisOk = true;
  await auth.ensureToken({ forcePrompt: true });
  const undo = await import('/js/undo.js');
  window.__undoFilesBefore = undo.getUndoFileCount();
  window.__trashed = [];
  window.__dieAfterFirstBatch = true;
});
await render(150);
await page.waitForTimeout(1200);            // let the one-second token lapse
await page.click('#btnSelectAll');
await page.click('#btnTrashNow');
await answerConfirm(true);
await page.waitForTimeout(2500);
const partial = await page.evaluate(async () => {
  const undo = await import('/js/undo.js');
  const render = await import('/js/render.js');
  return {
    trashed: window.__trashed.length,
    undoAdded: undo.getUndoFileCount() - window.__undoFilesBefore,
    rowsLeft: render.getRowCount(),
    stillSelected: render.getSelectedCount(),
    toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
  };
});
console.log('   ', partial);
ck(partial.trashed === 100, `the run trashed its first chunk of 100 before the session died (${partial.trashed})`);
ck(partial.undoAdded === 100, `all 100 are recorded for Undo (${partial.undoAdded})`);
ck(partial.rowsLeft === 100 && partial.stillSelected === 50,
   `they leave the table and the selection; the 50 untried stay selected (${partial.rowsLeft} rows, ${partial.stillSelected} selected)`);
ck(/Trash stopped/.test(partial.toast), 'and the stop is reported, with what was done');
await page.evaluate(() => { window.__dieAfterFirstBatch = false; window.__gisOk = true; window.__tokenTtl = 3600; });

// --- a second confirmation does not strand the first --------------------------
const superseded = await page.evaluate(async () => {
  const { confirmAction } = await import('/js/confirm.js');
  const first = confirmAction({ title: 'one' });
  const second = confirmAction({ title: 'two' });
  const firstAnswer = await Promise.race([first, new Promise(r => setTimeout(() => r('hung'), 500))]);
  document.querySelector('#confirmModal [data-confirm="cancel"]')?.click();
  await second;
  return firstAnswer;
});
ck(superseded === false, `a confirmation replaced by another resolves "no" instead of hanging (${superseded})`);

// --- settings that did not persist -------------------------------------------
await page.evaluate(() => {
  const set = (id, v) => { const n = document.getElementById(id); n.value = v; n.dispatchEvent(new Event('change', { bubbles: true })); };
  set('recursiveMode', 'no');
  const d = document.getElementById('useDeltaScan'); d.checked = true; d.dispatchEvent(new Event('change', { bubbles: true }));
  const t = document.querySelector('.imgTypeToggle[data-exts=".gif"]'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1500);
const persisted = await page.evaluate(() => ({
  recursive: document.getElementById('recursiveMode').value,
  delta: document.getElementById('useDeltaScan').checked,
  gif: document.querySelector('.imgTypeToggle[data-exts=".gif"]').checked,
}));
ck(persisted.recursive === 'no', `"Recursive: No" survives a reload (${persisted.recursive})`);
ck(persisted.delta === true, 'the "check for changes" option survives a reload');
ck(persisted.gif === false, 'an unticked image type stays unticked after a reload');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
