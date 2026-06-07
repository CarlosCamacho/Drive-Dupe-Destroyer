<!-- Drive Dupe Destroyer v12.8 — VERSION-11.0-CHANGELOG.md -->
# Drive Dupe Destroyer v11.0 Changelog

## Release Date: March 2026

## New Features

### Feature #1 — Persistent Scan Settings
All Advanced Options (crop detection, color histogram, pHash, rotation variants, aspect filter, sensitivity, thresholds, LSH mode, delta scan) are now saved to IndexedDB automatically. Settings survive page reloads, browser restarts, and cache clears. Implemented in `settings.js`.

### Feature #2 — Per-Group Similarity Score Badge
Every duplicate group header now shows a colored badge: **identical** (100%), **near** (≥90%), **similar** (≥75%), or **loose** (<75%). Based on the best pairwise Hamming distance already computed during matching — zero extra cost.

### Feature #3 — Hashing Speed Telemetry Overlay
Click the ⚡ button in the toolbar to open the telemetry panel. Shows: images hashed, failed, retried, cache hit rate, hash rate (img/s), WASM active status, SAB (SharedArrayBuffer) status, scan duration, MD5 exact duplicates found, and rejected pairs count.

### Feature #4 — Recoverable Scan Resume on Refresh
After the file collection phase completes, scan state is saved to IndexedDB. If the browser closes or the tab crashes during hashing, reloading the page prompts to resume. State expires after 24 hours. Implemented in `resume.js`.

### Feature #5 — MD5 Exact-Duplicate Fast Path
Before any perceptual hashing, files are grouped by `md5Checksum` (provided free by the Drive API). Byte-identical files are identified instantly — no thumbnail downloads, no worker computation. Results are shown in the telemetry panel.

### Feature #7 — pHash (DCT Frequency Hash)
Enable "pHash (DCT frequency hash)" in Advanced Options. Computes a 64-bit discrete cosine transform hash alongside dHash. pHash captures low-frequency image structure and is orthogonal to dHash — it catches duplicates with brightness shifts, gamma corrections, and JPEG↔PNG conversions that dHash misses. Computed in the hash worker alongside existing hashes.

### Feature #8 — Aspect Ratio Pre-Filter
Enable "Aspect ratio pre-filter" in Advanced Options (on by default). Before computing Hamming distance between two candidate pairs, checks whether their aspect ratios are compatible within the configured tolerance (default 20%). A 9:16 portrait and a 16:9 landscape cannot be duplicates. Eliminates a large fraction of false-candidate comparisons for free using Drive API metadata.

### Feature #10 — Adaptive Concurrency (AIMD Throttle)
The hashing concurrency controller now uses AIMD (Additive Increase / Multiplicative Decrease). After N consecutive successful batches it increases concurrency by 1 (up to max 12). On a 429 or timeout it immediately halves concurrency (down to min 2). Prevents retry storms on slow connections. Implemented in `aimd.js`.

### Feature #12 — Full CSV/JSON Export with Match Metadata
The export now includes: group number, role (KEEP/DUPLICATE), file name, full Drive path, size, dates, MD5, MIME type, dimensions, **similarity percentage**, **match type** (structural/crop/color/exact), Drive ID, and view link. A new **CSV** export button exports the same data as a spreadsheet-ready `.csv` file.

### Feature #13 — Incremental Delta Scan
Enable "Delta scan (changes only)" in Advanced Options. After the first full scan, the Drive Changes API token is saved. On subsequent scans, only files modified since the last scan are fetched and re-hashed. For large libraries this reduces rescan time from minutes to seconds. The changes token is stored in IndexedDB.

### Feature #15 — Auto-Tuned LSH Band Configuration
The "LSH band mode" control (default: Auto-tune) now samples 5% of the library's Hamming distance distribution before building the index. Based on the p10/p50/p90 percentiles it selects `loose`, `normal`, or `strict` band configuration to minimize false negatives for that specific library's content. Logged to console for debugging.

### Feature #16 — Rotation-Invariant Hashing
Enable "Rotation variants (90°/180°/270°)" in Advanced Options. Computes dHash for all four cardinal rotations and adds them to the variant set. Catches phone photos that arrived with incorrect EXIF orientation, exported at 90° rotations. Gated behind a toggle since it adds 3× variant storage.

### Feature #18 — SharedArrayBuffer Zero-Copy Pipeline
When the page is served with the required COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`), `sabAvailable` will show `✓ Yes` in the telemetry panel and the SharedWorkerPool module activates zero-copy bitmap transfer between the main thread and hash workers. Check telemetry to confirm.

### Feature #19 — False-Positive Feedback Loop
When you click "Not a duplicate" (ignore) in the Compare modal, the hash fingerprints of that pair are stored in a rejection database (`rejection.js`). On future scans, rejected pairs are filtered out automatically. The rejection count is shown in the telemetry panel. Works across sessions; can be cleared with "Clear Cache."

### Feature #20 — Service Worker Background Queue
The updated `sw.js` now acts as a computation coordinator. When the main tab goes hidden during a scan, the SW can accept queued hash jobs via `postMessage` and hold them until the tab returns to focus, preventing scan loss from accidental tab switches.

### Undo Delete
A new **↩ Undo** button in the toolbar restores the last deleted file from trash using the Drive API. Holds up to 50 entries with a 30-minute TTL. Implemented in `undo.js`.

## Files Added
- `js/settings.js` — Persistent settings
- `js/telemetry.js` — Telemetry overlay
- `js/resume.js` — Scan resume state
- `js/rejection.js` — False-positive rejection DB
- `js/aimd.js` — Adaptive concurrency controller
- `js/undo.js` — Undo delete with Drive restore
- `js/phash.js` — DCT pHash standalone module (reference implementation; worker-hash.js used in practice)

## Files Modified
- `js/worker-hash.js` — pHash computation, rotation variants, updated message handler
- `js/hashing.js` — Thread `withPHash`, `withRotation` through pipeline
- `js/common.js` — Added `pHashDistance()`, `aspectRatioCompatible()`, `bestDistWithPHash()`
- `js/lsh.js` — Added `sampleDistanceDistribution()`, `autoTuneLshSensitivity()`, `buildAutoTunedLshIndex()`
- `js/scan.js` — MD5 fast path, delta scan, resume save/clear, AIMD, aspect filter, pHash/rotation wiring, telemetry update
- `js/render.js` — Similarity badge, `makeSimilarityBadge()`, `groupBestPct()`
- `js/compare.js` — Rejection recording on ignore, undo push on delete
- `js/exporter.js` — Full CSV export, similarity%, match type in JSON
- `js/drive.js` — `fetchChangesSince()`, `getChangesStartToken()`, `restoreFromTrash()`
- `js/db.js` — `getChangesToken()`, `setChangesToken()`, `clearChangesToken()`
- `js/app.js` — Wire telemetry, undo, persistent settings, resume check
- `sw.js` — Background hash queue keepalive, improved cache strategy
- `styles.css` — Telemetry panel, similarity badges, undo button styles
- `index.html` — New controls: pHash, rotation variants, aspect filter, LSH mode, delta scan, telemetry button, undo button, CSV export button
