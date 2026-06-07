<!-- Drive Dupe Destroyer v12.8 — VERSION-12.4-CHANGELOG.md -->
# Drive Dupe Destroyer v12.4 Changelog

## v12.4 (patch)

### Bug fixes

- **Fixed: `Scan failed: groupBestPct is not defined`** — `js/render.js` called `groupBestPct(sortedGroup, 0, idToEntry, bitsCount, withVariants)` inside `renderGroups`, but the function had never been defined in the file. The v11 changelog claimed `groupBestPct()` and `makeSimilarityBadge()` were added to `render.js` for Feature #2 (Per-Group Similarity Score Badge), but only the call site shipped — the helpers were missing. Because `renderGroups` runs as the `renderCb` callback inside `runScan`, the ReferenceError propagated up through the scan's try/catch and surfaced as a scan failure ("Phase: Failed") rather than a render error. Both helpers are now implemented:
  - `groupBestPct(group, keepIdx, idToEntry, bitsCount, withVariants)` — returns the best (highest) pairwise similarity percentage in a duplicate group, measured against the keep file at `keepIdx`. Returns `null` for groups of fewer than 2 items or when no pairs have comparable hashes.
  - `makeSimilarityBadge(pct)` — renders `<span class="similarityBadge badge-X">label pct%</span>` using the four CSS classes already defined in `styles.css`: `badge-identical` (100%), `badge-near` (≥90%), `badge-similar` (≥75%), `badge-loose` (<75%). Returns empty string for null/undefined input.
  - The badge is now inserted into the group-id `<td>` on the first row of each group, completing Feature #2 from v11.

- **Fixed: `currentIdToEntry is not defined` in `js/compare.js`** — line 339 of `openCompare()` assigned `currentIdToEntry = options.idToEntry` and line 163 of `handleIgnoreGroup()` read it, but the variable was never declared at module scope. ES modules run in strict mode, so this would have thrown a ReferenceError every time the Compare modal was opened, breaking Feature #19 (rejection recording when clicking "Not a duplicate"). Added `let currentIdToEntry = null;` to the module-level state declarations at the top of the file.

### Housekeeping

- Bumped SW cache name to `drive-dupe-destroyer-v12.4` so users get fresh files on next reload.
- Updated `APP_VERSION` in `js/ui.js` from `"12.3"` to `"12.4"`.
- Updated version strings in `index.html` (title + header), `js/app.js` (init/ready console logs), and `sw.js` (activation log).
- Folder renamed from `Drive_Dupe_Destroyer_v12.3` to `Drive_Dupe_Destroyer_v12.4`.

### Static audit performed during this patch

In addition to the two reported bugs, the following sweeps were run across all 32 `js/*.js` files and found no further issues at the static level:

- Node `--check` syntax validation: clean.
- Cross-module import resolution: every `import { x } from './y.js'` resolves to a real export.
- Acorn AST-based undefined-reference scan with full scope tracking: no remaining unresolved free identifiers (all flagged items were verified false positives — DOM globals like `confirm`, JS labels like `outer:`, `import.meta` expressions, and re-export shorthand).

Runtime behavior (race conditions, API response handling, IndexedDB transactions, worker messaging) was not audited.

## Files modified
- `js/render.js` — added `groupBestPct()` and `makeSimilarityBadge()`, wired badge into row HTML
- `js/compare.js` — added missing `currentIdToEntry` module-level declaration
- `js/ui.js` — bumped `APP_VERSION`
- `js/app.js` — bumped console version strings
- `js/folderPicker.js` — bumped file-header version tag
- `index.html` — bumped title and visible header version
- `sw.js` — bumped cache name and activation log version
