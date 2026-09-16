/*
 * Drive Dupe Destroyer (DDD) — tools/scan-reporting.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/scan-reporting.mjs
 */
// #122: what the scan SAYS about itself, observed rather than watched.
//
// runScan is ~570 lines that interleave the pipeline with about fifty calls
// into js/ui.js, so until now the phase sequence, whether progress only ever
// goes forward, which empty state is chosen and whether the stats arithmetic
// is right were all things you could only check by looking at the screen.
//
// setScanReporter swaps that object for a recorder. The scan still needs a
// browser -- Drive, IndexedDB, workers -- so this is a harness rather than a
// node --test, but the ASSERTIONS are now about recorded data instead of about
// the DOM, which is the point of the seam.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
// Surface the scan's own failures. A scan that throws internally reports
// phase "Failed" and otherwise looks like a quiet run, so without this a
// missing renderCb reads as "the stats are wrong".
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error' && !/Failed to load resource/.test(t)) console.log('CONSOLE-ERR:', t.slice(0, 220));
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
 * Run a scan over a synthetic Drive and return what the reporter saw.
 * `count` images, all distinct, so the run reaches the end without matching.
 */
const runWith = (files, mode = 'exact') => page.evaluate(async ({ files, mode }) => {
  const scan = await import('/js/scan.js');
  const auth = await import('/js/auth.js');
  const db = await import('/js/db.js');
  await auth.ensureToken();
  await db.dbClearImages();

  const rec = scan.makeRecordingReporter();
  scan.setScanReporter(rec.reporter);

  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/drive/v3/files') && u.includes('q=')) {
      return new Response(JSON.stringify({ files }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // The hashing path downloads bytes. Serve a real image from this repo so
    // createImageBitmap and the worker pool do real work -- a stub that
    // returned nothing would make every hash fail and the run would report
    // "no images" while every phase and progress check still passed.
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

  // Exact-only keeps the run off the hashing path, which would need real image
  // bytes; the phase sequence and the stats arithmetic are the same either way.
  document.querySelector(`input[name="matchMode"][value="${mode}"]`).checked = true;

  // runScan reads its filters straight off the sidebar. The defaults exclude
  // small files, which silently dropped the whole fixture and made the run
  // report "no images" -- every phase and progress check still passed, on
  // nothing. Set them explicitly so the fixture is what gets scanned.
  const setVal = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; if (e.dataset) e.dataset.actualValue = v; } };
  setVal('imgMinSize', '0');
  setVal('imgMaxSize', '9999');
  setVal('maxItems', '0');
  setVal('useDb', 'no');
  document.querySelectorAll('.imgTypeToggle').forEach(cb => { cb.checked = true; });

  let error = null;
  try {
    // renderCb is required -- runScan calls it to hand the groups over. A
    // no-op keeps the DOM out of it, which is the whole point of the seam.
    await scan.runScan({
      folderIds: ['root'],
      folders: [{ id: 'root', name: 'My Drive' }],
      exclusions: new Set(),
      renderCb: () => {},
      emitGroupsCb: () => {},
    });
  } catch (e) { error = e.message; }

  window.fetch = realFetch;
  scan.setScanReporter(null);

  return {
    error,
    phases: rec.phases(),
    progresses: rec.progresses(),
    statuses: rec.statuses(),
    emptyStates: rec.emptyStates(),
    stats: rec.lastStats(),
    callNames: [...new Set(rec.calls.map(c => c.name))].sort(),
  };
}, { files, mode });

// --- a scan that finds two exact duplicates among five files --------------
const img = (id, md5, size) => ({
  id, name: `${id}.jpg`, mimeType: 'image/jpeg', md5Checksum: md5,
  size: String(size), parents: ['root'],
  imageMediaMetadata: { width: 800, height: 600 },
});

const found = await runWith([
  img('a', 'MD5AAA', 1000), img('b', 'MD5AAA', 1000),   // one exact pair
  img('c', 'MD5CCC', 2000), img('d', 'MD5DDD', 3000), img('e', 'MD5EEE', 4000),
]);

console.log('    phases   ', found.phases);
console.log('    progress ', found.progresses);
console.log('    stats    ', found.stats);

ck(!found.error, `#122 the scan completes against the recorder${found.error ? ': ' + found.error : ''}`);
ck(found.callNames.length >= 5,
   `#122 the recorder saw the scan's whole reporting surface (${found.callNames.join(', ')})`);

