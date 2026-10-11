/*
 * Drive Dupe Destroyer (DDD) — tools/live-results.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/live-results.mjs
 */
// Live results from the start of hashing, and the size range.
//
// Drives the real render module the way runScan now does: early MD5 and
// identical-hash groups first, under keys the matcher has never heard of, then
// the matcher's own groups. What must hold is what the user sees:
//   - no file is ever listed in two groups at once,
//   - a union-find merge (root B absorbed into A) does not leave B behind,
//   - a file trashed, or a group ignored, mid-scan stays gone in the final table,
//   - rows ticked mid-scan are still ticked when the scan finishes.
// And for the size fields: the new defaults, the one-time migration of saved
// values, and the impossible-range flag.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext();
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2000);

let f = 0; const ck = (ok, l) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) f++; };

const r = await page.evaluate(async () => {
  const render = await import('/js/render.js');
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const rows = () => [...document.querySelectorAll('#resultsTbody tr[data-file-id]')].map(t => t.dataset.fileId);
  const checked = () => [...document.querySelectorAll('#resultsTbody tr[data-file-id]')]
    .filter(t => t.querySelector('input[type=checkbox]')?.checked).map(t => t.dataset.fileId);
  const mk = (id, t) => ({ id, name: `${id}.jpg`, size: 1000, createdTime: t, modifiedTime: t, parents: ['p'] });
  const F = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'x', 'y'].map((id, i) => [id, mk(id, `202${i}-01-01T00:00:00Z`)]));
  const entry = { base12: new Uint8Array(18), base8: new Uint8Array(8) };
  const idToEntry = new Map(Object.keys(F).map(id => [id, entry]));
  const out = {};

  render.beginProgressive({ idToEntry, keepRule: 'oldest' });
  // During hashing: an MD5 pair, then an identical-hash group that absorbs it.
  render.pushProgressiveMatch({ root: 'md5:m', group: [F.a, F.b] });
  render.pushProgressiveMatch({ root: 'hash:h', group: [F.a, F.b, F.c] });
  render.pushProgressiveMatch({ root: 'md5:n', group: [F.x, F.y] });
  await settle();
  out.early = rows();

  // The matcher, mid-run, emits a PARTIAL view that overlaps an early group
  // without containing it. Shown separately, a and b would be listed twice.
  render.pushProgressiveMatch({ root: 'partial', group: [F.a, F.b, F.e] });
  await settle();
  out.partial = rows();

  // Matching: the matcher's group under its own root swallows the early one.
  render.pushProgressiveMatch({ root: 'a', group: [F.a, F.b, F.c, F.d] });
  // A union-find merge: root e then root d absorb into a.
  render.pushProgressiveMatch({ root: 'e', group: [F.e, F.x, F.y] });
  await settle();
  out.beforeMerge = rows();
  render.pushProgressiveMatch({ root: 'a', group: [F.a, F.b, F.c, F.d, F.e, F.x, F.y] });
  await settle();
  out.afterMerge = rows();

  // Tick a non-keeper, then trash another, mid-scan.
  const box = document.querySelector('#resultsTbody tr[data-file-id="c"] input[type=checkbox]');
  box?.click();
  window.dispatchEvent(new CustomEvent('ddd:trashed', { detail: { ids: ['d'] } }));
  render.pushProgressiveMatch({ root: 'a', group: [F.a, F.b, F.c, F.d, F.e, F.x, F.y] });
  await settle();
  out.afterTrash = rows();
  out.liveChecked = checked();

  // The scan finishes; its groups were computed before the trash.
  render.endProgressive();
  await render.renderGroups({ groups: [[F.a, F.b, F.c, F.d, F.e, F.x, F.y]], idToEntry, pathMap: new Map(), keepRule: 'oldest' });
  await settle();
  out.final = rows();
  out.finalChecked = checked();

  // Ignore mid-scan.
  render.beginProgressive({ idToEntry, keepRule: 'oldest' });
  render.pushProgressiveMatch({ root: 'g', group: [F.a, F.b] });
  await settle();
  window.dispatchEvent(new CustomEvent('ddd:ignoreGroup', { detail: { ids: ['a', 'b'] } }));
  render.pushProgressiveMatch({ root: 'g', group: [F.a, F.b] });
  await settle();
  out.ignoredLive = rows();
  render.pushProgressiveMatch({ root: 'g', group: [F.a, F.b, F.c] });
  await settle();
  out.ignoredGrew = rows();
  render.endProgressive();

  // Size fields.
  const v = (id) => document.getElementById(id).value;
  out.sizes = [v('imgMinSize'), v('imgMinUnit'), v('imgMaxSize'), v('imgMaxUnit')].join(' ');
  const min = document.getElementById('imgMinSize'), unit = document.getElementById('imgMinUnit');
  min.value = '60'; unit.value = 'MB'; unit.dispatchEvent(new Event('change'));
  out.invalidFlag = min.getAttribute('aria-invalid');
  min.value = '32'; unit.value = 'KB'; unit.dispatchEvent(new Event('change'));
  out.validFlag = min.getAttribute('aria-invalid');

  // Plant an old saved profile (no version marker) for the migration check.
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_scan_settings_v1', {
    imgMinSize: '60', imgMinUnit: 'MB', imgMaxSize: '4', imgMaxUnit: 'MB', pageSize: '1',
  });
  return out;
});

