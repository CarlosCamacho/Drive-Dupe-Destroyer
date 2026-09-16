/*
 * Drive Dupe Destroyer (DDD) — tools/ux-audit.mjs
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *     python3 serve_secure.py &
 *     node tools/ux-audit.mjs
 */
// #103-#111: the usability pass, checked against the running app.
//
// These are UI facts, and several of them (aria-expanded on the accordions, the
// implicitly-labelled radios) were MISREPORTED by grepping index.html, because
// the markup is not the page — attributes get added at runtime and <label> can
// wrap rather than reference. So everything here reads the live DOM.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;

let fails = 0;
const ck = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1800);

// The whole audit runs in one page.evaluate, so a UI bug that spins the
// renderer (see the toast cap below) would otherwise show up as a silent hang
// until the outer timeout. Race it, and report the hang as a failing check.
const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish in ${ms}ms -- the page is probably spinning`)), ms)),
]);

const r = await withTimeout(page.evaluate(async () => {
  const ui = await import('/js/ui.js');
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = {};

  // --- #103 first-run state -------------------------------------------------
  out.firstRunTitle = document.getElementById('emptyTitle')?.textContent?.trim();
  out.firstRunSteps = document.querySelectorAll('#emptySteps li').length;
  ui.setEmptyState('none-found', 'No duplicates among 4,812 images in 12 folders.');
  out.noneFoundTitle = document.getElementById('emptyTitle')?.textContent?.trim();
  out.noneFoundBody = document.getElementById('emptyBody')?.textContent?.trim();
  ui.setEmptyState('before-signin');

  // --- #104 assistive semantics --------------------------------------------
  out.ariaLive = document.querySelectorAll('[aria-live]').length;
  out.modals = document.querySelectorAll('.modal').length;
  out.modalsWithDialog = document.querySelectorAll('.modal[role="dialog"][aria-modal="true"]').length;
  out.modalsLabelled = document.querySelectorAll('.modal[aria-labelledby], .modal[aria-label]').length;
  out.statusIsLive = document.getElementById('status')?.getAttribute('aria-live') === 'polite';
  ui.setPhase('2/4 Hashing'); ui.setProgress(45);
  await settle();
  out.progressText = document.getElementById('progress')?.getAttribute('aria-valuetext');

  // --- #105 every control labelled -----------------------------------------
  out.unlabelled = [...document.querySelectorAll('input, select, textarea')]
    .filter(e => e.type !== 'hidden')
    .filter(e => !e.labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby'))
    .map(e => e.id || e.name || e.type);

  // --- #107 toasts stack, dismiss, and carry actions -----------------------
  document.getElementById('toastStack')?.remove();
  ui.showToast('Trashed 40 file(s)', 'success');
  ui.showToast('Failed to trash 3 file(s)', 'error');
  await settle();
  out.bothToastsVisible = document.querySelectorAll('#toastStack .toast').length;
  out.errorPersists = !![...document.querySelectorAll('.toast-error')].length;
  out.toastsDismissible = document.querySelectorAll('#toastStack .toastClose').length;
  ui.showToast('Trashed 40 file(s)', 'success');          // a duplicate message
  await settle();
  out.duplicatesCollapse = document.querySelectorAll('#toastStack .toast').length;

  // The cap has to hold AND the eviction has to terminate. The first version of
  // this loop re-read container.children while dismissToast removed the node
  // 300ms later, so it never terminated: six messages in a row spun the
  // renderer until Chromium killed the tab. Six distinct messages, because
  // duplicates collapse and would never reach the cap.
  document.getElementById('toastStack')?.remove();
  for (let i = 0; i < 6; i++) ui.showToast('cap test ' + i, 'info');
  out.toastCapReturns = true;                    // reached only if it terminated
  await settle();
  out.toastsAfterCap = [...document.querySelectorAll('#toastStack .toast')]
    .filter(t => !t.dataset.leaving).length;

  // --- #106 the undo affordance is an action, not prose --------------------
  let undoClicked = false;
  ui.showTrashedToast(12, () => { undoClicked = true; });
  await settle();
  const undoBtn = [...document.querySelectorAll('.toastAction')].find(b => b.textContent === 'Undo');
  out.undoIsAButton = !!undoBtn;
  out.undoToastSaysCount = !![...document.querySelectorAll('.toastText')]
    .some(t => /Moved 12 files to Google Drive Trash/.test(t.textContent));
  undoBtn?.click();
  out.undoActionFires = undoClicked;
  document.getElementById('toastStack')?.remove();

  // --- #110 shortcuts panel is real and reachable --------------------------
  out.shortcutsButton = !!document.getElementById('btnShortcuts');
  const kb = await import('/js/keyboard.js');
  kb.showKeyboardHelp();
  await settle();
  out.shortcutsOpen = document.getElementById('shortcutsModal')?.style.display === 'flex';
  out.shortcutsListed = document.querySelectorAll('#shortcutsModal .shortcutList dt').length;
  out.shortcutsMentionsCtrlZ = /Ctrl/.test(document.getElementById('shortcutsModal')?.textContent || '')
    && /Undo the last delete/.test(document.getElementById('shortcutsModal')?.textContent || '');
  kb.hideKeyboardHelp();

  // --- #111 the origin to paste is shown, not described --------------------
  out.originShown = document.getElementById('authOrigin') !== null;
  out.setupSteps = document.querySelectorAll('.setupSteps li').length;
  out.hasCopyButton = !!document.getElementById('btnCopyOrigin');
  // #115: each console step that HAS a direct URL should be a link, so the
  // user is not hunting through a console they have never opened. Counted
  // rather than asserted one by one, so adding a step does not break it.
  out.setupLinks = [...document.querySelectorAll('.setupSteps a[href]')]
    .map(a => a.getAttribute('href'))
    .filter(h => h.startsWith('https://console.cloud.google.com/'));

  // --- #108 no orphaned help icons -----------------------------------------
  out.exportHelpIcons = document.querySelectorAll('[data-help="exportResults"]').length;
  out.queueHelpIcons = document.querySelectorAll('[data-help="queue"]').length;

  // --- #109 the confirm dialog shows what is at stake ----------------------
  const { confirmAction } = await import('/js/confirm.js');
  const p = confirmAction({
    title: 'Move to Trash?', message: 'This file will be moved to Google Drive Trash.',
    confirmLabel: 'Move to Trash', note: 'Undo restores it.',
    files: [{ id: 'f1', name: 'IMG_0042.jpg', size: 2400000, _path: '/My Drive/Photos',
              imageMediaMetadata: { width: 4032, height: 3024 } }],
  });
  await settle();
  const dlg = document.getElementById('confirmModal');
  // VISIBLE, not merely present. The first version of this check read
  // textContent and querySelector, both of which happily find hidden nodes --
  // so it passed with the whole detail block display:none, which is exactly the
  // regression it exists to catch.
  const detailEl = dlg?.querySelector('#confirmDetail');
  const detailVisible = !!detailEl && !detailEl.hidden && detailEl.offsetParent !== null;
  const detailText = detailVisible ? detailEl.textContent : '';
  out.confirmShowsThumb = detailVisible && !!detailEl.querySelector('.confirmThumb');
  out.confirmShowsName = /IMG_0042\.jpg/.test(detailText);
  out.confirmShowsPathAndDims = /My Drive\/Photos/.test(detailText)
    && /4032 × 3024/.test(detailText);
  out.confirmButtonIsAVerb = dlg?.querySelector('[data-confirm="ok"]')?.textContent;
  out.focusStartsOnCancel = document.activeElement?.dataset?.confirm === 'cancel';
  dlg.querySelector('[data-confirm="cancel"]').click();
  out.confirmReturnsFalseOnCancel = (await p) === false;

  return out;
}), 60000, 'the audit page.evaluate').catch(async (e) => {
  console.log(`FAIL  the page stayed responsive through the audit (${e.message})`);
  await b.close();
  process.exit(1);
});

console.log('  ', r);

ck(/Find duplicate photos/.test(r.firstRunTitle || ''), '#103 first run does not claim a result');
ck(r.firstRunSteps === 3, '#103 and names the three steps');
ck(r.noneFoundTitle === 'No duplicates found' && /4,812 images/.test(r.noneFoundBody || ''),
   '#103 "no duplicates" survives as a real finding, with what was searched');

ck(r.ariaLive >= 1 && r.statusIsLive, '#104 the status line is a live region');
ck(r.modalsWithDialog === r.modals && r.modalsLabelled === r.modals,
   `#104 all ${r.modals} modals carry dialog semantics and a label`);
