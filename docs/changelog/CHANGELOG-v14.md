<!--
  Drive Dupe Destroyer (DDD) v14.0 — CHANGELOG-v14.md
  Copyright (c) 2025 Carlos Camacho
  SPDX-License-Identifier: MIT
-->

# Drive Dupe Destroyer — v14.0

## UI / UX

### Similarity labels no longer wrap
The band labels (`identical 100%`, `near 100%`, etc.) used to sit in the cramped
50px "Grp" column and wrapped onto two lines. The column is now **"Group / Match"**
(140px) and both the cell and the badge are `white-space: nowrap`, so the label
always stays on one line.

### Delete or download **any** image from the results table
- The KEEP (first) image's trash button is no longer ghosted/disabled. It is now
  a normal, clearly-clickable button (dashed outline to flag that it's the keep
  image) and still asks for confirmation before deleting.
- Every row now has a **download** button, so you can download any image —
  keep or duplicate — directly from the table.
- Fixed a latent bug where clicking the trash **icon** (rather than the button
  edge) did nothing; the whole button is now clickable.

### New "🖼️ Image Types" panel (left sidebar, under Scan Settings)
A new section lets you choose exactly which formats a scan includes. Toggle
individual formats (JPEG, PNG, GIF, WebP, BMP, TIFF, SVG, HEIC/HEIF, AVIF, ICO,
JPEG 2000, JPEG XL, Netpbm, RAW, PSD, TGA, IFF/ILBM, PCX) or use **Select all**
to flip them all at once. A badge shows how many formats are enabled. All
formats are enabled by default, so scans behave exactly as before unless you
change something. The scan filters collected files by the checked formats
(matched by extension; files identified only by MIME type are never dropped just
for lacking a suffix).

### File Location is now clickable
Both the **Folder** cell in the results table and the **path breadcrumb** in the
compare modal are now links that open the file's containing folder in Google
Drive (new tab), so you can see the file in context next to its neighbours.

### Placeholder image instead of broken thumbnails
- During a live scan, rows appear before their thumbnails exist. Instead of a
  broken-image glyph, each thumbnail now shows a lightweight inline placeholder
  icon and is replaced with the real thumbnail when it loads — so scanning isn't
  slowed down by eager thumbnail generation.
- **Any** image that fails to load anywhere (table thumbnail or compare-modal
  image) now falls back to the same placeholder instead of a broken image.
  Persistently-broken thumbnails are marked so they aren't retried on every
  scroll.

## Code quality

### Bug / optimization review (and fixes)
- **Trash-icon click dead zone** (described above) — fixed.
- **Placeholder data URI** is percent-encoded (`encodeURIComponent`) so it's
  valid in strict parsers, not just lenient browsers, and can never itself 404.
- **Single source of truth** for the image-placeholder asset (`IMAGE_PLACEHOLDER`
  in `util.js`), reused by both the results table and the compare modal.
- Thumbnail loaders now skip images already marked failed, avoiding repeated
  doomed re-fetches of the same broken thumbnail during scrolling.

## Documentation

- The user manual was updated from v11.0 to **v14.0** (`DDD-v14-Manual.docx`,
  replacing `DDD-v11-Manual.docx`). It documents the new Image Types panel,
  per-row download/delete (including the keep file), clickable File Location
  links, the placeholder-image behavior, the `4` = Ignore keyboard shortcut,
  the expanded format support (PSD/TGA/IFF/PCX and more), and removal of handled
  pairs from the results list.

## Versioning

- Bumped to **v14.0** across every source file (`index.html`, `sw.js` cache
  `drive-dupe-destroyer-v14`, `ui.js` `APP_VERSION = "14.0"`, `app.js`, the legal
  pages, the Python helpers, and the MIT header comment in every file).
- Carries forward the v12.9 fixes (Drive discovery query, ignore persistence,
  found-list removal) — see `CHANGELOG-v12.9.md`.

## Verification
- `node --check` passes on all JavaScript modules; `py_compile` passes on the
  Python helpers.
- The image-type filter, placeholder data URI, and folder-link construction were
  unit-checked in isolation.
