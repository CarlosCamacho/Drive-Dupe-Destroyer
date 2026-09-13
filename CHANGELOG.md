# Changelog

All notable changes to **Drive Dupe Destroyer** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/).

> The detailed, original per-version notes are archived in
> [`docs/changelog/`](docs/changelog/). This file is the consolidated summary.

## [14.1.3] - 2026-09-13

Two bugs found reviewing modules that earlier releases never looked at.

### Fixed

- **CSV/JSON export marked every file as a duplicate.** It read three properties
  — `_isKeep`, `_matchDist` and `_matchType` — that nothing in the app ever set.
  The keep-file lookup returned -1, so *no* row was labelled KEEP, and the
  similarity column was always empty. Anyone using an export to decide what to
  delete would have removed the originals along with the copies. The export now
  derives the keep file and the similarity exactly the way the results table
  does, so the two cannot disagree. The percentage also honours the configured
  hash size instead of assuming 12×12, which overstated similarity by roughly
  2.25× on the 8×8 setting.
- **The trash queue recorded no undo.** 14.1 claimed undo covered every delete
  path; it covered four of five. The queue — the bulk path, and the one the undo
  code was designed around — was missed. Trashing files from it now records an
  undo entry like everywhere else.
- **Escape now closes the queue window.** The key handler was attached to the
  window element itself, which never receives key events, so the key did
  nothing.
- The queue stored an always-empty folder path for each file.

## [14.1.2] - 2026-09-13

Two regressions introduced by 14.1 itself, found in a review of that release.

### Fixed

- **A few unreadable images no longer collapse scan throughput.** Wiring up the
  adaptive throttle in 14.1 called it on every per-file failure. The controller
  halves concurrency unconditionally, so a Drive containing a handful of corrupt
  or undecodable images dragged the whole scan down to one file at a time — and
  climbing back needs five consecutive successes per step. Backoff is now
  limited to signals that actually mean Drive is under pressure: rate limiting,
  server errors, network failures and timeouts. A file the browser cannot decode
  says nothing about how hard we are hitting the API.
- **Delta scan's containment check no longer depends on statement order.** The
  recursive collector returned its BFS de-duplication set as "folders visited",
  but that set is seeded with the user's *excluded* folders so the walk skips
  them — so excluded folders counted as in scope. A separate guard happened to
  run first and kept files from leaking back in, but the guarantee rested on the
  order of two lines. Walked folders are now tracked separately from the
  skip-list.

### Corrected

- **The 14.1 claim that `COOP: same-origin` broke Google sign-in was wrong.**
  It was asserted from Google's documentation and never observed. Tested
  directly by restoring the old header: sign-in works. The related claim that
  `COEP: require-corp` blocked Drive thumbnails was likewise never tested and
  should be treated as an open question.

  The headers stay as they are — `same-origin-allow-popups` is documented for
  the popup flow and strictly more permissive, and not sending COEP only
  removes a restriction — but the source comments, the startup banner
  ("incompatible with Google sign-in") and this changelog no longer present
  either claim as established fact.

### Internal

- The backoff decision moved into `common.js` as `isBackpressureError`, so its
  tests exercise the real function rather than a copy that could drift from it.

## [14.1.1] - 2026-09-13

Completes 14.1. Three authentication issues were listed as fixed in the 14.1
pull request but were not actually addressed; this release fixes them.

### Fixed

- **Concurrent token requests no longer hang.** `tokenClient.callback` is a
  single mutable slot, and every caller overwrote it before calling
  `requestAccessToken`. Google fires only the last-installed callback, so when
  the token went stale mid-scan the other in-flight requests — up to sixteen,
  given the hashing and path-building concurrency — waited out their timeouts
  and failed. All callers now share one in-flight request.
- **Cancelling sign-in no longer deletes the stored Client ID.** Any failure
  used to clear it, so closing the Google popup once meant fetching the ID from
  Cloud Console again. Only errors that indicate the ID itself is wrong clear
  it now.
- **Token expiry comes from Google's `expires_in`** instead of a hardcoded 55
  minutes, so a shorter-lived token is no longer treated as valid until a
  request fails. The staleness buffer also scales down for short tokens; the
  old flat five-minute subtraction went negative below that, marking a live
  token already expired.
- A 401 now invalidates only the token the failing request actually carried.
  Clearing it unconditionally discarded a fresh token a parallel request had
  just obtained, sending every other in-flight request through a needless
  refresh.
- `signOut` clears the current Client ID and any in-flight token request, which
  were both left behind.

## [14.1] - 2026-09-13

Correctness and efficiency release. Every open issue filed against 14.0 is
addressed. The headline changes are that Undo now works at all, the logic
deciding which file to delete has been corrected, and a large scan no longer
downloads and retains every image at full resolution.

### Fixed — safety

- **Undo recorded nothing.** No delete path called into the undo stack:
  `compare.js` imported `pushUndoDelete` and never invoked it, and the
  results-table, bulk and crop paths called `batchTrash` directly. The button
  was permanently disabled. It now records every path, stores *operations*
  rather than individual files (one click restores a whole bulk delete), and
  persists to IndexedDB so a refresh no longer discards it.
