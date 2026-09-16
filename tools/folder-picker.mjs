/*
 * Drive Dupe Destroyer (DDD) — tools/folder-picker.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/folder-picker.mjs
 */
// #124: the folder picker is the gate in front of the whole app, and had no
// coverage at all.
//
// test/folder-selection.test.js pins the set arithmetic in Node, which is most
// of the risk. This drives the real modal, because the arithmetic being right
// does not help if the buttons are not wired to it -- which is precisely how
// #113 happened.
//
// Drive is stubbed at fetch level rather than mocked at module level: ES module
// exports are read-only bindings, so there is no way to swap driveFetch from
// outside, and stubbing the network is what the rest of the harness suite does.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));

// A small fake Drive: My Drive holds three folders, one of which has a child.
await page.addInitScript(() => {
  const FOLDERS = {
    root:  [{ id: 'f1', name: 'Photos 2024' }, { id: 'f2', name: 'Photos 2025' }, { id: 'f3', name: 'Screenshots' }],
    f1:    [{ id: 'f1a', name: 'January' }],
    f2:    [], f3:    [], f1a:   [],
  };
  const META = { root: { id: 'root', name: 'My Drive' } };
  for (const kids of Object.values(FOLDERS)) for (const k of kids) META[k.id] = k;

  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/drive/v3/files') && u.includes('q=')) {
      const q = decodeURIComponent(new URL(u, location.origin).searchParams.get('q') || '');
      const parent = (q.match(/'([^']+)'\s+in\s+parents/) || [])[1] || 'root';
      const files = (FOLDERS[parent] || []).map(f => ({
        ...f, mimeType: 'application/vnd.google-apps.folder', parents: [parent],
      }));
      return new Response(JSON.stringify({ files }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const meta = u.match(/\/drive\/v3\/files\/([^/?]+)/);
    if (meta && META[meta[1]]) {
      return new Response(JSON.stringify({ ...META[meta[1]], mimeType: 'application/vnd.google-apps.folder' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  // The picker's Drive calls go through driveFetch -> authedFetch, which will
  // not issue a request without a token. Same fake GIS the other harnesses
  // use, and the real gsi/client script is aborted below so Google's own
  // bundle cannot overwrite window.google after we set it.
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
await page.evaluate(async () => {
  const auth = await import('/js/auth.js');
  await auth.ensureToken();
});

const settle = () => page.evaluate(() => new Promise(r => setTimeout(r, 250)));

// Open the picker through the same handler the button calls.
const opened = await page.evaluate(async () => {
  const fp = await import('/js/folderPicker.js');
  fp.wireFolderPicker();
  const btn = document.getElementById('btnPickFolders');
  btn.disabled = false;
  btn.click();
  await new Promise(r => setTimeout(r, 600));
  return {
    modalOpen: document.getElementById('folderModal')?.style.display === 'flex',
    rows: document.querySelectorAll('#folderList .folderRow, #folderList > div').length,
    listText: document.getElementById('folderList')?.textContent?.slice(0, 200) || '',
  };
});

ck(opened.modalOpen, '#124 the picker opens');
ck(/Photos 2024/.test(opened.listText),
   `#124 and lists the folders Drive returned (${opened.listText.replace(/\s+/g, ' ').slice(0, 80)})`);

// --- include, exclude, and the chips -------------------------------------
const afterInclude = await page.evaluate(async () => {
  const fp = await import('/js/folderPicker.js');
  // Click the BUTTONS, and re-query between clicks.
  //
  // The first version of this collected "rows" as `#folderList div` filtered by
  // containing a .btnInclude -- which also matches wrapper divs, so rows[0] and
  // rows[1] were an ancestor and its child, and Include then Exclude both
  // landed on the same folder. It looked exactly like Include being broken.
  // renderList() also rebuilds the list after every click, so anything captured
  // beforehand is detached by the time it is used.
  const btn = (cls, i) => document.querySelectorAll(`#folderList .${cls}`)[i];
  btn('btnInclude', 0)?.click();
  await new Promise(r => setTimeout(r, 400));
  btn('btnExclude', 1)?.click();
  await new Promise(r => setTimeout(r, 400));
  return {
    included: fp.getIncludedFolderIds(),
    excluded: [...fp.getExclusions()],
    count: document.getElementById('includedCount')?.textContent,
    summary: document.getElementById('foldersSummary')?.textContent,
    chips: document.querySelectorAll('#includedChips .chip').length,
    includeChips: document.querySelectorAll('#includedChips .chipInclude').length,
    excludeChips: document.querySelectorAll('#includedChips .chipExclude').length,
  };
});

ck(afterInclude.included.length === 1 && afterInclude.excluded.length === 1,
   `#124 Include and Exclude each reach the selection (included ${JSON.stringify(afterInclude.included)}, `
   + `excluded ${JSON.stringify(afterInclude.excluded)})`);
ck(afterInclude.included[0] !== afterInclude.excluded[0],
   '#124 and a folder is never in both');
ck(afterInclude.count === '1', `#124 the sidebar count follows (${afterInclude.count})`);
ck(/1 included, 1 excluded/.test(afterInclude.summary || ''),
   `#124 as does the summary line ("${afterInclude.summary}")`);
ck(afterInclude.includeChips === 1 && afterInclude.excludeChips === 1,
   `#124 one chip each, coloured by side (${afterInclude.includeChips} include, ${afterInclude.excludeChips} exclude)`);

// --- Include All / Exclude All over what is visible ----------------------
const afterAll = await page.evaluate(async () => {
  const fp = await import('/js/folderPicker.js');
  document.getElementById('btnIncludeAll').click();
  await new Promise(r => setTimeout(r, 400));
  const allIncluded = { included: fp.getIncludedFolderIds().length, excluded: [...fp.getExclusions()].length };
  document.getElementById('btnExcludeAll').click();
  await new Promise(r => setTimeout(r, 400));
  const allExcluded = { included: fp.getIncludedFolderIds().length, excluded: [...fp.getExclusions()].length };
  return { allIncluded, allExcluded };
});

ck(afterAll.allIncluded.included === 3 && afterAll.allIncluded.excluded === 0,
   `#124 Include All takes every visible folder and clears the exclusions `
   + `(${afterAll.allIncluded.included} in, ${afterAll.allIncluded.excluded} out)`);
ck(afterAll.allExcluded.excluded === 3 && afterAll.allExcluded.included === 0,
   `#124 Exclude All is the exact mirror (${afterAll.allExcluded.included} in, ${afterAll.allExcluded.excluded} out)`);

// --- Clear All ------------------------------------------------------------
const afterClear = await page.evaluate(async () => {
  const fp = await import('/js/folderPicker.js');
  document.getElementById('btnClearAll').click();
  await new Promise(r => setTimeout(r, 400));
  return {
    included: fp.getIncludedFolderIds().length,
    excluded: [...fp.getExclusions()].length,
    summary: document.getElementById('foldersSummary')?.textContent,
    chips: document.querySelectorAll('#includedChips .chip').length,
  };
});
ck(afterClear.included === 0 && afterClear.excluded === 0 && afterClear.chips === 0,
   '#124 Clear All empties both sets and removes the chips');
ck(afterClear.summary === 'None selected', `#124 and the summary goes back ("${afterClear.summary}")`);

// --- what the scan is actually handed -------------------------------------
const handed = await page.evaluate(async () => {
  const fp = await import('/js/folderPicker.js');
  document.querySelectorAll('#folderList .btnInclude')[0]?.click();
  await new Promise(r => setTimeout(r, 400));
  const folders = fp.getIncludedFolders();
  return {
    ids: fp.getIncludedFolderIds(),
    named: folders.every(f => f.name && f.name.length > 0),
    exclusionsIsSet: fp.getExclusions() instanceof Set,
  };
});
ck(handed.ids.length === 1, '#124 the scan is handed the included ids');
ck(handed.named, '#124 with their names, which the scan-history record needs');
ck(handed.exclusionsIsSet, '#124 and the exclusions as a Set, which is what runScan expects');

// --- NOT covered, and worth saying out loud -------------------------------
const survives = await page.evaluate(async () => {
  const fp = await import('/js/folderPicker.js');
  return fp.getIncludedFolderIds().length;
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(800);
const afterReload = await page.evaluate(async () => {
  const fp = await import('/js/folderPicker.js');
  return fp.getIncludedFolderIds().length;
});
ck(survives === 1 && afterReload === 0,
   `#124 the selection does NOT survive a reload — pinning the behaviour as it is, `
   + `not as it should be (${survives} before, ${afterReload} after)`);

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
