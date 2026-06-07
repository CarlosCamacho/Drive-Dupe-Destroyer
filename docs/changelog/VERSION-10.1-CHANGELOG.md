<!-- Drive Dupe Destroyer v12.8 — VERSION-10.1-CHANGELOG.md -->
# DDD v10.1 Changelog

## Fixes & Improvements

### 1. Consistent Delete Buttons (Trash Icons Everywhere)
- All delete buttons in the results table now use trash can icons (`<i class="fa-solid fa-trash">`) 
- Previously: keep rows had trash icon, duplicate rows had "Delete" text button — now unified
- Keep-row trash icon remains subtly dimmed with confirmation dialog

### 2. Delete Button in Crop Modal
- New **Delete** button added to crop modal footer, between Cancel and Crop
- Keyboard shortcut: `D` key deletes the current image while in crop modal
- After deletion, automatically navigates to the next image in the group
- Confirmation dialog prevents accidental deletions

### 3. Improved Scan Visibility (Folder Traversal Reporting)
- Status bar now shows: folders scanned, images found, subfolders queued, AND total subfolders discovered
- Example: `Scanning folder 47… (3,412 images found, 12 subfolders queued, 183 total subfolders discovered)`
- Completion summary: `Collection complete: 15,230 images in 214 folders (387 subfolders traversed)`  
- Console log with full statistics for debugging
- **Re: recursion question** — Yes, the recursive scan is fully recursive to unlimited depth. The BFS queue (`queue.push(sub.id)`) discovers all subfolders at every level. The Drive API query `mimeType = 'application/vnd.google-apps.folder'` fetches ALL subfolders per folder, and each gets added to the queue. The speed comes from parallel API calls and the Drive API being inherently fast at listing.

### 4. False-Positive Reduction: Edge Texture Histogram
- **Problem**: Color histogram alone caused false positives — totally different images with similar color palettes matched (e.g. different banknotes, different landscapes with similar colors)
- **Solution**: Added Sobel-based edge/texture histogram alongside color histogram
  - 6-bin edge direction histogram (0° to 180° in 30° increments)
  - 4-bin edge magnitude histogram (weak to strong edges)
  - 4-bin spatial edge density (edge distribution per quadrant)
- Combined scoring: **40% color + 60% edge/structure** weight
- Candidate expansion now requires BOTH similar colors AND similar edge structure
- Crop match verification requires combined similarity < 0.12 (not just color < 0.15)
- Secondary promotion requires combined similarity < 0.06 (not just color < 0.08)
- UI label renamed from "Color histogram" → "Color + edge match"

### 5. Refactoring
- Version strings unified across all modules (v10.1)
- `crop.js` version comment updated to reflect new features
- `common.js` header comment updated  
- `worker-hash.js` header comment updated
- DB cache schema extended to store `edgeHist` alongside `colorHist` and `cropHashes`
- Cache invalidation: existing cached entries without edge histograms automatically recompute when the feature is enabled

## Technical Details

### How Edge Texture Histogram Works
```
For each pixel (on a 64×64 downscaled copy):
  1. Apply Sobel operators (Gx, Gy) to compute gradient
  2. Compute magnitude: sqrt(Gx² + Gy²)  
  3. If magnitude > 30 (significant edge):
     a. Compute direction: atan2(Gy, Gx) → [0, PI)
     b. Bin into 6 direction buckets (30° each)
     c. Bin magnitude into 4 strength buckets
     d. Count edge in its spatial quadrant (TL/TR/BL/BR)
  4. Normalize all bins by total edge count → Uint8Array[14]
```

### Why This Fixes False Positives
Two banknotes may share 70%+ of their color palette (similar greens, similar browns), giving a low color histogram distance. But their edge patterns — the direction, strength, and spatial distribution of edges from text, portraits, borders, serial numbers — are completely different. The edge histogram catches this.

### Recursion Confirmation
The scan uses BFS (breadth-first search) with a queue. For each folder:
1. Fetch all images (`mimeType contains 'image/'`)
2. Fetch all subfolders (`mimeType = 'application/vnd.google-apps.folder'`)
3. Add each subfolder to the queue

This continues until the queue is empty — meaning ALL levels of nesting are covered. The `visited` set prevents infinite loops from circular references. The speed comes from the Drive API being very fast at folder listing (metadata only, no file downloads at this stage).