- **Keep-file selection.** "Highest resolution" compared a pixel count against
  a byte count whenever Drive omitted image dimensions, so a large file with no
  metadata could beat a genuine higher-resolution original. Folder priority
  matched patterns against Drive folder IDs and file names rather than folder
  paths, and ran before paths were resolved, so it silently did nothing. Ties
  now break deterministically instead of depending on scan order.
- **Per-row delete now confirms**, matching the KEEP row.
- **Crop no longer destroys metadata silently.** It re-encoded through a canvas,
  uploaded under the original's exact name and auto-trashed the original. The
  crop is now saved as a separate `(cropped)` file, trashing the original is a
  confirmation that states what the re-encode did not carry over, and the
  uploaded file declares the type it actually is — `toBlob` silently falls back
  to PNG for formats browsers cannot encode.

### Fixed — the app running at all

- **Browser isolation headers changed** in `serve_secure.py`: COOP is now
  `same-origin-allow-popups` (the value Google documents for the sign-in popup
  flow) and COEP is no longer sent.
  > **Corrected in 14.1.2.** This entry originally said the old headers *broke*
  > sign-in and *blocked* Drive thumbnails. The sign-in claim was tested
  > afterwards and is false — sign-in works under `COOP: same-origin`. The
  > thumbnail claim was never tested. Both came from documentation rather than
  > observation. The change is still fine (it only relaxes restrictions) but it
  > fixed no observed defect.
- **Batch trash actually batches.** The parser never matched Google's
  angle-bracketed `Content-ID`, so every chunk fell back to 100 individual
  requests.
- **Non-image files are no longer downloaded.** Files Drive typed
  `application/octet-stream` passed the format filter on MIME alone, so
  archives and installers were fetched in full before failing to decode.
- **Resume actually resumes.** The prompt discarded the user's answer and ran a
  full rescan, and only cleared its state on Cancel, so it reappeared on every
  load for 24 hours. It now checkpoints the folder frontier during collection
  and restarts from it.
- **Delta scan stays in scope.** It added changed files from anywhere in Drive,
  including folders the user had excluded, and bypassed the size and Image
  Types filters entirely.

### Changed — performance

- Hashing no longer retains the downloaded image. The blob cache was bounded by
  entry count, not bytes, and the hashing and display paths shared a cache key —
  so the results table painted full-resolution originals into 44px thumbnails.
- The WASM hash path decoded at full resolution and read the pixels back twice;
  it now downsamples first. Cached hashes carry a version and are recomputed
  when the scheme changes.
- Thumbnails come from Drive's own `thumbnailLink` first, which costs no memory
  and no API quota, with the authenticated download as fallback.
- The thumbnail fast-path is probed once per session rather than attempted and
  failed per file.
- Exact duplicates found by checksum are no longer re-downloaded and re-hashed,
  and formats no browser can decode (PSD, RAW, TGA, PCX, Netpbm, JPEG 2000,
  JPEG XL) are matched by checksum instead of being downloaded to fail.
- Folder traversal makes one API call per folder instead of two.
- The adaptive concurrency throttle described in the source since v12 is now
  actually connected, so a 429 reduces global concurrency instead of making six
  workers back off and resume independently.
- Rejected pairs have their own object store; recording one no longer rewrites
  the entire collection.

### Added

- **About dialog** reachable from a new button beside Donate, with the version,
  copyright, repository link, donation prompt and a bug-report link.
- **Test suite** (`npm test`, no dependencies) and CI. Four of the bugs above
  were in pure functions a test would have caught immediately.
- Storage-quota handling: a full cache is reported once rather than silently
  ending caching, and the app requests persistent storage so the browser does
  not evict the cache and the user's rejected-pairs list without warning.

### Removed

- Dead code: `js/pool.js` and `js/phash.js`, plus an unused token store,
  hand-rolled CSRF helpers, a postMessage guard with no listener, and a
  `Permissions-Policy` meta tag that browsers ignore. Several header comments
  claimed protections that were not in effect.

### Internal

- The version lives in one constant (`APP_VERSION` in `js/util.js`) instead of
  ~56 hardcoded strings; the service worker cache name derives from it.
- The service worker precache list is generated and CI-verified — it was
  missing nine modules the app statically imports, breaking offline.

## [14.0] - 2026-06-07

### Added
- **Image Types panel** (left sidebar). Choose exactly which formats a scan
  includes via per-format checkboxes, with a **Select all** master toggle and a
  live count badge. All formats enabled by default.
- **Download or delete any image from the results table.** Every row — including
  the KEEP row — now has both a Download button and a Trash button. Deleting the
  KEEP file is allowed but asks for confirmation.
- **Clickable File Location.** The Folder cell in the results table and the path
  breadcrumb in the compare modal now open the file's containing Google Drive
  folder in a new tab.
