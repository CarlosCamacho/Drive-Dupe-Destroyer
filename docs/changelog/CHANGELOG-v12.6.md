<!-- Drive Dupe Destroyer v12.8 — CHANGELOG-v12.6.md -->
# v12.6 — delete correctness + hashing bandwidth

Targeted release addressing the two highest-value items flagged in v12.5: a
correctness bug in batch deletion, and the bandwidth cost of hashing.

## 1. batchTrash now detects per-file failures (correctness)

**Before:** when the Drive batch endpoint returned HTTP 200, all 100 files in
that batch were reported as successfully trashed. But Google returns 200 for the
*batch envelope* even when individual sub-requests inside it fail (404, 403,
5xx). Those failures were invisible — a file that failed to delete was removed
from the UI while still sitting in Drive.

**Now:** each sub-request is tagged with a `Content-ID`, and the multipart
response body is parsed to read each sub-request's real HTTP status. Files are
classified by their actual outcome:
- 2xx → success
- 404 → success (file already gone; the goal — "not present" — is met)
- 403 / 5xx / other → **failed** (reported to the user, kept in the list)

Robust fallbacks:
- If the batch envelope itself errors, every id is verified with an individual
  PATCH (as before).
- If the response parses to nothing (unexpected shape), the whole chunk is
  re-verified individually rather than blindly trusted.
- Any id present in the request but missing from the parsed response is
  re-verified individually.

Tested against sample multipart responses: mixed 204/404/403, partial
responses, empty/garbage bodies, and 500s — every id lands in exactly one
bucket with no loss and no false "success".

## 2. Thumbnail fast-path for hashing (bandwidth)

**Context:** the `alt=media` Drive endpoint always returns the full-resolution
original (often several MB), but perceptual hashing only needs a small image.
Google's `googleusercontent.com` thumbnail URLs normally can't be fetched as a
blob from the browser (no CORS headers) — which is why the app always
downloaded originals.

**Now:** for plain perceptual hashing (dHash/pHash), `downloadFileBlob` accepts
`preferThumb` and tries a 512px thumbnail first, falling back to the full
original on *any* failure. This is strictly safe:
- If the thumbnail fetch is blocked by CORS or returns an unusable body
  (validated: must be an `image/*` blob > 512 bytes), we transparently download
  the original exactly as before. Hashing fidelity is never silently degraded —
  worst case is one cheap, instantly-rejected request before fallback.
- A successfully fetched thumbnail blob passed CORS, so the canvas isn't tainted
  and `getImageData` works normally.
- dHash/pHash downscale to ≤32px regardless, so a 512px source is more than
  enough for identical hash values.

**Deliberately scoped off** for crop-detection and color-matching scans: those
inspect sub-regions and full-image histograms and need the original's
resolution, so they continue downloading originals.

Net effect: in environments where Drive thumbnails are fetchable, plain scans
download ~512px images instead of multi-MB originals — a large bandwidth and
time reduction — with zero risk to environments where they aren't.

## Version

Bumped 12.5 → 12.6 in ui.js, index.html, sw.js (cache name → clean refresh on
update), and runtime logs.

## Still open (unchanged)
- **AIMD adaptive throttle** remains inactive (fixed concurrency of 6). It's an
  optimization, not a bug, and wiring it affects live Drive rate-limiting — best
  validated against a real account under load.
