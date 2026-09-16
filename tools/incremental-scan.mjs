/*
 * Drive Dupe Destroyer (DDD) — tools/incremental-scan.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/incremental-scan.mjs
 */
// #116: a second scan of an unchanged Drive must not enumerate it again.
//
// The claim is about NETWORK WORK, so it is measured as network work: every
// files.list call is counted. #67's whole point was that the old "delta scan"
// avoided none of them, and a test that only checked the results would have
// passed for it too.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error' && !/Failed to load resource/.test(t)) console.log('CONSOLE-ERR:', t.slice(0, 200));
});

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
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_oauth_client_id', '1234567890-abcdefghijklmnop.apps.googleusercontent.com');
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);

/**
 * Run a scan over a fake Drive, counting the network calls that matter.
 * `changes` is what the Changes feed reports on this run.
 */
const runScan = ({ folderIds = ['root'], files, changes = [], exclusions = [], minSizeKB = '0' }) =>
  page.evaluate(async ({ folderIds, files, changes, exclusions, minSizeKB }) => {
    const scan = await import('/js/scan.js');
    const auth = await import('/js/auth.js');
    await auth.ensureToken();

    const rec = scan.makeRecordingReporter();
    scan.setScanReporter(rec.reporter);

    const counts = { list: 0, changes: 0, startToken: 0 };
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/drive/v3/changes/startPageToken')) {
        counts.startToken++;
        return new Response(JSON.stringify({ startPageToken: '100' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/drive/v3/changes')) {
        counts.changes++;
        return new Response(JSON.stringify({
          changes: changes.map(c => c._removed
            ? { fileId: c.id, removed: true }
            : { fileId: c.id, removed: false, file: c }),
          newStartPageToken: '101',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/drive/v3/files') && u.includes('q=')) {
        counts.list++;
        return new Response(JSON.stringify({ files }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
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

    // NOT exact mode: the Changes reconcile is gated on `!quickScan`, so an
    // exact-only run never reaches it and never stores a token. The first
    // version of this harness used exact and measured nothing at all.
    document.querySelector('input[name="matchMode"][value="similar"]').checked = true;
    const setVal = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; if (e.dataset) e.dataset.actualValue = v; } };
    setVal('imgMinSize', minSizeKB); setVal('imgMinUnit', 'KB'); setVal('imgMaxSize', '9999'); setVal('maxItems', '0'); setVal('useDb', 'no');
    document.querySelectorAll('.imgTypeToggle').forEach(cb => { cb.checked = true; });
    const delta = document.getElementById('useDeltaScan');
    if (delta) delta.checked = true;

    let error = null;
    try {
      await scan.runScan({
        folderIds, folders: folderIds.map(id => ({ id, name: id })),
        exclusions: new Set(exclusions), renderCb: () => {}, emitGroupsCb: () => {},
      });
    } catch (e) { error = e.message; }

    window.fetch = realFetch;
    scan.setScanReporter(null);
    return { error, counts, stats: rec.lastStats(), statuses: rec.statuses() };
  }, { folderIds, files, changes, exclusions, minSizeKB });

const img = (id, md5, parent = 'root') => ({
  id, name: `${id}.jpg`, mimeType: 'image/jpeg', md5Checksum: md5, size: '500000',
  parents: [parent], imageMediaMetadata: { width: 800, height: 600 },
});

const LIBRARY = [img('a', 'M1'), img('b', 'M1'), img('c', 'M3'), img('d', 'M4')];

// --- clear any leftover state --------------------------------------------
await page.evaluate(async () => {
  const c = await import('/js/fileListCache.js');
  const db = await import('/js/db.js');
  await c.clearFileList();
  await db.clearChangesToken();
});

// --- first scan: enumerates ----------------------------------------------
const first = await runScan({ files: LIBRARY });
ck(!first.error, `#116 the first scan completes${first.error ? ': ' + first.error : ''}`);
ck(first.counts.list > 0, `#116 and enumerates (${first.counts.list} files.list call(s))`);
ck(first.stats?.files === 4, `#116 finding the whole library (${first.stats?.files})`);

// --- second scan, nothing changed: must NOT enumerate ---------------------
const second = await runScan({ files: LIBRARY });
ck(second.counts.list === 0,
   `#116 the second scan skips the enumeration entirely (${second.counts.list} files.list calls, was ${first.counts.list})`);
ck(second.counts.changes > 0,
   `#116 asking the Changes feed instead (${second.counts.changes} call(s))`);
ck(second.stats?.files === 4,
   `#116 and still sees the whole library (${second.stats?.files}) — a cache that lost files would be worse than no cache`);
ck(second.statuses.some(s => /Reusing/.test(s)),
   `#116 and says so rather than pretending it did the work`);

// --- a file added elsewhere arrives through the changes feed --------------
const third = await runScan({ files: LIBRARY, changes: [img('e', 'M5')] });
ck(third.counts.list === 0, `#116 still no enumeration (${third.counts.list})`);
ck(third.stats?.files === 5,
   `#116 but a new file reaches the scan through the changes feed (${third.stats?.files})`);

// --- a file trashed elsewhere disappears ----------------------------------
const fourth = await runScan({ files: LIBRARY, changes: [{ id: 'e', _removed: true }] });
ck(fourth.stats?.files === 4,
   `#116 and a file trashed elsewhere leaves the scan (${fourth.stats?.files})`);

// --- CHANGING THE FOLDER SELECTION MUST RE-ENUMERATE ----------------------
// The dangerous case. A stale scope does not look like a bug; it looks like
// the app scanning folders you told it not to.
const other = await runScan({ folderIds: ['otherFolder'], files: [img('z', 'M9', 'otherFolder')] });
ck(other.counts.list > 0,
   `#116 a DIFFERENT folder selection re-enumerates rather than reusing the cache (${other.counts.list} call(s))`);

// --- and so must changing the exclusions ----------------------------------
await runScan({ files: LIBRARY });                       // re-prime for 'root'
const excluded = await runScan({ files: LIBRARY, exclusions: ['sub'] });
ck(excluded.counts.list > 0,
   `#116 and so does changing the exclusions (${excluded.counts.list} call(s))`);

// --- A NEW FOLDER MUST NOT BE INVISIBLE -----------------------------------
//
// The correctness hole that skipping the enumeration opens, and it is subtle:
// when the listing is skipped, visitedFolderIds is the set from the CACHED
// walk. A folder created inside the scanned tree since then is not in it, so
// images added to it are rejected as out of scope by the in-scope check -- and
// the listing that would otherwise have found them did not run. They would
// stay invisible until something else invalidated the cache. A duplicate
// finder that silently stops seeing new photographs is worse than a slow one.
//
// The app re-enumerates instead of guessing. This checks it does.
await page.evaluate(async () => {
  const c = await import('/js/fileListCache.js');
  const db = await import('/js/db.js');
  await c.clearFileList();
  await db.clearChangesToken();
});

await runScan({ files: LIBRARY });                       // prime the cache
const primed = await runScan({ files: LIBRARY });
ck(primed.counts.list === 0, `#116 (fixture) the cache is primed (${primed.counts.list} list calls)`);

// A photo appears in a folder this scan has never walked.
const newFolder = await runScan({
  files: [...LIBRARY, img('fresh', 'M9', 'BRAND_NEW_FOLDER')],
  changes: [img('fresh', 'M9', 'BRAND_NEW_FOLDER')],
});
ck(newFolder.counts.list > 0,
   `#116 a change under an unwalked folder re-enumerates rather than dropping it `
   + `(${newFolder.counts.list} list call(s))`);
ck(newFolder.stats?.files === 5,
   `#116 so the new folder's image is actually found (${newFolder.stats?.files} of 5)`);

// --- THE CACHE MUST HOLD THE UNFILTERED ENUMERATION -----------------------
//
// The obvious mistake, and the one that cannot be recovered from without a
// manual rescan: cache what survived TODAY'S filters, and every future scan is
// permanently narrowed to them. Relaxing a size limit would then never bring
// a file back, however many times you rescanned.
//
// Measured by scanning with a filter that excludes a file, then scanning again
// with the filter relaxed and requiring the file to return WITHOUT a new
// files.list call. It can only come back if the cache kept it.
await page.evaluate(async () => {
  const c = await import('/js/fileListCache.js');
  const db = await import('/js/db.js');
  await c.clearFileList();
  await db.clearChangesToken();
});

// The min-size unit defaults to KB, not MB — the first version of this check
// passed "0.1" meaning MB and got a 102-byte floor, which excluded nothing.
const MIXED = [img('big1', 'B1'), img('big2', 'B1'),
               { ...img('tiny', 'T1'), size: '1000' }];   // 1 KB, under a 50 KB floor

const narrow = await runScan({ files: MIXED, minSizeKB: '50' });
ck(narrow.stats?.files === 2,
   `#116 a size filter excludes the small file on the first scan (${narrow.stats?.files} of 3)`);

const widened = await runScan({ files: MIXED, minSizeKB: '0' });
ck(widened.counts.list === 0,
   `#116 relaxing a FILTER does not re-enumerate — filters are not part of the scope (${widened.counts.list})`);
ck(widened.stats?.files === 3,
   `#116 and the previously filtered-out file comes back, so the cache held the UNFILTERED `
   + `enumeration (${widened.stats?.files} of 3)`);

await page.evaluate(async () => {
  const c = await import('/js/fileListCache.js');
  const db = await import('/js/db.js');
  await c.clearFileList();
  await db.clearChangesToken();
});

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
