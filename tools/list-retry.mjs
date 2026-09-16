/*
 * Drive Dupe Destroyer (DDD) — tools/list-retry.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/list-retry.mjs
 */
// #132: a transient Drive error must not quietly remove folders from a scan.
//
// Measured before the fix, against these same fixtures:
//
//   flat tree, 20 folders, 40 images
//     one 503 on list call 11 of 21   ->  38 images, reported "Done."
//   nested tree, branch + 10 leaves, 20 images
//     one 503 on the branch folder    ->   0 images, reported "No images found."
//
// The second is the one that matters: a single transient server error and the
// app states, flatly, that the Drive contains no images.
//
// Measured as NETWORK BEHAVIOUR, because that is what the claim is about. The
// fixture asserts its own image count first -- an earlier version of this file
// used 2-character folder IDs, which quoteFolderId rejects, so every folder
// failed, the scan reported "No images found", and every check about missing
// images would have passed against a Drive that was never read.
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
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_oauth_client_id', '1234567890-abcdefghijklmnop.apps.googleusercontent.com');
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);

/**
 * Run a scan over a fake Drive.
 *
 * `failAt`      which files.list call fails
 * `failTimes`   how many consecutive calls from there fail (1 = a transient
 *               blip the retry should absorb; 99 = a folder that is genuinely
 *               unreadable and must be REPORTED, not hidden)
 * `keepCache`   leave the enumeration cache in place, the way a user re-running
 *               a scan does. Every other run starts from a cleared cache.
 */
