/*
 * Drive Dupe Destroyer (DDD) — tools/queue-reachable.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/queue-reachable.mjs
 */
// #113: the trash queue must have an entry point, and #125: the bulk one must
// be batched.
//
// Calling addToQueue() directly would prove nothing — it always worked, it
// simply had no caller, which is exactly how it stayed unreachable through
// every release since it was written. So this drives the real UI: render a
// result set, click the row button, click Queue Selected, and read the badge.
//
// The transaction count is measured rather than asserted from the source,
// because "uses queueAddBatch" is a claim about behaviour: IDBDatabase.transaction
// is wrapped so every transaction on the trashQueue store is counted, and a
// loop over queueAdd shows up as N where the batch shows up as 1.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

/**
 * Click something, but report a missing or disabled control as a FAILING CHECK
 * rather than as a 30-second Playwright timeout.
 *
 * This matters here more than usual: the defect under test IS a missing button,
 * so the naive `page.click` spends the default timeout and then dies with a
 * stack trace that says nothing about which check was being made.
 */
const clickOrFail = async (sel, label) => {
  const state = await page.evaluate((sel) => {
    const e = document.querySelector(sel);
    return { present: !!e, disabled: !!e?.disabled, visible: !!e && e.offsetParent !== null };
  }, sel);
  if (!state.present)      { ck(false, `${label} — no element matches ${sel}`); return false; }
  if (!state.visible)      { ck(false, `${label} — ${sel} is not visible`); return false; }
  if (state.disabled)      { ck(false, `${label} — ${sel} is disabled`); return false; }
  await page.click(sel, { timeout: 5000 });
  return true;
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));

// Count trashQueue transactions from the very first module evaluation.
await page.addInitScript(() => {
  window.__qtx = 0;
  const real = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (stores, ...rest) {
    const names = Array.isArray(stores) ? stores : [stores];
    if (names.includes('trashQueue')) window.__qtx++;
    return real.call(this, stores, ...rest);
  };
});

await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);

const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// A result set the render module will accept: two groups of three, so every
// group has one keeper and two delete candidates.
const seed = (n) => page.evaluate(async (n) => {
  const db = await import('/js/db.js');
  const render = await import('/js/render.js');
  const ui = await import('/js/ui.js');
  await db.queueClear();

  const groups = [];
  const idToEntry = new Map();
  const pathMap = new Map();
  for (let g = 0; g < n; g++) {
    const group = [];
    for (let i = 0; i < 3; i++) {
      const id = `g${g}f${i}`;
      group.push({
        id, name: `${id}.jpg`,
        size: String(1_000_000 * (i + 1)),
        parents: ['parent0'],
        imageMediaMetadata: { width: 800 + i, height: 600 + i },
      });
      pathMap.set(id, '/Photos/2026');
    }
    groups.push(group);
  }
  ui.setSignedInUi(true, 'audit.apps.googleusercontent.com');
  render.wireRenderControls();
  await render.renderGroups({ groups, idToEntry, pathMap });
  return groups.length * 3;
}, n);

const seeded = await seed(2);
await settle();

const rowsRendered = await page.evaluate(() =>
  document.querySelectorAll('#resultsTbody tr[data-file-id]').length);
ck(rowsRendered === seeded, `#113 a result set renders (${rowsRendered}/${seeded} rows) — the harness can reach the table`);

// --- the per-row entry point ---------------------------------------------
const rowClicked = await clickOrFail('#resultsTbody tr[data-file-id] [data-action="queue"]',
  '#113 the results table offers a per-row queue action');
if (rowClicked) await page.waitForFunction(() => document.getElementById('queueCount')?.textContent === '1', null, { timeout: 5000 })
  .catch(() => {});
const afterRow = await page.evaluate(() => ({
  badge: document.getElementById('queueCount')?.textContent,
}));
ck(afterRow.badge === '1', `#113 the per-row action puts a file in the queue (badge "${afterRow.badge}")`);

// --- the bulk entry point -------------------------------------------------
await clickOrFail('#btnSelectAll', '#113 Select all duplicates is reachable after a render');
await settle();
const selectedCount = await page.evaluate(async () => {
  const render = await import('/js/render.js');
  return render.getSelectedCount();
});
ck(selectedCount > 1, `#113 Select all duplicates selects the non-keepers (${selectedCount})`);

