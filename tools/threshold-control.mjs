/*
 * Drive Dupe Destroyer (DDD) — tools/threshold-control.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/threshold-control.mjs
 */
// #137: the Advanced "Hamming threshold" slider must actually set the
// threshold.
//
// It was displayed (index.html), given a live readout (app.js), persisted
// (settings.js) and documented (util.js HELP_TEXT) -- and never read. The scan
// took thresholdFromEasy(sensitivityLevel) and nothing else, so dragging the
// slider to 0, which its own help text calls "nearly identical", still matched
// at 10. Measured before the fix: slider 0 and slider 20 both produced the
// Sensitivity-3 answer of 1 group.
//
// The fixture is verified THRESHOLD-SENSITIVE first. A pair that groups the
// same way at every threshold would make every check below pass over nothing,
// and the first run of this file did exactly that -- renderCb does not receive
// the group array, so the count came back `undefined` and compared equal to
// itself at both settings.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.addInitScript(() => {
  window.google = { accounts: { oauth2: {
    initTokenClient: () => { const c = { callback: null };
      c.requestAccessToken = () => setTimeout(() => c.callback({ access_token: 'tok', expires_in: 3600 }), 5); return c; },
    revoke: (t, cb) => { cb && cb(); } } } };
});
await page.route('**/gsi/client*', r => r.abort());
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.evaluate(async () => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_oauth_client_id', '1234567890-abcdefghijklmnop.apps.googleusercontent.com');
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);

const run = ({ slider, sensitivity, keepSlider = false }) =>
  page.evaluate(async ({ slider, sensitivity, keepSlider }) => {
    const scan = await import('/js/scan.js');
    const auth = await import('/js/auth.js');
    const c = await import('/js/fileListCache.js');
    const db = await import('/js/db.js');
    await c.clearFileList(); await db.clearChangesToken(); await db.clearAllHashes?.().catch(() => {});
    await auth.ensureToken();
    const rec = scan.makeRecordingReporter();
    scan.setScanReporter(rec.reporter);

    // Two images: same base gradient, one with a band shifted. Perceptually
    // close but not identical, so the grouping DEPENDS on the threshold.
    const paint = (shift) => {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 256;
      const x = cv.getContext('2d');
      for (let i = 0; i < 16; i++) {
        for (let j = 0; j < 16; j++) {
          const v = ((i * 16 + j * 7) % 256);
          x.fillStyle = `rgb(${v},${(v + shift) % 256},${255 - v})`;
          x.fillRect(j * 16, i * 16, 16, 16);
        }
      }
      return new Promise(r => cv.toBlob(r, 'image/png'));
    };
    const blobs = { A: await paint(0), B: await paint(40) };

    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/drive/v3/changes/startPageToken'))
        return new Response(JSON.stringify({ startPageToken: '100' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/drive/v3/changes'))
        return new Response(JSON.stringify({ changes: [], newStartPageToken: '101' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/drive/v3/files') && u.includes('q=')) {
        const mk = (id, md5) => ({ id, name: `${id}.png`, mimeType: 'image/png', md5Checksum: md5,
          size: '50000', parents: ['root'], imageMediaMetadata: { width: 256, height: 256 } });
        return new Response(JSON.stringify({ files: [mk('A', 'MA'), mk('B', 'MB')] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('alt=media')) {
        const which = u.includes('/files/A') ? 'A' : 'B';
        return new Response(blobs[which], { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (u.includes('/drive/v3/files/'))
        return new Response(JSON.stringify({ id: 'root', name: 'My Drive', parents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return realFetch(url, opts);
    };

    document.querySelector('input[name="matchMode"][value="similar"]').checked = true;
    const setVal = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; if (e.dataset) e.dataset.actualValue = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
    setVal('recursiveMode', 'no'); setVal('imgMinSize', '0'); setVal('imgMinUnit', 'KB');
    setVal('imgMaxSize', '9999'); setVal('maxItems', '0'); setVal('useDb', 'no');
    // Order matters: Sensitivity drives the threshold, so a run that is
    // testing the SLIDER must set sensitivity first and the slider after.
    setVal('sensitivityLevel', String(sensitivity));
    if (keepSlider) setVal('hamThresh', String(slider));
    document.querySelectorAll('.imgTypeToggle').forEach(cb => { cb.checked = true; });

    let error = null;
    try {
      await scan.runScan({ folderIds: ['root'], folders: [{ id: 'root', name: 'root' }],
        exclusions: new Set(), renderCb: () => {}, emitGroupsCb: () => {} });
    } catch (e) { error = e.message; }
    window.fetch = realFetch;
    scan.setScanReporter(null);
    const st = rec.lastStats();
    return { error, groups: st?.groups, files: st?.files,
             sliderShown: document.getElementById('hamThresh')?.value,
             last: rec.statuses().slice(-1)[0] };
  }, { slider, sensitivity, keepSlider });

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

// --- the fixture must respond to the threshold at all ---------------------
const strict = await run({ slider: 2, sensitivity: 5 });   // thresholdFromEasy -> 3
const loose  = await run({ slider: 2, sensitivity: 1 });   // thresholdFromEasy -> 20
ck(strict.files === 2 && loose.files === 2,
   `#137 (fixture) both images reach the matcher (${strict.files}, ${loose.files})`);
ck(strict.groups === 0 && loose.groups === 1,
   `#137 (fixture) the pair is threshold-sensitive: ${strict.groups} group at sensitivity 5, ${loose.groups} at sensitivity 1`);

// --- Sensitivity still drives the threshold -------------------------------
ck(loose.sliderShown === '20' && strict.sliderShown === '3',
   `#137 Sensitivity moves the slider with it (${strict.sliderShown} at level 5, ${loose.sliderShown} at level 1)`);

// --- and the slider itself now decides ------------------------------------
// Sensitivity held at its default 3 (threshold 10) in both runs, so any
// difference here is the slider and nothing else.
const tight = await run({ slider: 0, sensitivity: 3, keepSlider: true });
const wide  = await run({ slider: 20, sensitivity: 3, keepSlider: true });
ck(tight.groups === 0,
   `#137 slider at 0 really means nearly identical (${tight.groups} group(s), was 1)`);
ck(wide.groups === 1,
   `#137 slider at 20 still groups the pair (${wide.groups} group(s))`);
ck(tight.groups !== wide.groups,
   `#137 the slider changes the result at all, which is the whole bug (${tight.groups} vs ${wide.groups})`);

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
await b.close();
process.exit(fails === 0 ? 0 : 1);