// Phases, in order and numbered consistently.
ck(found.phases[0] === '1/4 Collecting files',
   `#122 it starts by saying what it is doing ("${found.phases[0]}")`);
ck(found.phases[found.phases.length - 1] === 'Complete',
   `#122 and ends on Complete ("${found.phases[found.phases.length - 1]}")`);
// Applied to BOTH runs below. It was originally only checked on the exact
// path, and the exact and similar paths announce DIFFERENT phase 3s ("Building
// paths" vs "Finding matches") -- so a phase renumbered on the similar path was
// not covered by a check that passed cleanly.
const numberedOf = (phases) => phases.filter(p => /^\d\/4 /.test(p)).map(p => Number(p[0]));
const checkPhaseOrder = (phases, where) => {
  const n = numberedOf(phases);
  ck(n.length > 0 && n.every((v, i) => i === 0 || v >= n[i - 1]),
     `#122 the numbered phases never go backwards on the ${where} path (${n.join(' → ')})`);
};
checkPhaseOrder(found.phases, 'exact');

// Progress is monotonic and bounded. A bar that jumps backwards reads as a
// stall or a restart, and one that exceeds 100 renders past its own track.
const p = found.progresses;
ck(p.length > 0 && p[0] === 0, `#122 progress starts at 0 (${p[0]})`);
ck(p.every((v, i) => i === 0 || v >= p[i - 1]),
   `#122 progress never goes backwards (${p.join(' → ')})`);
ck(p.every(v => v >= 0 && v <= 100), `#122 and stays within 0-100 (max ${Math.max(...p)})`);
ck(p[p.length - 1] === 100, `#122 finishing sets it to 100 (${p[p.length - 1]})`);

// Stats arithmetic, against a control the harness computes from its own fixture.
ck(found.stats?.groups === 1, `#122 one exact duplicate group is reported (${found.stats?.groups})`);
ck(found.stats?.files === 5, `#122 over the five files scanned (${found.stats?.files})`);
ck(found.stats?.totalBytes === 1000 + 1000 + 2000 + 3000 + 4000,
   `#122 and totalBytes is the sum of every scanned file (${found.stats?.totalBytes})`);
ck(typeof found.stats?.durationMs === 'number' && found.stats.durationMs >= 0,
   `#122 with a duration (${found.stats?.durationMs}ms)`);

// --- the hashing path, where progress actually moves ----------------------
//
// The exact-only run above never reaches phase 2/4's progress reporting, so its
// monotonicity check only ever saw three values -- an injected backwards jump
// at report.progress(55) sailed straight through it. This run downloads and
// hashes real image bytes, which is where the bar spends most of a real scan.
const hashed = await runWith([
  img('h1', 'MD5H1', 500000), img('h2', 'MD5H2', 500000),
  img('h3', 'MD5H3', 500000), img('h4', 'MD5H4', 500000),
], 'similar');

console.log('    hashing phases  ', hashed.phases);
console.log('    hashing progress', hashed.progresses);

const hp = hashed.progresses;
ck(!hashed.error && hp.length > 3,
   `#122 the hashing path runs and reports progress more than a handful of times (${hp.length} updates)`);
ck(hp.every((v, i) => i === 0 || v >= hp[i - 1]),
   `#122 progress through hashing never goes backwards (${hp.join(' → ')})`);
ck(hp.every(v => v >= 0 && v <= 100), `#122 and stays within 0-100 (max ${Math.max(...hp)})`);
ck(hashed.phases.some(p => /Hashing/.test(p)),
   `#122 and the phase says so while it happens (${hashed.phases.join(' → ')})`);
checkPhaseOrder(hashed.phases, 'similar');

// --- a scan that finds nothing to look at ---------------------------------
const empty = await runWith([]);
ck(empty.emptyStates.includes('none-found'),
   `#122 an empty Drive reports the none-found state, not a result (${JSON.stringify(empty.emptyStates)})`);
ck(empty.phases[empty.phases.length - 1] === 'Complete',
   '#122 and still finishes rather than leaving the phase mid-scan');
ck(empty.stats?.groups === 0 && empty.stats?.files === 0,
   `#122 with zeroed stats (${JSON.stringify(empty.stats && { g: empty.stats.groups, f: empty.stats.files })})`);

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