ck(/45%/.test(r.progressText || '') && /Hashing/.test(r.progressText || ''),
   `#104 the progress bar describes itself ("${r.progressText}")`);

ck(r.unlabelled.length === 0, `#105 every control is labelled (${r.unlabelled.join(', ') || 'none left'})`);

ck(r.bothToastsVisible === 2, '#107 two rapid messages both survive');
ck(r.errorPersists, '#107 an error is still there to be read');
ck(r.toastsDismissible === r.bothToastsVisible, '#107 each toast can be dismissed');
ck(r.duplicatesCollapse === 2, '#107 a repeated message collapses instead of stacking');
ck(r.toastCapReturns === true, '#107 the overflow eviction terminates');
ck(r.toastsAfterCap === 3, `#107 the stack caps at 3 live toasts (${r.toastsAfterCap})`);

ck(r.undoIsAButton && r.undoActionFires, '#106 undo is an action in the toast, not prose about one');
ck(r.undoToastSaysCount, '#106 and the message says what happened');

ck(r.shortcutsButton && r.shortcutsOpen, '#110 the shortcuts panel has a visible trigger and opens');
ck(r.shortcutsListed >= 18, `#110 it lists every shortcut, modals included (${r.shortcutsListed})`);
ck(r.shortcutsMentionsCtrlZ, '#110 including Ctrl+Z');

