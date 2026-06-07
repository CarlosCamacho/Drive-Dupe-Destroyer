<!-- Drive Dupe Destroyer v12.8 — CHANGELOG-v12.5.md -->
# v12.5 — performance pass + bug fixes

(Builds on the live-results work and the v12.4 fixes. This release focuses on
correctness gaps and performance hot paths found in a second audit.)

## Correctness fixes

1. **Rejection feedback now actually works.**
   `filterRejectedPairs` was imported in scan.js but never called — so the
   "ignore group / not a duplicate" action recorded rejections that were never
   applied, and rejected pairs reappeared on every subsequent scan. Added a fast
   synchronous `isRejectedPairSync` (in rejection.js), preloaded the rejection
   set before matching, and wired the skip into the match loop so rejected pairs
   are never re-unioned. Verified by test: record → skip, order-independent,
   unrelated pairs unaffected, clear works.

## Performance refactors

2. **Folder paths built only for duplicates, not every scanned image.**
   Both `buildPathsParallel` calls (similar-scan and quick-scan) previously ran
   over ALL scanned images, making a Drive API call per unique parent folder even
   for files that weren't duplicates. On a large library that's thousands of
   needless requests. Now restricted to `groups.flat()` — only files actually
   shown in results. This is the single biggest network win in the release.

3. **Pairwise similarity memoized in the renderer.**
   `computeSimilarity` (a Hamming-distance compute) ran for every visible row on
   every virtual-scroll repaint and every live-update frame. Added an id-pair
   memo cache, cleared at the start of each fresh render / live session.

4. **Hash worker reuses canvases instead of allocating per call.**
   Each image previously created 6-10+ fresh OffscreenCanvas + 2D contexts
   (base8, base12, crop regions, color hist, edge hist, pHash). Added a
   dimension-keyed canvas pool in worker-hash.js so canvases are reused across
   all images a worker processes, cutting GC churn. (transformBitmap is left
   un-pooled on purpose — it transfers its canvas via transferToImageBitmap.)

5. **Faster rejection lookups.**
   The per-pair key built `Array.from(hash).join(",")` on every call. The
   per-entry fingerprint is now memoized on the entry object (non-enumerable
   `_rejKey`), so it's computed at most once per entry rather than once per
   comparison.

## Cleanup

6. **Removed dead imports** that forced unnecessary module fetch/parse at load:
   - scan.js: `AIMDController` (./aimd.js never instantiated), `buildAdaptiveLshIndex`,
     `releaseAllThumbBlobs`, `filterRejectedPairs`, plus several unused db/resume/common symbols.
   - app.js: `debounce`, `getCurrentYear`, `setProgress`, `setPhase`, `showSpinner`,
     `clearResults`, `showErrorModal`, `getHashingErrors`, `getCurrentClientId`,
     `setCropCallbacks`, `updateTelemetry`.
   A static check confirms all remaining imports resolve to real exports.

7. **Version bump 12.4 → 12.5** across ui.js (APP_VERSION), index.html (title +
   header), sw.js (cache name → forces a clean asset refresh on update), and
   runtime console logs. Also fixed a stale "11.0" string in the service worker's
   VERSION_CHECK response.

## Still flagged (deliberately not changed — need a product/API decision)
- **AIMD adaptive throttle is inactive** — concurrency is a fixed 6. Wiring it
  affects live Drive rate-limiting behavior. (Dead import now removed so the
  module is no longer loaded for nothing.)
- **downloadFileBlob fetches full-resolution originals for hashing** rather than
  a small thumbnail. Potentially a large bandwidth win, but it could change hash
  fidelity and there's a CORS caveat noted in the code.
- **batchTrash treats an HTTP-200 multipart batch as all-success**; individual
  sub-request failures aren't parsed. Correct handling needs multipart-response
  parsing.
