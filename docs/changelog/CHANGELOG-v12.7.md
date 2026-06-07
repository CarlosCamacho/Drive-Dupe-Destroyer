<!-- Drive Dupe Destroyer v12.8 — CHANGELOG-v12.7.md -->
# v12.7 — foreground responsiveness during background scans

Addresses a real usage report: with the Compare modal open while a scan runs in
the background, the foreground UI felt sluggish (clicks slow to register) and the
modal images sat on "Loading…". Three compounding causes, all fixed.

## 1. The matching loop now yields the main thread far more cooperatively

The duplicate-matching loop runs on the main thread. It previously yielded only
once per *outer* item, gated behind a 16ms timer — so a single image with many
candidates could hold the thread for a long stretch, starving clicks, paints and
image decoding.

Now it yields from *inside* the inner comparison loop, time-based: roughly every
64 comparisons it checks the clock and hands the thread back if it's held it for
more than ~8ms. The hand-off uses a **MessageChannel** instead of
`setTimeout(0)` — setTimeout is clamped to ~4ms by browsers and competes with
other timers, whereas a MessageChannel postMessage resolves on the next
macrotask with no clamp, letting queued input/paint run before matching resumes.
(Verified: queued UI tasks interleave between work chunks.)

## 2. Compare modal shows images instantly instead of "Loading…"

The modal used to `await getThumbUrlForFile()` first, which goes through the
**authenticated blob-download path** — the same queue the scan's hashing
downloads saturate. So during a background scan the modal's images waited behind
hashing traffic.

Now the modal sets `img.src` directly to Google's thumbnail URL, which renders
immediately: the browser fetches/decodes it off the main thread and it doesn't
queue behind the scan's authenticated downloads. A higher-quality authenticated
blob is fetched in the background and swapped in only if it arrives while the
same pair is still shown (guarded by a token; cancelled on close/navigate).

## 3. Per-flush group rebuild is now a single pass

`flushDirty` rebuilt each changed group with `ids.filter(...)` — an O(n) scan of
every id, *per dirty root*, every flush, on the main thread. It now collects all
dirty groups in one O(n) pass over the ids, cutting main-thread work during the
scan (which also helps responsiveness).

## Net effect

The foreground stays responsive while a scan runs: clicks register promptly and
the Compare modal paints its images right away. The scan runs marginally slower
in wall-clock terms because it yields more often, but that's the correct
trade — the user is actively working in the foreground.

## Version
Bumped 12.6 → 12.7 (ui.js, index.html, sw.js cache name, runtime logs).

## Still open (unchanged)
- AIMD adaptive throttle remains inactive (fixed concurrency of 6) — an
  optimization, not a bug; best validated against a live account under load.
