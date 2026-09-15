/*
 * Drive Dupe Destroyer (DDD) — tools/resume-cost.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/resume-cost.mjs
 */
// #99: what the scan-resume checkpoints actually cost, and what they buy.
//
// Every checkpoint serialises the whole accumulated file list, so the cost is
// quadratic in library size and invisible from anywhere in the code. It needs a
// real page: the payload goes through structuredClone into IndexedDB, and only
// a browser measures that honestly.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);

const r = await page.evaluate(async () => {
  const resume = await import('/js/resume.js');
  const { checkpointInterval } = await import('/js/scan.js');

  // A Drive file carrying the fields js/scan.js actually requests.
  const file = (i) => ({
    id: '1' + String(i).padStart(32, 'a'),
    name: `IMG_${i}_holiday_photo_from_the_trip.jpg`,
    mimeType: 'image/jpeg', size: String(2_400_000 + i),
    modifiedTime: '2026-03-04T11:22:33.000Z', createdTime: '2026-03-04T11:20:00.000Z',
    parents: ['0B' + String(i % 500).padStart(30, 'z')],
    thumbnailLink: `https://lh3.googleusercontent.com/drive-storage/${'x'.repeat(60)}=s220`,
    md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
    webViewLink: `https://drive.google.com/file/d/1${'a'.repeat(32)}/view?usp=drivesdk`,
    imageMediaMetadata: { width: 4032, height: 3024, time: '2026:03:04 11:20:00' },
  });

  const TOTAL_FILES = 20000, TOTAL_FOLDERS = 500;
  const all = Array.from({ length: TOTAL_FILES }, (_, i) => file(i));

  // Walk the library, checkpointing the way runScan does, and total the cost.
  const simulate = async (intervalFor) => {
    let bytes = 0, writes = 0;
    const t0 = performance.now();
    for (let folder = 1; folder <= TOTAL_FOLDERS; folder++) {
      const soFar = Math.round(TOTAL_FILES * folder / TOTAL_FOLDERS);
      if (folder % intervalFor(soFar) !== 0) continue;
      const state = {
        folderIds: ['root'], exclusions: [],
        visitedFolderIds: Array.from({ length: folder }, (_, i) => 'f' + i),
        pendingFolderIds: Array.from({ length: TOTAL_FOLDERS - folder }, (_, i) => 'p' + i),
        files: all.slice(0, soFar), totalImagesFound: soFar, options: {},
      };
      // What resume.js will actually store, after it strips rebuildable fields.
      bytes += new Blob([JSON.stringify({ ...state, files: state.files.map(({ webViewLink, ...f }) => f) })]).size;
      writes++;
      await resume.saveResumeState(state);
    }
    return { writes, mb: +(bytes / 1048576).toFixed(1), seconds: +((performance.now() - t0) / 1000).toFixed(1) };
  };

  const flat25 = await simulate(() => 25);
  const scaled = await simulate(checkpointInterval);

  // webViewLink must survive the round trip even though it is not stored: the
  // CSV export has a column for it.
  await resume.clearResumeState();
  await resume.saveResumeState({
    folderIds: ['root'], exclusions: [], visitedFolderIds: ['f1'],
    pendingFolderIds: ['p1'], files: [file(7)], totalImagesFound: 1, options: {},
  });
  const back = await resume.loadResumeState();
  const raw = await (await import('/js/db.js')).stateGet('destroyer_scan_resume_v1');

  await resume.clearResumeState();
  return {
    flat25, scaled,
    storedHasWebViewLink: 'webViewLink' in raw.files[0],
    loadedWebViewLink: back.files[0].webViewLink,
    loadedId: back.files[0].id,
    intervals: [0, 1000, 5000, 12000, 20000].map(n => [n, checkpointInterval(n)]),
  };
});

console.log('  20,000 images across 500 folders:');
console.log('    flat 25 folders :', r.flat25);
console.log('    scaled interval :', r.scaled);
console.log('  intervals by files collected:', JSON.stringify(r.intervals));

ck(r.scaled.mb < r.flat25.mb * 0.7,
   `#99 scaling the interval cuts the bytes written (${r.flat25.mb} MB -> ${r.scaled.mb} MB)`);
ck(r.scaled.writes < r.flat25.writes,
   `#99 and the number of writes (${r.flat25.writes} -> ${r.scaled.writes})`);
ck(r.intervals[0][1] === 25 && r.intervals[1][1] === 25,
   '#99 a small library still checkpoints every 25 folders');
ck(r.storedHasWebViewLink === false,
   '#99 webViewLink is not stored — it is 16% of the payload and rebuildable');
ck(r.loadedWebViewLink === `https://drive.google.com/file/d/${r.loadedId}/view`,
   '#99 but it IS rebuilt on load, so the CSV export keeps its column');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
