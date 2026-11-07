/*
 * Drive Dupe Destroyer (DDD) — tools/mobile-layout.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/mobile-layout.mjs
 */
// The app on a phone (14.8.3).
//
// Two things were wrong, both measured here rather than judged by eye:
//   1. The shell is a fixed 100vh. On a 412x915 phone the header, settings
//      panel and scan controls took 784px of it and the results table got a
//      66px window -- about one row -- so the duplicates a scan had found sat
//      scrolled inside a slot you could barely see.
//   2. In the folder picker a 33-character Drive folder ID ran underneath the
//      Include / Exclude buttons, and "Include All", "Exclude All" and "Done"
//      were clipped at the edge of the dialog.
// Desktop must not move at all.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// A fake Drive whose folders have realistic IDs and names.
const LONG = [
  { id: '137iOB0bAw9aj6GYJNUef5M_GGVi-9HjL', name: '_Master_Unsorted' },
  { id: '1uaPWoD137-SeFhoIzi5f3GvhspDsbkw7', name: 'AI Art' },
  { id: '10V_W55TKe_ESzDGAGN9-Hg_PxDEATScu', name: 'AI Training' },
  { id: '1pSzahoQf2V33n4v6zfhCsHI3WtYk5EI_', name: 'A folder with a rather long name that goes on and on' },
];

async function open(viewport, mobile) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.route('**/gsi/client*', r => r.abort());
  await page.addInitScript((LONG) => {
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/drive/v3/files') && u.includes('q=')) {
        const files = LONG.map(f => ({ ...f, mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }));
        return new Response(JSON.stringify({ files }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (/\/drive\/v3\/files\/root/.test(u)) {
        return new Response(JSON.stringify({ id: 'root', name: 'My Drive', mimeType: 'application/vnd.google-apps.folder' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url, opts);
    };
    window.google = { accounts: { oauth2: {
      initTokenClient: () => {
        const c = { callback: null };
        c.requestAccessToken = () => setTimeout(() => c.callback({ access_token: 'tok', expires_in: 3600 }), 5);
        return c;
      },
      revoke: (t, cb) => { cb && cb(); },
    } } };
  }, LONG);
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    await db.settingSet('destroyer_oauth_client_id', '1092202587-abcdefghijklmnop.apps.googleusercontent.com');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const auth = await import('/js/auth.js');
    await auth.ensureToken({ forcePrompt: true });
    const ui = await import('/js/ui.js');
    ui.setSignedInUi(true, '1092202587-abcdefghijklmnop.apps.googleusercontent.com');
    const am = document.getElementById('authModal'); if (am) am.style.display = 'none';
    const render = await import('/js/render.js');
    render.wireRenderControls();
    const groups = [];
    for (let g = 0; g < 8; g++) {
      groups.push([0, 1].map(i => ({
        id: `g${g}f${i}`, name: `Screenshot_20240630-10004${g}${i}.png`, size: String(1e6 * (2 - i)), parents: ['p'],
        imageMediaMetadata: { width: 1080, height: 2460 },
      })));
    }
    await render.renderGroups({ groups, idToEntry: new Map(), pathMap: new Map(), keepRule: 'hires' });
  });
  await page.waitForTimeout(500);
  return { ctx, page };
}

const rect = (page, sel) => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, h: r.height };
}, sel);