const btnDisabled = await page.evaluate(() => document.getElementById('btnQueueSelected')?.disabled);
ck(btnDisabled === false, '#113 Queue Selected is enabled once something is selected');

const txBeforeBulk = await page.evaluate(() => window.__qtx);
const bulkClicked = await clickOrFail('#btnQueueSelected', '#113 Queue Selected is reachable');
if (bulkClicked) await page.waitForFunction((n) => Number(document.getElementById('queueCount')?.textContent) >= n,
  selectedCount, { timeout: 5000 }).catch(() => {});
const bulk = await page.evaluate(() => ({
  badge: Number(document.getElementById('queueCount')?.textContent),
  tx: window.__qtx,
  rows: document.querySelectorAll('#queueList .queueRow').length,
}));
const bulkTx = bulk.tx - txBeforeBulk;

ck(bulk.badge >= selectedCount,
   `#113 Queue Selected queues the whole selection (badge ${bulk.badge}, selected ${selectedCount})`);

// queueList (read) + queueAddBatch (write) + renderQueue's queueList (read) is
// the honest floor. A loop over queueAdd would be selectedCount writes on top.
ck(bulkTx <= 4,
   `#125 the bulk path is batched: ${bulkTx} trashQueue transaction(s) for ${selectedCount} files, not ${selectedCount}+`);

// --- what the queue stored ------------------------------------------------
const stored = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const items = await db.queueList();
  return {
    n: items.length,
    withPath: items.filter(i => i.path && i.path.length).length,
    withName: items.filter(i => i.name && i.name.length).length,
    withSize: items.filter(i => Number(i.size) > 0).length,
  };
});
ck(stored.withName === stored.n, `#113 every queued row kept its name (${stored.withName}/${stored.n})`);
ck(stored.withSize === stored.n, `#113 and its size (${stored.withSize}/${stored.n})`);
ck(stored.withPath === stored.n, `#113 and its resolved folder path (${stored.withPath}/${stored.n})`);

// --- re-queueing is a no-op, and says so ----------------------------------
const again = await page.evaluate(async () => {
  const q = await import('/js/queue.js');
  const db = await import('/js/db.js');
  const before = (await db.queueList()).length;
  const added = await q.addToQueueBatch(
    (await db.queueList()).map(i => ({ id: i.id, name: i.name, size: i.size, _path: i.path })));
  return { before, after: (await db.queueList()).length, added };
});
ck(again.after === again.before && again.added === 0,
   `#113 re-queueing what is already queued adds nothing and reports 0 (was ${again.before}, now ${again.after})`);

// --- the bulk TRASH confirmation names the files ---------------------------
// Not a queue check, but this fixture is the only place in the harness suite
// with a real selection over a real result set. trashSelectedNow() handed
// confirmAction() an array of ID STRINGS where it expects file objects, so the
// most destructive path in the app confirmed four rows reading "Untitled" with
// no thumbnail, no path and no size -- which is the single thing #109 exists to
// prevent, on the one dialog that most needed it.
await clickOrFail('#btnTrashNow', '#109 Trash Selected opens a confirmation');
await settle();
const confirmShows = await page.evaluate(() => {
  const dlg = document.getElementById('confirmModal');
  const visible = !!dlg && dlg.style.display === 'flex';
  const detail = dlg?.querySelector('#confirmDetail');
  const shown = visible && detail && !detail.hidden && detail.offsetParent !== null;
  const names = shown ? [...detail.querySelectorAll('.confirmFile b')].map(b => b.textContent) : [];
  const meta = shown ? [...detail.querySelectorAll('.confirmFile .muted')].map(d => d.textContent) : [];
  dlg?.querySelector('.modalFooter [data-confirm="cancel"]')?.click();
  return { visible, names, meta };
});
ck(confirmShows.visible, '#109 the bulk-trash confirmation is an in-app dialog');
ck(confirmShows.names.length > 0 && confirmShows.names.every(n => n && n !== 'Untitled'),
   `#109 and it names the real files, not "Untitled" (${confirmShows.names.join(', ') || 'none'})`);
ck(confirmShows.meta.length > 0 && confirmShows.meta.every(m => /\d+ × \d+/.test(m) && /Photos/.test(m)),
   `#109 with their size, resolution and folder (${confirmShows.meta[0] || 'none'})`);

await page.evaluate(async () => { const db = await import('/js/db.js'); await db.queueClear(); });

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
