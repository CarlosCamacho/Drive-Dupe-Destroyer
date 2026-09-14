/*
 * Drive Dupe Destroyer (DDD) — tools/scope-probe.verify.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Verifies tools/scope-probe.html WITHOUT Google credentials.
 *
 * The probe gets run once, by hand, with real credentials, and its verdict
 * decides issue #28 -- whether DDD can drop the restricted auth/drive scope. A
 * wrong verdict is therefore expensive and would not be obvious. This drives all
 * four outcomes against a stubbed Picker and a stubbed Drive endpoint and checks
 * the probe concludes the right thing each time.
 *
 * Only the transport is faked. The checks and the verdict logic under test are
 * the shipped file, loaded from the running server.
 *
 * NOT part of `npm test`: the suite is deliberately dependency-free node:test,
 * and this needs Playwright and a server. Run it by hand when scope-probe.js
 * changes:
 *
 *     python3 serve_secure.py &
 *     node tools/scope-probe.verify.mjs
 *
 * Point PW at your Playwright install if the path below is not yours.
 */
// tools/scope-probe.html has never been run against Google. It will be run ONCE, by hand, with
// real credentials, and its verdict decides #28 — so a wrong verdict is
// expensive. Stub Google's libraries and the Drive endpoint, then drive all four
// outcomes and check the probe concludes the right thing each time.
//
// Only the transport is faked. The probe's own checks and verdict logic are the
// shipped file, loaded from the server.
const PW = process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright/index.js';
const pw = (await import(PW)).default;
const { chromium } = pw;
const BASE = process.env.DDD_BASE || 'http://localhost:8080';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const SCENARIOS = [
  { name: 'grant recurses into subfolders',        children: 'ok',    images: 'ok',    deep: 'ok',    hasSub: true,  expect: /drive\.file is sufficient/ },
  { name: 'grant stops at direct children',        children: 'ok',    images: 'ok',    deep: '403',   hasSub: true,  expect: /not sufficient for recursive/ },
  { name: 'picked folder had no subfolder',        children: 'ok',    images: 'ok',    deep: 'ok',    hasSub: false, expect: /Inconclusive — re-run/ },
  { name: 'folder cannot be enumerated at all',    children: '403',   images: '403',   deep: '403',   hasSub: false, expect: /cannot enumerate a picked folder/ },

  // The case the probe used to get WRONG, and the one most likely to occur.
  //
  // files.list accepts drive.file (Google's discovery document, revision
  // 20260904), so under per-file access the call is PERMITTED and returns only
  // what the app was granted: HTTP 200, empty list. Counting ok as access made
  // the page report "drive.file is sufficient" for precisely the result that
  // proves it is not -- and that is the expensive direction to be wrong in,
  // since acting on it means a migration that cannot scan anything.
  { name: 'permitted but empty — per-file access',  children: 'empty', images: 'empty', deep: 'empty', hasSub: true,  expect: /grants the folder, not its contents/ },
  { name: 'children readable, subfolder empty',     children: 'ok',    images: 'ok',    deep: 'empty', hasSub: true,  expect: /does not reach into subfolders/ },
];

let fails = 0;
for (const s of SCENARIOS) {
  const page = await (await b.newContext()).newPage();

  // Fake Drive. The probe distinguishes its calls by the `q` parameter.
  await page.route('**://www.googleapis.com/drive/v3/**', async (route) => {
    const u = new URL(route.request().url());
    const q = u.searchParams.get('q') || '';
    const deny = () => route.fulfill({ status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 403, message: 'Insufficient permissions for this file' } }) });
    const ok = (files) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files }) });

    if (!q) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 'FOLDER', name: 'Photos', mimeType: 'application/vnd.google-apps.folder' }) });

    if (q.includes("'SUB' in parents"))
      return s.deep === 'ok' ? ok([{ id: 'd1', name: 'deep.jpg', mimeType: 'image/jpeg' }])
           : s.deep === 'empty' ? ok([])            // permitted, nothing granted
           : deny();
    if (q.includes("mimeType contains 'image/'"))
      return s.images === 'ok' ? ok([{ id: 'i1', name: 'a.jpg', md5Checksum: 'abc', thumbnailLink: 'x' }])
           : s.images === 'empty' ? ok([])
           : deny();
    // direct children
    if (s.children === '403') return deny();
    if (s.children === 'empty') return ok([]);
    const kids = [{ id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg' }];
    if (s.hasSub) kids.push({ id: 'SUB', name: '2019', mimeType: 'application/vnd.google-apps.folder' });
    return ok(kids);
  });

  // Fake GIS + Picker, installed before the page's own scripts run.
  await page.addInitScript(() => {
    window.gapi = { load: (_n, cb) => setTimeout(cb, 0) };
    window.google = {
      accounts: { oauth2: { initTokenClient: (cfg) => ({
        requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'FAKE_TOKEN' }), 0),
      }) } },
      picker: {
        ViewId: { FOLDERS: 'folders' },
        Action: { PICKED: 'picked', CANCEL: 'cancel' },
        DocsView: class { constructor() {} setIncludeFolders() { return this; } setSelectFolderEnabled() { return this; } setMimeTypes() { return this; } },
        PickerBuilder: class {
          setOAuthToken() { return this; } setDeveloperKey() { return this; } addView() { return this; }
          setCallback(cb) { this._cb = cb; return this; }
          build() { return this; }
          setVisible() { setTimeout(() => this._cb({ action: 'picked', docs: [{ id: 'FOLDER', name: 'Photos' }] }), 0); }
        },
      },
    };
  });

  await page.goto(`${BASE}/tools/scope-probe.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('run').disabled, { timeout: 8000 });
  await page.fill('#clientId', '123.apps.googleusercontent.com');
  await page.fill('#apiKey', 'AIzaFAKE');
  await page.click('#run');
  await page.waitForFunction(() => document.getElementById('verdict').textContent.trim().length > 0, { timeout: 8000 });

  const v = await page.evaluate(() => ({
    verdict: document.getElementById('verdict').textContent.trim().replace(/\s+/g, ' ').slice(0, 90),
    cls: document.getElementById('verdict').className,
  }));
  const pass = s.expect.test(v.verdict);
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${s.name}`);
  console.log(`        → [${v.cls}] ${v.verdict}…`);
  await page.close();
}
console.log(fails ? `\n${fails} scenario(s) reached the WRONG verdict` : `\nAll ${SCENARIOS.length} verdict paths reach the right conclusion.`);
await b.close();
process.exit(fails ? 1 : 0);
