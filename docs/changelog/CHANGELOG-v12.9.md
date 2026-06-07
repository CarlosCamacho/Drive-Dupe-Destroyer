<!--
  Drive Dupe Destroyer (DDD) v12.9 — CHANGELOG-v12.9.md
  Copyright (c) 2025 Carlos Camacho
  SPDX-License-Identifier: MIT
-->

# Drive Dupe Destroyer — v12.9

## Bug fixes

### 1. Duplicates were silently not found (the `title.gif` report)

**Root cause:** The v12.8 Drive discovery query tried to find the new
PSD/TGA/IFF/PCX formats with clauses like `name contains '.psd'`. Google Drive's
`contains` operator does **prefix** matching on the `name` field, not substring
matching — a file named `HelloWorld` matches `name contains 'Hello'` but **not**
`name contains 'World'`. So `name contains '.psd'` never matches `photo.psd`, and
the new-format discovery did not actually work. Worse, chaining 14 of those
clauses bloated the per-folder query and risked the whole request failing
server-side, which returned **zero files for the folder** — so even ordinary
images that matched `mimeType contains 'image/'` (such as two identical
`title.gif` copies) were never seen. Clearing the cache had no effect because the
failure happened at collection time, before any hashing or caching.

**Fix:** Discovery is now done by **MIME type only**:

- `mimeType contains 'image/'` covers gif/jpg/png/webp/bmp/tiff/etc.
- Exact `mimeType = '…'` clauses (derived from `SUPPORTED_IMAGE_MIMES` in
  `common.js`) cover the non-image MIME types Drive assigns to design/legacy
  formats, including `application/octet-stream` (how Drive often reports PSD/TGA/
  IFF/PCX uploads).
- Final extension narrowing is done **client-side** by `isSupportedImageFile()`
  in the post-collection filter, so non-image binaries (e.g. a `.zip` reported as
  octet-stream) are reliably dropped.

This restores discovery of plain GIFs/JPEGs/etc. *and* makes the new
PSD/TGA/IFF/PCX support actually work.

### 2. "Ignore" (key `4`) removed the wrong group

**Root cause:** `handleIgnoreGroup()` removed the group **twice** — once via the
`onIgnoreGroup` callback and again via the `ddd:ignoreGroup` event, both of which
call `removeGroupByIndex(currentGroupIndex)`. The second call ran after the array
had already shifted, so it silently removed an *unrelated adjacent* group while
leaving the intended one behavior inconsistent.

**Fix:** Group removal now goes through a **single path** (the `ddd:ignoreGroup`
event, matching the `ddd:trashed` delete flow).

### 3. "Ignore" never persisted across scans

**Root cause:** Rejections (the "don't show this pair again" record) were only
written when `openCompare()` was called with an `idToEntry` option — but neither
the results-table click handler nor in-modal navigation passed it, so
`currentIdToEntry` was almost always `null` and no rejection was ever recorded.
Ignored pairs reappeared on the next scan.

**Fix:** The compare modal now resolves the live hash map through a new
`getIdToEntry` callback wired from the renderer, so ignored pairs are recorded
and stay suppressed on future scans.

## Enhancement

### Acting on a pair in the compare modal removes it from the FOUND list

When reviewing a pair in the compare modal, keys `1`–`4` now reliably remove the
handled images from the results list:

- `1` — delete the left image
- `2` — delete the right image
- `3` — delete both images
- `4` — ignore (not a duplicate)

After any of these, the affected rows are removed from the FOUND list (deleting
one image also removes its now-orphaned partner, since a group of one is no
longer a duplicate). Once you have dealt with a pair, you no longer see it in the
list. Deletes were already removed via the `ddd:trashed` event; this release
makes the **ignore** path correct (see bug fixes #2 and #3) so all four actions
behave consistently.

## Housekeeping / refactoring

- **Single source of truth for formats:** the Drive discovery query's non-image
  MIME clauses are now derived from `SUPPORTED_IMAGE_MIMES` in `common.js`
  instead of a second hand-maintained list in `scan.js`. Adding a format in one
  place now updates discovery automatically.
- **License + version headers:** every source file (`.js`, `.css`, `.html`,
  `.py`) now carries a standardized header with the version (v12.9), copyright
  (© 2025 Carlos Camacho), and the full MIT license text (`SPDX-License-Identifier: MIT`).
  A top-level `LICENSE` file was added.
- **Version bump:** v12.8 → v12.9 across `index.html`, `sw.js` (cache name
  `drive-dupe-destroyer-v12.9`), `ui.js` (`APP_VERSION`), `app.js`, the legal
  pages, and the secure-serve helper.

## Verification

- `node --check` passes on all JavaScript modules; `py_compile` passes on the
  Python helpers.
- The rebuilt discovery query was verified to: match `image/gif` (GIF found),
  fetch octet-stream-reported PSDs, and drop a `.zip` reported as octet-stream
  via the client-side extension filter.
