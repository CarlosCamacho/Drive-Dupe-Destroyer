/*
 * Drive Dupe Destroyer (DDD) — tools/thumb-loading.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/thumb-loading.mjs
 */
// #119: one thumbnail loader, and it still loads thumbnails.
//
// Deleting the throttled scroll/wheel/window handler is only safe if the
// IntersectionObserver really does cover what it covered. The interesting case
// is the one the scroll path existed for: rows that were NOT in the first
// rendered window, reached by scrolling, in a virtualised table where the rows
// themselves are created and destroyed as you go.
//
// Thumbnails are served from this repo's own screenshots, so a load is a real
// load rather than a network failure that happens to set the same flag.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1500);

const GROUPS = 40;   // 120 rows at 58px = ~7000px, far beyond one window

const seeded = await page.evaluate(async (GROUPS) => {
  const render = await import('/js/render.js');
  const ui = await import('/js/ui.js');
  const groups = [];
  const pathMap = new Map();
  for (let g = 0; g < GROUPS; g++) {
    const grp = [];
    for (let i = 0; i < 3; i++) {
      const id = `g${g}f${i}`;
      grp.push({
        id, name: `${id}.jpg`, size: String(1e6 * (i + 1)), parents: ['p0'],
        imageMediaMetadata: { width: 800 + i, height: 600 + i },
        // A real image this server will actually serve.
        thumbnailLink: `http://localhost:8080/docs/screenshots/01-home-ready.png`,
      });
      pathMap.set(id, '/Photos');
    }
    groups.push(grp);
  }
  ui.setSignedInUi(true, 'x.apps.googleusercontent.com');
  render.wireRenderControls();
  await render.renderGroups({ groups, idToEntry: new Map(), pathMap });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  return groups.length * 3;
}, GROUPS);

// Count the rows that are actually ON SCREEN, not every row in the DOM.
//
// renderVisibleRows paints BUFFER_ROWS (10) above and below the viewport, and
// the observer's rootMargin is 200px -- so buffered rows are deliberately NOT
// loaded yet. An assertion over every painted <img> therefore fails on correct
// code, which is what the first version of this check did (14 of 28, and the
// other 14 were buffer). Lazy loading that loaded the buffer would be the bug.
await page.addInitScript(() => {});
const visibleThumbs = () => page.evaluate(() => {
  const wrap = document.querySelector('.tableWrap');
  const w = wrap.getBoundingClientRect();
  const imgs = [...document.querySelectorAll('#resultsTbody img.thumb')];
  const onScreen = imgs.filter(i => {
    const r = i.getBoundingClientRect();
    return r.bottom > w.top && r.top < w.bottom;
  });
  const loaded = (i) => i.src && !i.src.startsWith('data:');
  return {
    painted: imgs.length,
    onScreen: onScreen.length,
    onScreenLoaded: onScreen.filter(loaded).length,
    buffered: imgs.length - onScreen.length,
    bufferedLoaded: imgs.filter(i => !onScreen.includes(i)).filter(loaded).length,
    ids: onScreen.slice(0, 3).map(i => i.dataset.fileId),
  };
});

await page.waitForTimeout(600);
const first = await visibleThumbs();
ck(first.onScreen > 0 && first.onScreenLoaded === first.onScreen,
   `#119 the first window's visible thumbnails load (${first.onScreenLoaded}/${first.onScreen}, `
   + `${first.buffered} buffered rows painted but not fetched)`);

// Scroll deep into the table. Rows here were never in the DOM at render time.
await page.evaluate(() => { document.querySelector('.tableWrap').scrollTop = 4000; });
await page.waitForTimeout(900);
const deep = await visibleThumbs();
ck(deep.onScreen > 0 && deep.onScreenLoaded === deep.onScreen,
   `#119 scrolling to rows that were never rendered still loads them (${deep.onScreenLoaded}/${deep.onScreen})`);
ck(!deep.ids.includes('g0f0'),
   `#119 and those really are different rows (${deep.ids.join(', ')})`);

// Disconnect the observer: if a second mechanism survived, thumbnails would
// still appear after a scroll, and this check would pass when it should not.
await page.evaluate(() => {
  document.querySelectorAll('#resultsTbody img.thumb').forEach(i => { i.src = i.dataset.placeholder || ''; });
});
await page.evaluate(async () => {
  const render = await import('/js/render.js');
  render.__test_disconnectThumbObserver?.();
  document.querySelector('.tableWrap').scrollTop = 0;
  await new Promise(r => setTimeout(r, 400));
  document.querySelector('.tableWrap').scrollTop = 6000;
  await new Promise(r => setTimeout(r, 700));
});
const orphaned = await visibleThumbs();
ck(orphaned.onScreen > 0 && orphaned.onScreenLoaded === 0,
   `#119 with the observer disconnected nothing loads, so it is the ONLY mechanism `
   + `(${orphaned.onScreenLoaded}/${orphaned.onScreen} loaded)`);

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