ck(r.originShown && r.hasCopyButton, '#111 the origin to paste is shown with a copy button');
ck(r.setupSteps >= 5, `#111 and the console flow is spelled out (${r.setupSteps} steps)`);
ck(r.setupLinks.length >= 4,
   `#115 each console step that has a direct URL is a link, not a hunt (${r.setupLinks.length} links)`);
ck(new Set(r.setupLinks).size === r.setupLinks.length,
   `#115 and they go to different pages — the same link four times would be worse than none`);

ck(r.exportHelpIcons === 1 && r.queueHelpIcons === 1, '#108 one help icon each, not two');

ck(r.confirmShowsThumb && r.confirmShowsName, '#109 the confirm dialog shows the file');
ck(r.confirmShowsPathAndDims, '#109 with its folder and resolution');
ck(r.confirmButtonIsAVerb === 'Move to Trash', '#109 and a verb on the button, not "OK"');
ck(r.focusStartsOnCancel, '#109 focus starts on the safe choice');
ck(r.confirmReturnsFalseOnCancel, '#109 cancel resolves false, like confirm() did');

// --- #111 part 2: touch targets, measured on a phone-sized coarse pointer ---
// The extra hit area is a ::after pseudo-element, so the control's own
// getBoundingClientRect() still reports 24px -- reading the pseudo-element's
// computed box is the only way to see it. A check that measured the element
// alone would fail on code that is correct.
const touch = await (await b.browser?.() ?? b).newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
});
const mob = await touch.newPage();
await mob.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
await mob.waitForTimeout(1500);
const t = await mob.evaluate(async () => {
  // Measure the signed-in page, not the first-run one. #103 deliberately hides
  // the results toolbar before sign-in, so measuring the default state would
  // leave out most of the controls the original audit counted -- including the
  // per-row actions that were the worst of them.
  const ui = await import('/js/ui.js');
  ui.setSignedInUi(true, 'audit.apps.googleusercontent.com');
  // Every sidebar section starts collapsed on a first visit, and a collapsed
  // .sectionBody is display:none -- 121 of the page's 139 controls. Open them
  // all, or the check measures 18 controls and calls it a page.
  document.querySelectorAll('.section.collapsed').forEach((c) => c.classList.remove('collapsed'));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const px = (v) => parseFloat(v) || 0;
  const controls = [...document.querySelectorAll('button, a[href], input, select, .helpIcon')]
    .filter((e) => e.offsetParent !== null || e === document.activeElement)
    .filter((e) => e.getBoundingClientRect().width > 0);
  const small = [];
  for (const e of controls) {
    const r = e.getBoundingClientRect();
    const a = getComputedStyle(e, '::after');
    const w = Math.max(r.width, a.content !== 'none' ? px(a.width) : 0);
    const h = Math.max(r.height, a.content !== 'none' ? px(a.height) : 0);
    if (w < 32 || h < 32) small.push(`${e.id || e.className || e.tagName} ${Math.round(w)}x${Math.round(h)}`);
  }
  return {
    total: controls.length,
    small,
    scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});
await touch.close();
ck(t.small.length === 0,
   `#111 no touch target under 32px at 390px wide (${t.small.length} of ${t.total}: ${t.small.slice(0, 6).join(', ')})`);
ck(!t.scrolls, '#111 and the page still does not scroll horizontally');

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