const dupes = (ids) => ids.length !== new Set(ids).size;
console.log('  ', JSON.stringify(r));
ck(!dupes(r.early) && r.early.length === 5, 'early MD5 group is replaced by the identical-hash group that contains it');
ck(!dupes(r.partial) && r.partial.length === 6, 'a partial matcher group overlapping an early one is shown merged, not twice');
ck(!dupes(r.beforeMerge), 'the matcher\'s group replaces the early group; no file listed twice');
ck(!dupes(r.afterMerge) && r.afterMerge.length === 7, 'a union-find merge leaves no stale group behind');
ck(!r.afterTrash.includes('d'), 'a file trashed mid-scan leaves the live table');
ck(!r.final.includes('d'), 'and does not come back in the final table');
ck(r.liveChecked.includes('c') && r.finalChecked.includes('c'), 'a row ticked mid-scan is still ticked at the end');
ck(r.ignoredLive.length === 0, 'an ignored group stays hidden when re-emitted unchanged');
ck(r.ignoredGrew.length === 3, 'and comes back once it gains a file the user has not seen');
ck(r.sizes === '32 KB 2 MB', `size defaults are 32 KB .. 2 MB (got ${r.sizes})`);
ck(r.invalidFlag === 'true' && r.validFlag === null, 'min > max is flagged on the fields, and cleared when fixed');

// Reload with the planted old profile: sizes migrate, other settings restore.
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);
const after = await page.evaluate(() => ({
  sizes: ['imgMinSize', 'imgMinUnit', 'imgMaxSize', 'imgMaxUnit'].map(id => document.getElementById(id).value).join(' '),
  pageSize: document.getElementById('pageSize').value,
}));
ck(after.sizes === '32 KB 2 MB', `an old saved size range is reset to the new defaults once (got ${after.sizes})`);
ck(after.pageSize === '1', 'while the rest of the saved settings still restore');

// And a range saved under the current version is the user's, and stays.
await page.evaluate(() => {
  const s = (id, v) => { const n = document.getElementById(id); n.value = v; n.dispatchEvent(new Event('change', { bubbles: true })); };
  s('imgMinSize', '100'); s('imgMaxSize', '5');
});
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);
const kept = await page.evaluate(() => ['imgMinSize', 'imgMaxSize'].map(id => document.getElementById(id).value).join(' '));
ck(kept === '100 5', `a size range saved after the migration is kept (got ${kept})`);