- **Image placeholders.** A lightweight inline placeholder is shown while a
  thumbnail loads (so live scanning isn't slowed by eager thumbnail generation)
  and as a fallback for any image that fails to load.

### Changed
- The group/similarity label (`identical 100%`, `near 100%`, …) moved to a wider
  **Group / Match** column and no longer wraps.
- User manual updated to v14 (`docs/DDD-v14-Manual.docx`).

### Fixed
- Clicking the trash **icon** (not just the button edge) now registers a delete.
- Placeholder asset is a properly percent-encoded data URI (valid in strict
  parsers; never 404s).

## [12.9] - 2026

### Fixed
- **Duplicate discovery query.** v12.8 tried to find PSD/TGA/IFF/PCX with
  `name contains '.ext'` clauses; Google Drive does *prefix* matching on `name`,
  so those never matched and the bloated query could fail server-side and return
  zero files (the reported "two identical GIFs not found" symptom). Discovery is
  now MIME-based, with client-side extension filtering as the reliable narrower.
- **"Ignore" removed the wrong group** because it deleted the group twice (once
  via callback, once via event). Removal now goes through a single path.
- **"Ignore" now persists** across scans — the rejection record is reliably
  written (the live hash map is wired through to the compare modal).

### Changed
- Acting on a pair in the compare modal (delete one/both, or ignore) removes it
  from the results list so it is never reviewed twice.

## [12.8] - 2026

### Added
- Support and discovery for **PSD** (`.psd`), **TGA/Targa** (`.tga`, `.targa`),
  **IFF/ILBM** (`.iff`, `.ilbm`, `.lbm`), and **PCX** (`.pcx`).
- Filtering checks both MIME type and file extension.

## [12.7] - 2026

### Fixed
- **Foreground responsiveness during background scans.** The matching loop now
  yields the main thread time-based from inside the inner comparison loop using
  a `MessageChannel` hand-off; the compare modal shows images instantly via the
  thumbnail URL (upgrading to the authenticated blob in the background); and the
  per-flush group rebuild is now a single O(n) pass.

## [12.6] - 2026

### Fixed
- **`batchTrash` now detects per-file failures.** Google returns HTTP 200 for
  the batch envelope even when individual deletes fail; the multipart response
  is now parsed so a file that failed to trash is reported and kept in the list.

### Changed
- **Thumbnail fast-path for hashing.** Plain perceptual hashing tries a 512px
  thumbnail first and falls back to the full original on any failure, cutting
  download bandwidth.

## [12.5] - 2026

### Fixed
- **Rejection feedback actually applies now** — rejected ("not a duplicate")
  pairs are preloaded and skipped in the match loop instead of reappearing.

### Changed
- Folder paths built only for files shown in results (not every scanned image),
  saving thousands of Drive API calls on large libraries.
- Pairwise similarity memoized in the renderer; hash worker reuses canvases;
  faster rejection-key lookups; removed dead imports.

## [12.4] - 2026

### Fixed
- Implemented the missing `groupBestPct()` and `makeSimilarityBadge()` helpers
  in `render.js` (a `ReferenceError` had surfaced as a scan failure).
- Declared the missing `currentIdToEntry` in `compare.js` (fixing the rejection
  recording path / Feature #19).

## [12.0] - 2026-03

### Added
- **Security hardening for OAuth verification readiness:** new `security.js`
  (runtime CSP, Referrer-Policy, Permissions-Policy, CSRF state tokens, origin
  whitelist, in-memory token storage, DOM sanitizer, input validators); hardened
  `auth.js`, `drive.js`, `scan.js`, `app.js`, `sw.js`, and `index.html`.

### Fixed
- (12.1) CSP blocking Font Awesome fonts and the Google OAuth popup on localhost.
- (12.2) Missing `validateFolderId` import that caused all scans to fail; stale
  service-worker cache lock.

## [11.0] - 2026-03

### Added
- Persistent scan settings (IndexedDB); per-group similarity badge; telemetry
  overlay; recoverable scan resume; MD5 exact-duplicate fast path; **pHash**
  (DCT); aspect-ratio pre-filter; AIMD adaptive concurrency; full CSV/JSON export
  with match metadata; incremental **delta scan**; auto-tuned LSH band config;
  rotation-invariant hashing; SharedArrayBuffer zero-copy pipeline; false-
  positive rejection feedback loop; service-worker background queue; and an
  **Undo delete** button.

## [10.1] - 2026

### Added
- Sobel **edge-texture histogram** combined with color (40% color / 60% edge) to
  cut false positives; delete button + `D` shortcut in the crop modal.

### Changed
- Unified trash-can icons across all result rows; richer folder-traversal status
  reporting during scans.

## [10.0] - 2026

### Added
- **Crop detection** (sub-region hashing) and **color histogram** matching;
  delete button on KEEP rows (with confirmation).

## [9.4] - 2026-01

### Added
- Compare-modal keyboard shortcuts (`1`/`2`/`3`, arrows, `Esc`); download links
  in the compare modal; auto-advance after delete; filter statistics; visual
  group separation.

### Fixed
- "Trash Selected" count no longer resets while scrolling the virtual list; the
  KEEP image is consistently shown on the left in the compare modal.
