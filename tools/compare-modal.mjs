/*
 * Drive Dupe Destroyer (DDD) — tools/compare-modal.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/compare-modal.mjs
 */
// #129: the compare modal, driven rather than read.
//
// test/compare-nav.test.js pins the pair arithmetic. This pins that the modal
// is WIRED to it, and — more importantly — that the KEEP badge and the
// "deleting the KEEP file" warning follow the actual keeper rather than the
// left-hand pane.
//
// That last one is not hypothetical. #50 existed because the compare view
// hard-coded the left pane as the keeper while all three call sites passed
// `leftIsKeep: true` unconditionally — correct from render.js, which puts the
// keeper on the left, and wrong from crop.js, which passes group[0] and
// group[1] as they happen to be ordered. The warning then pointed at the wrong
// file on the screen that decides a deletion.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1200);

const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// Three groups. Sizes 3, 2, 2 — and in each, the LARGEST/highest-resolution
// file is deliberately NOT first, so "the keeper" and "the left argument"
// cannot be confused for one another.
const seeded = await page.evaluate(async () => {
  const compare = await import('/js/compare.js');
  const groups = [];
  for (let g = 0; g < 3; g++) {
    const n = g === 0 ? 3 : 2;
    const grp = [];
    for (let i = 0; i < n; i++) {
      // The LAST member is the biggest, so the keep rule ("hires") picks it.
      grp.push({
        id: `g${g}f${i}`, name: `g${g}f${i}.jpg`, size: String(1000 * (i + 1)),
        parents: ['p0'], imageMediaMetadata: { width: 800 + i * 100, height: 600 + i * 100 },
      });
    }
    groups.push(grp);
  }
  window.__groups = groups;
  compare.wireCompare();
  compare.setCompareCallbacks({
    getCurrentGroups: () => window.__groups,
    getPathMap: () => new Map(),
    getIdToEntry: () => new Map(),
    onSelect: () => true,
    onIgnore: () => {},
    onDelete: null,
  });
  return groups.map(g => g.map(f => f.id));
});

console.log('    groups:', JSON.stringify(seeded));

// --- open on a pair and check which pane is the keeper ---------------------
const opened = await page.evaluate(async () => {
  const compare = await import('/js/compare.js');
  const g = window.__groups[0];
  // Deliberately pass the NON-keeper first, the way crop.js does.
  await compare.openCompare(g[0], g[2], { groupIndex: 0, allGroups: window.__groups });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const vis = (id) => {
    const e = document.getElementById(id);
    return !!e && e.style.display !== 'none';
  };
  return {
    modalOpen: document.getElementById('compareModal')?.style.display === 'flex',
    leftKeep: vis('compareLeftKeep'),
    rightKeep: vis('compareRightKeep'),
    progress: document.getElementById('compareProgress')?.textContent || '',
  };
});

ck(opened.modalOpen, '#129 the compare modal opens');
// g0 is [f0(800x600,1000B), f1(900x700,2000B), f2(1000x800,3000B)] and the
// default rule is "hires", so f2 is the keeper — and it was passed SECOND.
ck(opened.rightKeep && !opened.leftKeep,
   `#129 the KEEP badge follows the real keeper, not the left pane `
   + `(left ${opened.leftKeep}, right ${opened.rightKeep})`);
ck(/Group 1 of 3/.test(opened.progress),
   `#129 the progress label counts reviewable groups ("${opened.progress}")`);

// --- walk forward through every pair ---------------------------------------
const walk = await page.evaluate(async () => {
  const compare = await import('/js/compare.js');
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const btn = document.getElementById('btnCompareNext');
    if (!btn) break;
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    const label = document.getElementById('compareProgress')?.textContent || '';
    const left = document.getElementById('compareLeftTitle')?.textContent || '';
    const right = document.getElementById('compareRightTitle')?.textContent || '';
    seen.push({ label, left, right });
  }
  return seen;
});

const labels = walk.map(w => w.label).filter(Boolean);
ck(labels.length > 0, `#129 Next walks the pairs (${labels.length} steps)`);
ck(labels.some(l => /Group 2 of 3/.test(l)),
   `#129 and crosses into the next group (${[...new Set(labels)].join(' | ')})`);
ck(walk.every(w => !w.left || !w.right || w.left !== w.right),
   '#129 no step ever compares a file with itself');

// --- a group that collapses while the modal is open ------------------------
const collapsed = await page.evaluate(async () => {
  const compare = await import('/js/compare.js');
  // Trash both duplicates out of group 1, leaving one member: it now has
  // nothing to compare and must be skipped, not shown.
  window.__groups[1] = [window.__groups[1][0]];
  await compare.openCompare(window.__groups[0][2], window.__groups[0][0],
    { groupIndex: 0, allGroups: window.__groups });
  await new Promise(r => setTimeout(r, 120));
  const labels = [];
  for (let i = 0; i < 6; i++) {
    document.getElementById('btnCompareNext')?.click();
    await new Promise(r => setTimeout(r, 120));
    labels.push(document.getElementById('compareProgress')?.textContent || '');
  }
  const names = [
    document.getElementById('compareLeftTitle')?.textContent || '',
    document.getElementById('compareRightTitle')?.textContent || '',
  ];
  return { labels, names };
});

ck(!collapsed.names.some(n => /^g1f/.test(n)),
   `#129 a group that collapsed to one member is skipped, never shown `
   + `(landed on ${JSON.stringify(collapsed.names)})`);
ck(collapsed.labels.some(l => /of 2/.test(l)),
   `#129 and the total renumbers to the groups that remain reviewable `
   + `(${[...new Set(collapsed.labels.filter(Boolean))].join(' | ')})`);

await page.evaluate(async () => {
  const compare = await import('/js/compare.js');
  compare.closeCompare?.();
});

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