// --- end to end: runScan opens the live table BEFORE matching ------------
//
// A real scan over a synthetic Drive (the scan-reporting.mjs harness). Every
// download serves the same PNG, so every hash is identical: the MD5 pair must
// appear before hashing starts, and the rest as they hash -- both before the
// "3/4 Finding matches" phase that used to be the first moment anything showed.
const e2e = await (async () => {
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => {
    window.google = { accounts: { oauth2: {
      initTokenClient: () => {
        const c = { callback: null };
        c.requestAccessToken = () => setTimeout(() => c.callback({ access_token: 'tok', expires_in: 3600 }), 5);
        return c;
      },
      revoke: (t, cb) => { cb && cb(); },
    } } };
  });
  await p2.route('**/gsi/client*', r => r.abort());
  await p2.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
  await p2.evaluate(async () => {
    const db = await import('/js/db.js');
    await db.settingSet('destroyer_oauth_client_id', '1234567890-abcdefghijklmnop.apps.googleusercontent.com');
  });
  await p2.reload({ waitUntil: 'load' });
  await p2.waitForTimeout(1200);
  const out = await p2.evaluate(async () => {
    const scan = await import('/js/scan.js');
    const auth = await import('/js/auth.js');
    const db = await import('/js/db.js');
    await auth.ensureToken();
    await db.dbClearImages();
    const log = [];
    const rec = scan.makeRecordingReporter();
    scan.setScanReporter({ ...rec.reporter, phase: (p) => log.push(`phase:${p}`) });
    const realFetch = window.fetch;
    const img = (id, md5) => ({ id, name: `${id}.png`, mimeType: 'image/png', md5Checksum: md5,
      size: '500000', parents: ['root'], imageMediaMetadata: { width: 800, height: 600 } });
    const files = [img('m1', 'SAME'), img('m2', 'SAME'), img('h1', 'H1'), img('h2', 'H2'), img('h3', 'H3')];
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/drive/v3/files') && u.includes('q=')) {
        return new Response(JSON.stringify({ files }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('alt=media')) {
        const png = await realFetch('/docs/screenshots/01-home-ready.png');
        return new Response(await png.blob(), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (u.includes('/drive/v3/files/')) {
        return new Response(JSON.stringify({ id: 'root', name: 'My Drive', parents: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url, opts);
    };
    document.querySelector('input[name="matchMode"][value="similar"]').checked = true;
    const setVal = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; if (e.dataset) e.dataset.actualValue = v; } };
    setVal('imgMinSize', '0'); setVal('imgMaxSize', '9999'); setVal('maxItems', '0'); setVal('useDb', 'no');
    document.querySelectorAll('.imgTypeToggle').forEach(cb => { cb.checked = true; });
    let finalGroups = null, error = null;
    try {
      await scan.runScan({
        folderIds: ['root'], folders: [{ id: 'root', name: 'My Drive' }], exclusions: new Set(),
        renderCb: (d) => { finalGroups = d.groups.map(g => g.map(f => f.id).sort()); },
        onProgressiveMatch: (evt) => {
          if (evt.type === 'match') log.push(`match:${evt.root.split(':')[0]}:${evt.group.map(f => f.id).sort().join(',')}`);
          else log.push(evt.type);
        },
        emitGroupsCb: () => {},
      });
    } catch (e) { error = e.message; }
    window.fetch = realFetch;
    scan.setScanReporter(null);
    return { log, finalGroups, error };
  });
  await p2.close();
  return out;
})();
console.log('  ', JSON.stringify(e2e));
const at = (pred) => e2e.log.findIndex(pred);
const matchPhase = at(x => x === 'phase:3/4 Finding matches');
const hashPhase = at(x => x.startsWith('phase:2/4'));
ck(!e2e.error && matchPhase > 0, `the scan completes${e2e.error ? ': ' + e2e.error : ''}`);
ck(e2e.log.filter(x => x === 'start').length === 1, 'the live session starts exactly once (no reset at matching)');
ck(at(x => x === 'start') < matchPhase, 'and starts before matching');
ck(at(x => x === 'match:md5:m1,m2') >= 0 && at(x => x === 'match:md5:m1,m2') < matchPhase,
   'the byte-identical pair is listed before matching starts');
ck(at(x => x.startsWith('match:hash:')) > hashPhase && at(x => x.startsWith('match:hash:')) < matchPhase,
   'files with identical hashes are listed while hashing is still running');
ck(JSON.stringify(e2e.finalGroups) === JSON.stringify([['h1', 'h2', 'h3', 'm1', 'm2']]),
   'and the final result is the single group containing them all');

console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(f ? 1 : 0);
