/*
 * Drive Dupe Destroyer (DDD) — tools/live-keeper.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/live-keeper.mjs
 */
// #91: the live table and the finished scan must nominate the SAME file to keep.
//
// The keeper is the one file not offered for deletion, and the app invites you
// to act on the live table while the scan runs. The folder-priority rule ranks
// on the resolved folder path, which used to arrive only in phase 4 — so the
// live table picked a keeper by tie-break and silently changed its mind at the
// end. This drives the real render module rather than chooseKeepIndex directly,
// because the defect was in WHEN the render path had the data, not in the rule.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext()).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2000);

let f = 0; const ck = (ok, l) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); if (!ok) f++; };

const r = await page.evaluate(async () => {
  const render = await import('/js/render.js');

  // Two copies of one photo: the keeper by folder priority is the one under
  // /Originals. Created times are arranged so the tie-break — which is all the
  // live table had before #91 — picks the OTHER one, making a silent
  // divergence visible rather than a coin flip.
  const group = [
    { id: 'copy', name: 'copy.jpg', createdTime: '2020-01-01T00:00:00Z',
      modifiedTime: '2021-01-01T00:00:00Z', size: 100, parents: ['dl'] },
    { id: 'orig', name: 'original.jpg', createdTime: '2021-01-01T00:00:00Z',
      modifiedTime: '2021-01-01T00:00:00Z', size: 100, parents: ['og'] },
  ];
  const paths = [['copy', '/My Drive/Downloads'], ['orig', '/My Drive/Originals']];

  // Read the rendered table, not an internal. `keepRow` is the class the row
  // gets when it is the keeper, and `deleteCandidate` is what "Select all"
  // sweeps into the delete set — so this is literally what the user would act
  // on.
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const onScreen = () => ({
    keep: [...document.querySelectorAll('#resultsTbody tr.keepRow')].map(t => t.dataset.fileId),
    offeredForDeletion: [...document.querySelectorAll('#resultsTbody tr.deleteCandidate')].map(t => t.dataset.fileId),
  });

  const entry = { base12: new Uint8Array(18), base8: new Uint8Array(8) };
  const idToEntry = new Map(group.map(f => [f.id, entry]));

  // --- live session, before any path has been resolved ---------------------
  render.beginProgressive({ idToEntry, keepRule: 'folderPriority', folderPriority: 'originals' });
  render.pushProgressiveMatch({ root: 'r1', group });
  await settle();
  const beforePaths = onScreen();

  // --- the paths arrive mid-scan -------------------------------------------
  render.mergeProgressivePaths(paths);
  await settle();
  const afterPaths = onScreen();

  // --- and what the finished scan renders ----------------------------------
  render.endProgressive();
  for (const g of group) delete g._path;
  await render.renderGroups({
    groups: [group], idToEntry, pathMap: new Map(paths),
    keepRule: 'folderPriority', folderPriority: 'originals',
  });
  await settle();
  const final = onScreen();

  return { beforePaths, afterPaths, final };
});

console.log('  ', r);
ck(r.final.keep.join() === 'orig', '#91 the finished scan keeps the file under the priority folder');
ck(r.afterPaths.keep.join() === 'orig', '#91 the live table agrees once the paths arrive');
ck(r.afterPaths.offeredForDeletion.join() === 'copy',
   '#91 and the live table offers the right file for deletion');
ck(JSON.stringify(r.afterPaths) === JSON.stringify(r.final),
   '#91 live and final nominate the SAME keeper');

console.log(f ? `\n${f} FAILED` : '\nALL CHECKS PASSED');
await b.close();
process.exit(f ? 1 : 0);
