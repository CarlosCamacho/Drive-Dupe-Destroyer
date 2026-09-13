# Changelog

All notable changes to **Drive Dupe Destroyer** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/).

> The detailed, original per-version notes are archived in
> [`docs/changelog/`](docs/changelog/). This file is the consolidated summary.

## [14.1] - 2026-09-13

Maintenance release: correctness fixes in the logic that decides what gets
deleted, the first automated tests, and an About dialog.

### Fixed
- **Undo now records every delete.** It previously recorded none: `compare.js`
  imported `pushUndoDelete` and never called it, and the results-table, bulk
  and crop delete paths called `batchTrash` directly. The Undo button was
  therefore always disabled. The stack now holds *operations* rather than
  individual files (one click restores a whole bulk delete) and is persisted to
  IndexedDB, so a refresh no longer discards it.
- **Keep-file selection.** The "highest resolution" rule compared a pixel count
  against a byte count whenever Drive omitted image dimensions, so a large file
  with no metadata could beat a genuine higher-resolution original. The folder
  priority rule matched patterns against Drive folder IDs and file names rather
  than folder paths, and ran before paths were resolved, so it silently did
  nothing. Ties now break deterministically instead of depending on scan order.
- **Non-image files are no longer downloaded.** Files Drive typed as
  `application/octet-stream` passed the format filter on the MIME type alone,
  so archives and installers were downloaded in full before failing to decode.
  An ambiguous MIME type now requires a recognised extension.
- **Batch trash actually batches.** The parser for Google's batch response
  never matched its angle-bracketed `Content-ID` header, so every chunk fell
  back to 100 individual requests.
- **Consistent keep rule.** The scan and render pipelines defaulted to
  different rules and could nominate different files to keep.
- `bytesToHuman(0)` returns `0 B` rather than an em dash, so an empty file is
  distinguishable from one of unknown size.

### Added
- **About dialog**, reachable from a new button beside Donate. Shows the
  version, copyright, repository link, donation prompt and a bug-report link.
- **Test suite** (`npm test`, no dependencies) covering the pure functions, and
  a CI workflow that runs it on every push.
- **Deletion confirmation** on the per-row trash button, matching the KEEP row.
- `.gitignore`, which the README's Project Structure had always listed.

### Changed
- The header subtitle is now just "Google Drive Similar Image Finder"; the
  copyright moved into the About dialog.
- The version lives in one constant (`APP_VERSION` in `js/util.js`) instead of
  ~56 hardcoded strings. The service worker cache name derives from it, so
  bumping the version now invalidates stale caches as a side effect.

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
