/*
 * Drive Dupe Destroyer (DDD) — tools/crop-replace.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/crop-replace.mjs
 */
// Cropping replaces the original without asking (v14.8.2).
//
// Every crop used to stop on "Move the original to Google Drive Trash?", and
// the answer was always yes. Now Crop uploads the cropped copy, moves the
// original to Trash, and says so in ONE toast that carries the Undo. Driven
// through the real crop modal and the real buttons, against a fake Drive.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';
let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.route('**/gsi/client*', r => r.abort());
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
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.evaluate(async (id) => {
  const db = await import('/js/db.js');
  await db.settingSet('destroyer_oauth_client_id', id);
}, CLIENT_ID);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);

await page.evaluate(async () => {
  const auth = await import('/js/auth.js');
  await auth.ensureToken({ forcePrompt: true });
  window.__uploads = 0;
  window.__trashed = [];
  window.__restored = [];
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/upload/drive/v3/files')) {
      window.__uploads++;
      return new Response(JSON.stringify({ id: 'cropped1', name: 'orig (cropped).png', parents: ['p'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('alt=media')) {
      const png = await realFetch('/docs/screenshots/01-home-ready.png');
      return new Response(await png.blob(), { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (u.includes('/batch/drive/v3')) {
      const parts = [...String(opts.body || '').matchAll(/^Content-ID: (.+)$/gm)].map(m => m[1].trim());
      parts.forEach(id => window.__trashed.push(id));
      const bound = 'batch_resp';
      return new Response(
        parts.map(id => `--${bound}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n`).join('') + `--${bound}--`,
        { status: 200, headers: { 'Content-Type': `multipart/mixed; boundary=${bound}` } });
    }
    if (u.includes('/drive/v3/files/') && opts?.method === 'PATCH') {
      const id = u.split('/files/')[1].split('?')[0];
      if (String(opts.body || '').includes('"trashed":false')) window.__restored.push(id);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  const crop = await import('/js/crop.js');
  const file = { id: 'orig', name: 'orig.png', mimeType: 'image/png', size: '1000', parents: ['p'] };
  const other = { id: 'other', name: 'other.png', mimeType: 'image/png', size: '900', parents: ['p'] };
  document.querySelectorAll('.toast').forEach(t => t.remove());
  await crop.openCropModal(file, { group: [file, other], indexInGroup: 0, allGroups: [[file, other]], groupIndex: 0 });
});
await page.waitForSelector('#cropCanvas', { state: 'visible', timeout: 8000 });
await page.waitForTimeout(500);

// Draw an area and crop.
const box = await page.evaluate(() => {
  const r = document.getElementById('cropCanvas').getBoundingClientRect();
  return { x: r.left, y: r.top };
});
await page.mouse.move(box.x + 20, box.y + 20);
await page.mouse.down();
await page.mouse.move(box.x + 160, box.y + 120, { steps: 5 });
await page.mouse.up();
await page.click('#btnCropConfirm');
const asked = await page.waitForSelector('#confirmModal', { state: 'visible', timeout: 2500 }).then(() => true).catch(() => false);
await page.waitForTimeout(1500);

const r = await page.evaluate(() => ({
  uploads: window.__uploads,
  trashed: window.__trashed.slice(),
  toasts: [...document.querySelectorAll('.toast')].map(t => ({
    text: t.querySelector('.toastText')?.textContent || '',
    undo: !!t.querySelector('.toastAction'),
  })),
}));
console.log('   ', JSON.stringify(r));
ck(!asked, 'Crop does not stop to ask about the original');
ck(r.uploads === 1, 'the cropped copy is uploaded');
ck(JSON.stringify(r.trashed) === JSON.stringify(['orig']), `the original is moved to Trash (${JSON.stringify(r.trashed)})`);
const saved = r.toasts.filter(t => /Saved/.test(t.text));
ck(saved.length === 1 && saved[0].undo && /Trash/.test(saved[0].text),
   'one toast says it was saved and the original trashed, with Undo');
ck(r.toasts.length === 1, `and it is the only toast (${r.toasts.length})`);

await page.click('.toast .toastAction');
await page.waitForTimeout(800);
const restored = await page.evaluate(() => window.__restored.slice());
ck(JSON.stringify(restored) === JSON.stringify(['orig']), `Undo on that toast restores the original (${JSON.stringify(restored)})`);

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