// --- phones ---------------------------------------------------------------
for (const [label, vp] of [['412x915', { width: 412, height: 915 }], ['360x640', { width: 360, height: 640 }]]) {
  const { ctx, page } = await open(vp, true);

  const wrap = await rect(page, '.tableWrap');
  ck(wrap.h >= 320, `${label}: the results table gets a usable window (${Math.round(wrap.h)}px; it was 66px)`);

  // Scroll the page to the table: it should then fill most of the screen.
  await page.evaluate(() => document.querySelector('.tableWrap').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  const seen = await page.evaluate(() => {
    const w = document.querySelector('.tableWrap').getBoundingClientRect();
    const visible = Math.min(w.bottom, innerHeight) - Math.max(w.top, 0);
    const rows = [...document.querySelectorAll('#resultsTbody tr[data-file-id]')].filter(tr => {
      const r = tr.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    }).length;
    return { visible: Math.round(visible), rows, vh: innerHeight };
  });
  ck(seen.visible >= seen.vh * 0.6, `${label}: scrolled to, the table fills the screen (${seen.visible}px of ${seen.vh})`);
  ck(seen.rows >= 3, `${label}: with several duplicate rows in view at once (${seen.rows})`);

  // SHOTS=/some/dir saves what was measured, for looking at.
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${label}-results.png` });

  const pageScrolls = await page.evaluate(() => document.scrollingElement.scrollHeight > innerHeight + 50);
  ck(pageScrolls, `${label}: the page itself scrolls, so nothing is trapped in a fixed shell`);
  const noSideways = await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1);
  ck(noSideways, `${label}: and does not scroll sideways`);

  // The folder picker, through the real code.
  await page.evaluate(() => document.getElementById('btnPickFolders')?.click());
  await page.waitForSelector('#folderModal .folderRow', { state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  const picker = await page.evaluate(() => {
    const out = { rows: [], footer: [] };
    const modal = document.querySelector('#folderModal .modalContent').getBoundingClientRect();
    // Where the text actually PAINTS, not where its box is. A box can be
    // narrow and fine while its text spills out of it: that is exactly what
    // the 33-character folder ID did, so comparing boxes passed on the broken
    // layout. A clipped (overflow:hidden) element only shows what is inside it.
    const paintedRect = (el) => {
      const box = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const t = range.getBoundingClientRect();
      const clips = getComputedStyle(el).overflow !== 'visible';
      return {
        left: t.left, top: t.top, bottom: t.bottom,
        right: clips ? Math.min(t.right, box.right) : t.right,
      };
    };
    const hit = (a, b) => !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 ||
                            a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5);
    for (const row of document.querySelectorAll('#folderModal .folderRow')) {
      const act = row.querySelector('.folderActions').getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const texts = [row.querySelector('.folderInfo b'), row.querySelector('.folderId')].map(paintedRect);
      out.rows.push({
        overlap: texts.some(t => hit(t, act)),
        actionsInside: act.right <= rr.right + 0.5 && act.left >= rr.left - 0.5,
        textInside: texts.every(t => t.right <= rr.right + 0.5),
      });
    }
    for (const btn of document.querySelectorAll('#folderModal .modalFooter button')) {
      const r = btn.getBoundingClientRect();
      out.footer.push({
        label: btn.textContent.trim(),
        inside: r.left >= modal.left - 0.5 && r.right <= modal.right + 0.5,
        textClipped: btn.scrollWidth > btn.clientWidth + 1,
      });
    }
    out.n = out.rows.length;
    return out;
  });
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${label}-folders.png` });
  ck(picker.n === LONG.length, `${label}: the picker lists the folders (${picker.n})`);
  ck(picker.rows.every(r => !r.overlap), `${label}: a folder's name and ID never run under its buttons`);
  ck(picker.rows.every(r => r.actionsInside), `${label}: the Include / Exclude / Open buttons stay inside their row`);
  ck(picker.rows.every(r => r.textInside), `${label}: and the name and ID text stay inside the row`);
  ck(picker.footer.every(f => f.inside), `${label}: every footer button is inside the dialog (${picker.footer.map(f => f.label).join(' | ')})`);
  ck(picker.footer.every(f => !f.textClipped), `${label}: and none of their labels is clipped`);
  await ctx.close();
}

// --- desktop must not move --------------------------------------------------
{
  const { ctx, page } = await open({ width: 1400, height: 900 }, false);
  const d = await page.evaluate(() => ({
    pageScrolls: document.scrollingElement.scrollHeight > innerHeight + 1,
    appH: document.querySelector('.app').getBoundingClientRect().height,
    vh: innerHeight,
    wrap: document.querySelector('.tableWrap').getBoundingClientRect().height,
    leftW: document.querySelector('.leftPanel').getBoundingClientRect().width,
  }));
  ck(!d.pageScrolls && Math.abs(d.appH - d.vh) <= 1, `desktop: still one fixed-height shell, the page does not scroll (${Math.round(d.appH)} of ${d.vh})`);
  ck(d.leftW >= 260 && d.leftW <= 300, `desktop: the settings panel is still a sidebar (${Math.round(d.leftW)}px)`);
  ck(d.wrap > 300, `desktop: and the table takes the remaining height (${Math.round(d.wrap)}px)`);
  await ctx.close();
}

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
