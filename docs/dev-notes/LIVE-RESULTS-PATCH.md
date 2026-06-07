<!-- Drive Dupe Destroyer v12.8 — LIVE-RESULTS-PATCH.md -->
# Patch notes — live results + bug fixes

## Part 1 — Live results (show & act on matches while scanning continues)
The scan engine already found matches progressively, but the UI only rendered
once, at the end. Now matches stream into the results table as they're found and
are immediately interactive (open / Compare / select / delete) while the search
keeps running.

- **js/app.js** — passes an `onProgressiveMatch` callback to `runScan` (start →
  open live session, match → stream group in, complete → end session + final render).
- **js/render.js** — new `beginProgressive()`, `pushProgressiveMatch()`,
  `endProgressive()` reuse the exact same row/virtual-scroll/click/Compare/delete
  machinery as final results. Files trashed mid-scan are tracked so a re-emitted
  group can't resurrect a deleted row; current selection is preserved across live
  re-renders.
- **js/scan.js** — `start` event now carries `idToEntry` so live rows show
  similarity %.

## Part 2 — Bugs found and fixed during review

1. **Flat-scan crash on excluded folders (js/scan.js).**
   `fetchAllImagesFlat` called `exclusions.includes(fid)`, but `getExclusions()`
   returns a `Set`, which has no `.includes` — this threw a TypeError and aborted
   any non-recursive scan that had at least one excluded folder. Now normalized to
   a Set and uses `.has()`. Resume-state persistence also normalizes the Set to an
   array.

2. **Progressive matching dropped groups (js/scan.js).**
   Emission was throttled to every 10th match, but each emit only sent the single
   most-recently-touched group. Groups formed during the skipped matches were never
   sent to the live UI (they appeared only at the very end). Replaced with
   dirty-root tracking: still throttled, but every changed group is flushed, and a
   final flush catches the last partial batch. Verified by simulation — live group
   set now exactly matches ground truth with no drops.

3. **LSH band indices left ~40% of the hash unexamined (js/lsh.js).**
   `generateBandIndices` used `((offset+r)*prime) % byteLen`, which clustered on
   low indices: the 144-bit/normal config sampled only 10 of 18 hash bytes and
   repeated one byte across 5 of 6 bands. Differences in unsampled bytes produced
   no candidates → missed (false-negative) duplicates. Rewritten to walk a stride
   coprime with the byte length, covering the whole hash with no duplicate bytes
   within a band. Coverage went from 10/18 to full (or near-full) in every config.

4. **pHash distance scale mismatch (js/common.js).**
   `bestDistWithPHash` returned the raw 64-bit pHash distance as if it were a
   144-bit dHash distance. The match itself worked, but the similarity % shown to
   the user was wrong (a pHash-only match displayed ~96% instead of ~90%). The
   pHash distance is now scaled into 144-bit space so thresholds and percentages
   are consistent.

5. **Compare opened the wrong group after filtering (js/render.js).**
   The Compare button used `groupIndex = displayedGroupId - 1` to index into
   `currentState.groups`. After the similarity filter removes groups (or in
   progressive mode), the on-screen group number no longer matches array position,
   so Compare/prev/next could operate on the wrong group. Now the group is located
   by file membership, which is always correct.

## Known limitations (not changed — larger work, flagged for awareness)
- **batchTrash (js/drive.js)** treats an HTTP-200 multipart batch response as
  "all succeeded." Google can return 200 while individual sub-requests fail (e.g.
  a 404), so a file could be reported trashed while still present. Correct handling
  requires parsing the multipart response body. Left as-is to avoid changing
  delete semantics without testing against the live API.
- Folder paths still populate on the final render (paths are built in the last
  phase); everything else in live results is immediate.