const run = ({ folders, failAt = 0, failTimes = 1, failStatus = 503, retryAfter = null,
               keepCache = false, failFolder = null, abortAfter = 0,
               failBody = '{"error":{"message":"Backend Error"}}' }) =>
  page.evaluate(async ({ folders, failAt, failTimes, failStatus, retryAfter, keepCache, failFolder, abortAfter, failBody }) => {
    const scan = await import('/js/scan.js');
    const auth = await import('/js/auth.js');
    const drive = await import('/js/drive.js');
    const c = await import('/js/fileListCache.js');
    const db = await import('/js/db.js');
    if (!keepCache) { await c.clearFileList(); await db.clearChangesToken(); }
    await auth.ensureToken();
    // Real backoff would make this harness minutes long for no extra signal.
    drive.setDriveRetryBaseMs(1);

    const rec = scan.makeRecordingReporter();
    scan.setScanReporter(rec.reporter);

    const counts = { list: 0, injected: 0, returned: [] };
    const ctrl = new AbortController();
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/drive/v3/changes/startPageToken'))
        return new Response(JSON.stringify({ startPageToken: '100' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/drive/v3/changes'))
        return new Response(JSON.stringify({ changes: [], newStartPageToken: '101' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/drive/v3/files') && u.includes('q=')) {
        counts.list++;
        const qq = new URL(u).searchParams.get('q') || '';
        // Failing by FOLDER is clearer than failing by call number, which the
        // retries themselves shift: three attempts on one folder consume three
        // call numbers, so a by-number window silently spills onto the next
        // folder.
        if (failFolder && qq.includes(`'${failFolder}' in parents`)) {
          counts.injected++;
          return new Response(failBody, { status: failStatus, headers: { 'Content-Type': 'application/json' } });
        }
        if (abortAfter > 0 && counts.list >= abortAfter) ctrl.abort();
        if (failAt > 0 && counts.list >= failAt && counts.list < failAt + failTimes) {
          counts.injected++;
          const headers = { 'Content-Type': 'application/json' };
          if (retryAfter != null) headers['Retry-After'] = String(retryAfter);
          return new Response('{"error":{"message":"Backend Error"}}', { status: failStatus, headers });
        }
        const q = new URL(u).searchParams.get('q') || '';
        const m = q.match(/'([^']+)' in parents/);
        const out = folders[m ? m[1] : '??'] || [];
        counts.returned.push(out.length);
        return new Response(JSON.stringify({ files: out }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('alt=media')) {
        const png = await realFetch('/docs/screenshots/01-home-ready.png');
        return new Response(await png.blob(), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (u.includes('/drive/v3/files/'))
        return new Response(JSON.stringify({ id: 'root', name: 'My Drive', parents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return realFetch(url, opts);
    };

    document.querySelector('input[name="matchMode"][value="similar"]').checked = true;
    const setVal = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; if (e.dataset) e.dataset.actualValue = v; } };
    setVal('recursiveMode', 'yes');
    setVal('imgMinSize', '0'); setVal('imgMinUnit', 'KB'); setVal('imgMaxSize', '9999');
    setVal('maxItems', '0'); setVal('useDb', 'no');
    document.querySelectorAll('.imgTypeToggle').forEach(cb => { cb.checked = true; });
    const delta = document.getElementById('useDeltaScan');
    if (delta) delta.checked = true;

    let error = null;
    try {
      await scan.runScan({
        folderIds: ['root'], folders: [{ id: 'root', name: 'root' }],
        exclusions: new Set(), renderCb: () => {}, emitGroupsCb: () => {},
        signal: abortAfter > 0 ? ctrl.signal : undefined,
      });
    } catch (e) { error = e.message; }

    window.fetch = realFetch;
    scan.setScanReporter(null);
    const statuses = rec.statuses();
    const resumeMod = await import('/js/resume.js');
    const saved = await resumeMod.loadResumeState().catch(() => null);
    return {
      error, counts, stats: rec.lastStats(), statuses,
      lastStatus: statuses[statuses.length - 1] || '',
      resume: saved ? {
        visited: saved.visitedFolderIds || [],
        pending: saved.pendingFolderIds || [],
      } : null,
    };
  }, { folders, failAt, failTimes, failStatus, retryAfter, keepCache, failFolder, abortAfter, failBody });

// --- fixtures -------------------------------------------------------------
// Drive folder IDs are 33 characters and quoteFolderId rejects anything else.
const mkId = (prefix, i) => {
  const id = prefix + String(i).padStart(3, '0');
  if (id.length !== 33) throw new Error(`fixture id must be 33 chars, got ${id.length}: ${id}`);
  return id;
};
const img = (id, md5, parent) => ({
  id, name: `${id}.jpg`, mimeType: 'image/jpeg', md5Checksum: md5, size: '500000',
  parents: [parent], imageMediaMetadata: { width: 800, height: 600 },
});
const folder = (id, parent) => ({ id, name: id, mimeType: 'application/vnd.google-apps.folder', parents: [parent] });

// Flat: 20 sibling folders, 2 images each.
const FLAT_PREFIX = '1BxYzFolderIdPlaceholder000000';   // 30 chars
const flat = { root: [] };
for (let i = 0; i < 20; i++) {
  const f = mkId(FLAT_PREFIX, i);
  flat.root.push(folder(f, 'root'));
  flat[f] = [img(`${f}a`, `M${i}`, f), img(`${f}b`, `M${i}`, f)];
}

// Nested: one branch folder holding ten leaves. Failing the branch loses all
// twenty images, because the leaves are never even discovered.
const DEEP_PREFIX = '1BxYzDeepFolderIdAAAAAAAAAAAAA';   // 30 chars
const D = (i) => mkId(DEEP_PREFIX, i);
const deep = { root: [folder(D(0), 'root')], [D(0)]: [] };
for (let i = 1; i <= 10; i++) {
  deep[D(0)].push(folder(D(i), D(0)));
  deep[D(i)] = [img(`d${i}a`, `X${i}`, D(i)), img(`d${i}b`, `X${i}`, D(i))];
}

// --- controls: the fixtures must be real before anything is asserted ------
const flatClean = await run({ folders: flat });
ck(flatClean.stats?.files === 40,
   `#132 (fixture) the flat tree really holds 40 images in ${flatClean.counts.list} files.list calls (${flatClean.stats?.files})`);

const deepClean = await run({ folders: deep });
ck(deepClean.stats?.files === 20,
   `#132 (fixture) the nested tree really holds 20 images in ${deepClean.counts.list} files.list calls (${deepClean.stats?.files})`);

// --- a transient blip is absorbed -----------------------------------------
const midCall = Math.ceil(flatClean.counts.list / 2);
for (const status of [503, 500, 429]) {
  const r = await run({ folders: flat, failAt: midCall, failTimes: 1, failStatus: status });
  ck(r.stats?.files === 40,
     `#132 a single ${status} on list call ${midCall}/${flatClean.counts.list} costs no images (${r.stats?.files} of 40, ${r.counts.injected} injected)`);
}

const deepBlip = await run({ folders: deep, failAt: 2, failTimes: 1, failStatus: 503 });
ck(deepBlip.stats?.files === 20,
   `#132 and a 503 on a BRANCH folder no longer loses its whole subtree (${deepBlip.stats?.files} of 20, was 0)`);

// --- Drive's own Retry-After is honored rather than ignored ---------------
const withHeader = await run({ folders: flat, failAt: midCall, failTimes: 1, failStatus: 429, retryAfter: 1 });
ck(withHeader.stats?.files === 40,
   `#132 a 429 carrying Retry-After is waited out, not dropped (${withHeader.stats?.files} of 40)`);

// --- a permanent failure is REPORTED, never hidden behind "Done" ----------
// This half stands on its own: even with perfect retries there will be folders
// that genuinely cannot be read, and claiming completeness over them is the
// actual defect.
const permanent = await run({ folders: flat, failAt: midCall, failTimes: 99, failStatus: 503 });
ck(permanent.stats?.files < 40,
   `#132 (fixture) a folder failing every attempt really does cost images (${permanent.stats?.files} of 40)`);
ck(/could not be read/.test(permanent.lastStatus),
   `#132 and the scan SAYS it did not cover everything: ${JSON.stringify(permanent.lastStatus)}`);
ck(!/^Done\.[^]*$/.test(permanent.lastStatus) || /does not cover everything/.test(permanent.lastStatus),
   `#132 never a bare "Done." over a Drive it could not finish reading`);

// --- and when the failure hides EVERYTHING, it must not claim emptiness ---
const permanentDeep = await run({ folders: deep, failAt: 2, failTimes: 99, failStatus: 503 });
ck(permanentDeep.stats?.files === 0,
   `#132 (fixture) failing the branch folder outright still finds nothing (${permanentDeep.stats?.files})`);
ck(/could not be read/.test(permanentDeep.lastStatus),
   `#132 "No images found" must not be the answer when we could not look: ${JSON.stringify(permanentDeep.lastStatus)}`);

// --- a real answer is still final: 404 must not be retried ----------------
const notFound = await run({ folders: flat, failAt: midCall, failTimes: 1, failStatus: 404 });
ck(notFound.counts.list === flatClean.counts.list,
   `#132 a 404 is an answer, not a failure: no extra requests (${notFound.counts.list} vs ${flatClean.counts.list} clean)`);

// --- #134: a short enumeration must not be cached and reused --------------
// #132 stops a transient error shrinking ONE scan. It does nothing about that
// shrunken result being written to the cache, which is what made the damage
// permanent: measured before the fix, scan 2 over a perfectly healthy Drive
// found 38 of 40, made ZERO list calls, and dropped the warning -- the one
// signal the user had, removed while the loss stayed. The cache holds for
// MAX_AGE_MS, seven days.
const damaged = await run({ folders: flat, failAt: midCall, failTimes: 5, failStatus: 503 });
ck(damaged.stats?.files === 38 && /could not be read/.test(damaged.lastStatus),
   `#134 (fixture) scan 1 really is damaged and says so (${damaged.stats?.files} of 40)`);

const recovery = await run({ folders: flat, keepCache: true });
ck(recovery.stats?.files === 40,
   `#134 re-scanning a healthy Drive recovers the missing files (${recovery.stats?.files} of 40, was 38 forever)`);
ck(recovery.counts.list > 0,
   `#134 because the incomplete enumeration was never cached (${recovery.counts.list} list calls, was 0)`);
ck(!/could not be read/.test(recovery.lastStatus),
   `#134 and the recovered scan no longer warns: ${JSON.stringify(recovery.lastStatus)}`);

// --- and the #116 cache still works for a scan that WAS complete ----------
// The cheap wrong fix is to stop caching. This is the control that says the
// fix is "do not cache a list known to be short", not "do not cache".
const clean1 = await run({ folders: flat });
ck(clean1.stats?.files === 40, `#116 (fixture) a complete scan finds everything (${clean1.stats?.files})`);
const clean2 = await run({ folders: flat, keepCache: true });
ck(clean2.counts.list === 0,
   `#116 a COMPLETE enumeration is still cached and reused (${clean2.counts.list} list calls)`);
ck(clean2.stats?.files === 40,
   `#116 and still sees the whole library from cache (${clean2.stats?.files})`);

// --- #134: a folder we could not read must stay ON the frontier -----------
// `walked` is documented as "only folders we actually listed", and the delta
// scan and the resume state both read it as coverage. Marking a folder walked
// BEFORE the request meant an unreadable folder counted as covered, so a
// resumed scan -- which exists to retry what was interrupted -- skipped exactly
// the folders that needed retrying.
//
// Needs a fixture past the 25-folder checkpoint interval, and an interruption,
// because a completed scan clears its own resume state.
const BIG_PREFIX = '1BxYzBigFolderIdBBBBBBBBBBBBBB';   // 30 chars
const big = { root: [] };
for (let i = 0; i < 60; i++) {
  const f = mkId(BIG_PREFIX, i);
  big.root.push(folder(f, 'root'));
  big[f] = [img(`${f}a`, `B${i}`, f), img(`${f}b`, `B${i}`, f)];
}
const doomed = mkId(BIG_PREFIX, 1);

const interrupted = await run({ folders: big, failFolder: doomed, abortAfter: 45 });
ck(!!interrupted.resume,
   `#134 (fixture) the interrupted scan really checkpointed a resume state (${interrupted.resume ? interrupted.resume.visited.length + ' walked, ' + interrupted.resume.pending.length + ' pending' : 'none'})`);
ck(interrupted.resume && !interrupted.resume.visited.includes(doomed),
   `#134 an unreadable folder is NOT recorded as covered`);
ck(interrupted.resume && interrupted.resume.pending.includes(doomed),
   `#134 it is put back on the frontier, so resuming retries it`);

// --- #135: a folder that can NEVER be read is a different answer ----------
// A shared folder this account cannot open is ordinary, not exceptional. The
// first cut of #134 treated it like a transient failure, which meant the
// incremental scan was disabled for good -- every scan re-enumerated and
// repeated the same warning, about something re-scanning cannot fix and the
// wording told the user to fix by re-scanning.
const DENIED = mkId(FLAT_PREFIX, 1);
const PERM_403 = '{"error":{"message":"insufficientFilePermissions"}}';

const denied1 = await run({ folders: flat, failFolder: DENIED, failStatus: 403, failBody: PERM_403 });
ck(denied1.stats?.files === 38,
   `#135 (fixture) a denied folder really costs its images (${denied1.stats?.files} of 40)`);
ck(/could not be opened/.test(denied1.lastStatus) && /sharing permissions/.test(denied1.lastStatus),
   `#135 and is reported as a permission problem: ${JSON.stringify(denied1.lastStatus)}`);
ck(!/scanning again/i.test(denied1.lastStatus),
   `#135 without telling the user to retry, which cannot work`);

const denied2 = await run({ folders: flat, failFolder: DENIED, failStatus: 403, failBody: PERM_403, keepCache: true });
ck(denied2.counts.list === 0,
   `#135 a permanent gap does NOT disable the incremental scan (${denied2.counts.list} list calls)`);
ck(!/could not be/.test(denied2.lastStatus),
   `#135 nor repeat the warning on every scan forever: ${JSON.stringify(denied2.lastStatus)}`);

// --- but a 403 Drive says is about RATE is transient, not permanent -------
const rate403 = await run({ folders: flat, failFolder: DENIED, failStatus: 403,
                            failBody: '{"error":{"message":"userRateLimitExceeded"}}' });
ck(/could not be read/.test(rate403.lastStatus) && /scanning again/i.test(rate403.lastStatus),
   `#135 a rate-limit 403 is transient, not a permission problem: ${JSON.stringify(rate403.lastStatus)}`);

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
await b.close();
process.exit(fails === 0 ? 0 : 1);
