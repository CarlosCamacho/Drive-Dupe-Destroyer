/*
 * Drive Dupe Destroyer (DDD) — tools/review-persistence.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/review-persistence.mjs
 */
// #117: the review survives a reload, the way the scan already did.
//
// test/review-state.test.js pins the rules. This pins that they are actually
// WIRED -- that pinning a keeper and trashing from a group really do record
// something, that a reload really does bring it back, and that a different
// folder selection really does start clean. Calling the functions directly
// would prove none of that, which is the lesson of #113.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);

const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Render three groups of three under a given folder scope. */
const seed = (folderIds) => page.evaluate(async (folderIds) => {
  const render = await import('/js/render.js');
  const ui = await import('/js/ui.js');
  const groups = [];
  const pathMap = new Map();
  for (let g = 0; g < 3; g++) {
    const grp = [];
    for (let i = 0; i < 3; i++) {
      const id = `g${g}f${i}`;
      grp.push({ id, name: `${id}.jpg`, size: String(1e6 * (i + 1)), parents: ['p0'],
                 imageMediaMetadata: { width: 800 + i, height: 600 + i } });
      pathMap.set(id, '/Photos');
    }
    groups.push(grp);
  }
  ui.setSignedInUi(true, 'x.apps.googleusercontent.com');
  render.wireRenderControls();
  await render.restoreReviewState({ folderIds, exclusions: new Set() });
  await render.renderGroups({ groups, idToEntry: new Map(), pathMap });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return render.reviewProgress();
}, folderIds);

const before = await seed(['folderA']);
ck(before.total === 3 && before.untouched === 3,
   `#117 a fresh review starts with everything untouched (${before.untouched}/${before.total})`);

// --- pin a keeper, and ignore a group -------------------------------------
const marked = await page.evaluate(async () => {
  const render = await import('/js/render.js');
  // Pin a different keeper in the first group.
  document.querySelector('#resultsTbody [data-action="pin-keep"]')?.click();
  await new Promise(r => setTimeout(r, 200));
  // "Ignore this group" is the explicit skip.
  window.dispatchEvent(new CustomEvent('ddd:ignoreGroup', { detail: { groupIndex: 2 } }));
  await new Promise(r => setTimeout(r, 200));
  const st = render.getReviewState();
  return {
    marks: [...st.marks.values()],
    keepers: st.keepers.size,
    progress: render.reviewProgress(),
    statsText: document.getElementById('filterStats')?.textContent || '',
  };
});

ck(marked.keepers === 1, `#117 pinning a keeper is recorded (${marked.keepers})`);
ck(marked.marks.includes('skipped'), `#117 ignoring a group records a skip (${JSON.stringify(marked.marks)})`);
ck(/reviewed/.test(marked.statsText),
   `#117 and the toolbar says how much is left ("${marked.statsText}")`);

// --- reload, same folders: it all comes back ------------------------------
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1000);
const restored = await seed(['folderA']);
const restoredDetail = await page.evaluate(async () => {
  const render = await import('/js/render.js');
  const st = render.getReviewState();
  return { keepers: st.keepers.size, marks: [...st.marks.values()] };
});

ck(restoredDetail.keepers === 1,
   `#117 the pinned keeper survives a reload (${restoredDetail.keepers})`);
ck(restoredDetail.marks.includes('skipped'),
   `#117 and so does the skip (${JSON.stringify(restoredDetail.marks)})`);
ck(restored.untouched < restored.total,
   `#117 so the review resumes rather than starting over (${restored.untouched} of ${restored.total} still untouched)`);

// --- a DIFFERENT folder selection starts clean ----------------------------
const otherScope = await seed(['folderB']);
const otherDetail = await page.evaluate(async () => {
  const render = await import('/js/render.js');
  const st = render.getReviewState();
  return { keepers: st.keepers.size, marks: st.marks.size };
});
ck(otherScope.untouched === otherScope.total && otherDetail.marks === 0 && otherDetail.keepers === 0,
   `#117 a different folder selection does NOT inherit the review `
   + `(${otherScope.untouched}/${otherScope.total} untouched, ${otherDetail.marks} marks)`);

// --- the Unreviewed only filter ------------------------------------------
await seed(['folderA']);
const filtered = await page.evaluate(async () => {
  const render = await import('/js/render.js');
  const all = render.getRowCount();
  const sel = document.getElementById('filterMode');
  sel.value = 'unreviewed';
  sel.onchange();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const unreviewed = render.getRowCount();
  sel.value = 'all';
  sel.onchange();
  return { all, unreviewed };
});
ck(filtered.unreviewed > 0 && filtered.unreviewed < filtered.all,
   `#117 "Unreviewed only" hides the groups already dealt with (${filtered.unreviewed} of ${filtered.all} rows)`);

await page.evaluate(async () => {
  const r = await import('/js/reviewState.js');
  await r.clearReviewState();
});

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
