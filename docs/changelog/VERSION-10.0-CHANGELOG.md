<!-- Drive Dupe Destroyer v12.8 — VERSION-10.0-CHANGELOG.md -->
# DDD v10.0 Changelog

## New Features

### 🔍 Advanced Image Matching

**Crop Detection** (`Advanced Options → Crop detection`)
- Detects when one image is a crop of another
- Computes perceptual hashes for multiple sub-regions of each image:
  - Center 60% and center 80% crops
  - Four overlapping quadrants (top-left, top-right, bottom-left, bottom-right)
- A cropped version of an original will match via shared sub-regions
- Uses a slightly relaxed threshold (1.3×) for crop matches since region hashing has inherent accuracy loss
- Works best when combined with Color Histogram matching

**Color Histogram Matching** (`Advanced Options → Color histogram`)
- Computes a 32-bin color distribution fingerprint (8 bins each for R, G, B, Luminance)
- Color distributions are largely preserved across crops, making this a strong complement to structural hashing
- Used as both:
  - A verification signal for crop matches (confirms color similarity)
  - An independent booster that promotes near-miss structural matches when colors are very similar
  - A candidate expansion source (finds additional comparison candidates beyond LSH when combined with crop detection)
- Manhattan distance with normalization for consistent comparison

### 🗑️ Delete Button on Keep Rows

- Every image in the results table now has a delete button, including the "KEEP" row
- Keep-row delete button is styled subtly (dimmed, icon-only) to prevent accidental deletion
- Clicking the keep-row delete button shows a confirmation dialog warning that this is the KEEP file
- This allows quick cleanup without having to open the Compare modal

## Technical Details

### Matching Pipeline Changes
- `worker-hash.js`: Added `computeCropHashes()` and `computeColorHistogram()` functions
- `common.js`: Added `bestCropDist()`, `colorHistDistance()`, and `bestDistExtended()` functions
- `scan.js`: Extended `findMatchesProgressively()` to use color-based candidate expansion when crop+color are both enabled
- `hashing.js`: Updated worker communication to pass `withCropDetect` and `withColorMatch` flags
- DB cache: Stores crop hashes and color histograms; automatically recomputes when new features are enabled on cached images

### Performance Considerations
- Crop detection adds ~6 additional hash computations per image (6 sub-regions × 12×12 dHash)
- Color histogram is very fast (downscales to 64×64 for computation)
- Color-based candidate expansion is capped at 2000 nearby entries to avoid O(n²) behavior
- Both features are off by default and opt-in via Advanced Options
