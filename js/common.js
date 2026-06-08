/*
 * Drive Dupe Destroyer (DDD) v14.0 — common.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Noncommercial use only: you may use, copy, modify, and share this
 * software for any noncommercial purpose. Commercial use — including
 * selling it or hosting it as a paid product or service — is NOT permitted.
 * Full terms: see the LICENSE file, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0/
 */
// Shared functions with performance optimizations
// Added: crop-resistant matching, combined color+edge histogram matching

/**
 * COMPREHENSIVE IMAGE FORMAT SUPPORT
 * Browser-decodable formats that createImageBitmap can handle
 */
export const SUPPORTED_IMAGE_MIMES = new Set([
  // Primary formats (widely supported)
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  
  // Extended formats
  'image/tiff',
  'image/x-tiff',
  'image/svg+xml',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jxl',           // JPEG XL
  'image/jp2',           // JPEG 2000
  'image/jpx',           // JPEG 2000 extended
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/ico',
  
  // Raw camera formats (may need conversion)
  'image/x-canon-cr2',
  'image/x-canon-crw',
  'image/x-nikon-nef',
  'image/x-sony-arw',
  'image/x-panasonic-raw',
  'image/x-olympus-orf',
  'image/x-fuji-raf',
  'image/x-adobe-dng',
  'image/x-raw',
  
  // Other formats
  'image/x-ms-bmp',
  'image/pjpeg',         // Progressive JPEG
  'image/x-png',
  'image/apng',          // Animated PNG
  'image/x-portable-pixmap',
  'image/x-portable-graymap',
  'image/x-portable-bitmap',
  // Legacy / design formats
  'image/vnd.adobe.photoshop', // PSD
  'image/x-photoshop',
  'image/photoshop',
  'image/psd',
  'application/x-photoshop',
  'application/photoshop',
  'application/psd',
  'application/octet-stream', // Some Drive uploads report PSD/TGA/IFF/PCX this way; extension check narrows it.
  'image/tga',
  'image/x-tga',
  'image/x-targa',
  'image/targa',
  'image/iff',
  'image/x-iff',
  'image/ilbm',
  'image/x-ilbm',
  'image/x-pcx',
  'image/pcx',
]);

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.png', '.gif', '.webp', '.bmp', '.dib',
  '.tif', '.tiff', '.svg', '.avif', '.heic', '.heif', '.jxl', '.jp2', '.jpx',
  '.ico', '.cr2', '.crw', '.nef', '.arw', '.raw', '.orf', '.raf', '.dng',
  '.ppm', '.pgm', '.pbm',
  '.psd',                    // Adobe Photoshop
  '.tga', '.targa',           // Truevision TGA / Targa
  '.iff', '.ilbm', '.lbm',    // Amiga IFF / ILBM
  '.pcx'                     // PiCture eXchange
]);

export function getFileExtension(name) {
  if (!name || typeof name !== 'string') return '';
  const clean = name.toLowerCase().split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot) : '';
}

export function isImageFileName(name) {
  return SUPPORTED_IMAGE_EXTENSIONS.has(getFileExtension(name));
}

export function isSupportedImageFile(file) {
  if (!file) return false;
  return isImageMime(file.mimeType) || isImageFileName(file.name);
}


/**
 * Check if mime type is a supported image format
 * Falls back to prefix check for unknown formats
 */
export function isImageMime(mime) {
  if (!mime || typeof mime !== 'string') return false;
  const lower = mime.toLowerCase();
  return SUPPORTED_IMAGE_MIMES.has(lower) || lower.startsWith('image/');
}

/**
 * Get format category for UI display
 */
export function getFormatCategory(mime) {
  if (!mime) return 'unknown';
  const lower = mime.toLowerCase();
  
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'].includes(lower)) {
    return 'standard';
  }
  if (['image/heic', 'image/heif', 'image/avif', 'image/jxl'].includes(lower)) {
    return 'modern';
  }
  if (lower.includes('raw') || lower.includes('cr2') || lower.includes('nef') || 
      lower.includes('arw') || lower.includes('dng')) {
    return 'raw';
  }
  if (lower.includes('photoshop') || lower.includes('psd')) return 'photoshop';
  if (lower.includes('tga') || lower.includes('targa')) return 'targa';
  if (lower.includes('iff') || lower.includes('ilbm')) return 'amiga';
  if (lower.includes('pcx')) return 'pcx';
  return 'other';
}

/**
 * Precomputed popcount lookup table for bytes (0-255)
 * This is the fastest method for small operands
 */
export const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, c = 0;
  while (v) { c += v & 1; v >>>= 1; }
  POPCOUNT_TABLE[i] = c;
}

/**
 * Fast 32-bit popcount using parallel bit manipulation
 * ~3x faster than loop-based for 32-bit values
 */
function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0F0F0F0F;
  x = x + (x >>> 8);
  x = x + (x >>> 16);
  return x & 0x3F;
}

/**
 * Calculate Hamming distance between two byte arrays
 * Uses table lookup for small arrays, 32-bit ops for larger
 */
export function hammingDistance(a, b) {
  if (!a || !b) return null;
  const len = Math.min(a.length, b.length);
  
  // For small arrays (≤16 bytes), table lookup is fastest
  if (len <= 16) {
    let dist = 0;
    for (let i = 0; i < len; i++) {
      dist += POPCOUNT_TABLE[a[i] ^ b[i]];
    }
    return dist;
  }
  
  // For larger arrays, use 32-bit operations
  return hammingBytes32(a, b);
}

/**
 * Optimized Hamming distance using 32-bit operations with parallel popcount
 * ~2-3x faster than byte-by-byte for typical hash sizes (8-18 bytes)
 */
export function hammingBytes32(a, b) {
  if (!a || !b) return Infinity;
  
  const len = Math.min(a.byteLength, b.byteLength);
  let dist = 0;
  
  // Process 4 bytes at a time using DataView for alignment safety
  const words = Math.floor(len / 4);
  
  if (words > 0) {
    // Use DataView for unaligned access (safer than typed array)
    const dvA = new DataView(a.buffer, a.byteOffset, len);
    const dvB = new DataView(b.buffer, b.byteOffset, len);
    
    for (let i = 0; i < words; i++) {
      const xor = dvA.getUint32(i * 4, true) ^ dvB.getUint32(i * 4, true);
      dist += popcount32(xor);
    }
  }
  
  // Handle remaining bytes with table lookup
  for (let i = words * 4; i < len; i++) {
    dist += POPCOUNT_TABLE[a[i] ^ b[i]];
  }
  
  return dist;
}

/**
 * Early-exit Hamming distance - stops if threshold exceeded
 * Useful for filtering candidates quickly
 */
export function hammingWithThreshold(a, b, threshold) {
  if (!a || !b) return Infinity;
  
  const len = Math.min(a.byteLength, b.byteLength);
  let dist = 0;
  
  for (let i = 0; i < len; i++) {
    dist += POPCOUNT_TABLE[a[i] ^ b[i]];
    // Early exit if we exceed threshold
    if (dist > threshold) return Infinity;
  }
  
  return dist;
}

/**
 * Calculate best distance between two entries considering variants
 * Optimized with early exit on perfect match
 */
export function bestDist(entryA, entryB, withVariants = false, use12 = true) {
  const A = use12 ? entryA.base12 : entryA.base8;
  const B = use12 ? entryB.base12 : entryB.base8;
  
  if (!A || !B) return Infinity;
  
  // Primary comparison
  let best = hammingBytes32(A, B);
  if (best === 0) return 0;  // Perfect match, no need to check variants
  
  if (!withVariants) return best;
  
  // Check B's variants against A
  const bVariants = entryB.variants;
  if (bVariants?.length) {
    for (let i = 0; i < bVariants.length; i++) {
      const vHash = use12 ? bVariants[i].base12 : bVariants[i].base8;
      if (vHash) {
        const d = hammingWithThreshold(A, vHash, best - 1);
        if (d < best) {
          best = d;
          if (best === 0) return 0;
        }
      }
    }
  }
  
  // Check A's variants against B
  const aVariants = entryA.variants;
  if (aVariants?.length) {
    for (let i = 0; i < aVariants.length; i++) {
      const vHash = use12 ? aVariants[i].base12 : aVariants[i].base8;
      if (vHash) {
        const d = hammingWithThreshold(vHash, B, best - 1);
        if (d < best) {
          best = d;
          if (best === 0) return 0;
        }
      }
    }
  }
  
  // Cross-check variants (only if still looking for better match)
  if (best > 0 && aVariants?.length && bVariants?.length) {
    outer: for (let i = 0; i < aVariants.length; i++) {
      const vaHash = use12 ? aVariants[i].base12 : aVariants[i].base8;
      if (!vaHash) continue;
      
      for (let j = 0; j < bVariants.length; j++) {
        const vbHash = use12 ? bVariants[j].base12 : bVariants[j].base8;
        if (!vbHash) continue;
        
        const d = hammingWithThreshold(vaHash, vbHash, best - 1);
        if (d < best) {
          best = d;
          if (best === 0) break outer;
        }
      }
    }
  }
  
  return best;
}

/**
 * Compare crop-resistant hashes between two entries.
 * Returns the minimum Hamming distance found across all region pairs.
 * This catches cases where one image is a crop of another: the
 * full image's center hash should match a cropped image's full hash,
 * or their overlapping quadrants should align.
 */
export function bestCropDist(entryA, entryB) {
  const aCrops = entryA.cropHashes;
  const bCrops = entryB.cropHashes;
  if (!aCrops?.length || !bCrops?.length) return Infinity;
  
  let best = Infinity;
  
  // Compare A's full hash against B's crop regions
  const aFull = entryA.base12;
  const bFull = entryB.base12;
  
  if (aFull) {
    for (const bCrop of bCrops) {
      if (!bCrop.hash) continue;
      const d = hammingBytes32(aFull, bCrop.hash);
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  
  if (bFull) {
    for (const aCrop of aCrops) {
      if (!aCrop.hash) continue;
      const d = hammingBytes32(bFull, aCrop.hash);
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  
  // Cross-compare crop regions
  for (const aCrop of aCrops) {
    if (!aCrop.hash) continue;
    for (const bCrop of bCrops) {
      if (!bCrop.hash) continue;
      const d = hammingWithThreshold(aCrop.hash, bCrop.hash, best - 1);
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  
  return best;
}

/**
 * Compare color histograms using Manhattan distance.
 * Returns a normalized distance 0.0 (identical) to 1.0 (opposite).
 * Color distribution is largely preserved across crops, making this
 * a powerful complement to structural hashing for crop detection.
 */
export function colorHistDistance(entryA, entryB) {
  const hA = entryA.colorHist;
  const hB = entryB.colorHist;
  if (!hA || !hB) return Infinity;
  
  const len = Math.min(hA.length, hB.length);
  let totalDiff = 0;
  
  for (let i = 0; i < len; i++) {
    totalDiff += Math.abs(hA[i] - hB[i]);
  }
  
  // Normalize: max possible = 255 * len
  return totalDiff / (255 * len);
}

/**
 * Compare edge/texture histograms using Manhattan distance.
 * Captures edge direction distribution, edge strength, and spatial density.
 * This is critical for false-positive rejection: images with similar colors
 * but totally different structures (e.g. different banknotes, different 
 * landscapes) will have very different edge histograms.
 */
export function edgeHistDistance(entryA, entryB) {
  const hA = entryA.edgeHist;
  const hB = entryB.edgeHist;
  if (!hA || !hB) return Infinity;
  
  const len = Math.min(hA.length, hB.length);
  let totalDiff = 0;
  
  for (let i = 0; i < len; i++) {
    totalDiff += Math.abs(hA[i] - hB[i]);
  }
  
  return totalDiff / (255 * len);
}

/**
 * Combined color+edge similarity score.
 * Returns a normalized distance 0.0 (identical) to 1.0 (opposite).
 * Uses weighted combination: 40% color + 60% edge/structure.
 * The heavy edge weighting prevents false matches on images that 
 * share colors but have completely different content.
 */
export function combinedHistDistance(entryA, entryB) {
  const colorDist = colorHistDistance(entryA, entryB);
  const edgeDist = edgeHistDistance(entryA, entryB);
  
  if (!isFinite(colorDist) && !isFinite(edgeDist)) return Infinity;
  if (!isFinite(edgeDist)) return colorDist;
  if (!isFinite(colorDist)) return edgeDist;
  
  // Weight: structure matters more than color for duplicate detection
  return colorDist * 0.4 + edgeDist * 0.6;
}

/**
 * Combined distance considering all available matching methods.
 * Returns a distance suitable for threshold comparison.
 */
export function bestDistExtended(entryA, entryB, withVariants, use12, withCropDetect, withColorMatch, hamThresh) {
  // Standard dHash distance
  let dist = bestDist(entryA, entryB, withVariants, use12);
  if (dist === 0) return 0;
  if (dist <= hamThresh) return dist;
  
  // If basic hash didn't match, try crop detection
  if (withCropDetect) {
    const cropDist = bestCropDist(entryA, entryB);
    // Use a slightly more lenient threshold for crop matches since 
    // region hashes inherently lose some accuracy
    const cropThresh = Math.ceil(hamThresh * 1.3);
    if (cropDist <= cropThresh) {
      // Verify with combined histogram (color+edge) if available
      // This prevents false crop matches between structurally different images
      if (withColorMatch) {
        const combDist = combinedHistDistance(entryA, entryB);
        // Combined distance < 0.12 means similar BOTH in color AND structure
        if (combDist < 0.12) {
          return Math.min(dist, cropDist);
        }
        // Fall through — crop hash matched but histograms differ too much
      } else {
        return Math.min(dist, cropDist);
      }
    }
  }
  
  // Color+edge histogram as a secondary match signal
  // Only promote if BOTH color and edge/texture are very close
  if (withColorMatch && dist > hamThresh) {
    const combDist = combinedHistDistance(entryA, entryB);
    // Very similar in both color AND structure + reasonably similar hash = match
    if (combDist < 0.06 && dist <= hamThresh * 2) {
      return hamThresh; // Promote to threshold match
    }
  }
  
  return dist;
}

/**
 * Batch distance calculation for multiple candidates
 * More efficient when checking many pairs
 */
export function batchBestDist(entry, candidates, idToEntry, withVariants, use12, threshold) {
  const results = [];
  const A = use12 ? entry.base12 : entry.base8;
  if (!A) return results;
  
  for (const candId of candidates) {
    const candEntry = idToEntry.get(candId);
    if (!candEntry) continue;
    
    const B = use12 ? candEntry.base12 : candEntry.base8;
    if (!B) continue;
    
    // Quick check with threshold
    let dist = hammingWithThreshold(A, B, threshold);
    
    if (dist <= threshold) {
      // If within threshold, get exact best distance including variants
      if (withVariants && dist > 0) {
        dist = bestDist(entry, candEntry, true, use12);
      }
      
      if (dist <= threshold) {
        results.push({ id: candId, dist });
      }
    }
  }
  
  return results;
}

/**
 * Choose which file to keep in a duplicate group
 * Fixed: Uses file size as fallback when imageMediaMetadata is missing
 */
export function chooseKeepIndex(group, keepRule, folderPriorityCsv = "") {
  if (!Array.isArray(group) || group.length <= 1) return 0;
  
  const mod = f => Date.parse(f.modifiedTime || 0) || 0;
  const size = f => Number(f.size || 0) || 0;
  
  // Resolution function with fallback to file size
  // When imageMediaMetadata is missing, use file size as proxy
  // (larger files often correlate with higher resolution for same format)
  const res = f => {
    const w = Number(f.imageMediaMetadata?.width || 0);
    const h = Number(f.imageMediaMetadata?.height || 0);
    if (w > 0 && h > 0) {
      return w * h;
    }
    // Fallback: use file size (not ideal but better than 0)
    return Number(f.size || 0);
  };
  
  // Parse and cache folder priority lookup
  const folderPriority = (folderPriorityCsv || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  
  const folderRank = (f) => {
    const p = (f.parents?.[0] || "").toLowerCase();
    const name = (f.name || "").toLowerCase();
    const path = (f._path || "").toLowerCase();
    
    for (let i = 0; i < folderPriority.length; i++) {
      const pattern = folderPriority[i];
      if (p.includes(pattern) || name.includes(pattern) || path.includes(pattern)) {
        return i;
      }
    }
    return 999999;
  };

  let best = 0;
  
  for (let i = 1; i < group.length; i++) {
    const a = group[best], b = group[i];
    let pickB = false;

    switch (keepRule) {
      case "newest":
        pickB = mod(b) > mod(a);
        break;
      case "oldest":
        pickB = mod(b) < mod(a);
        break;
      case "largest":
        pickB = size(b) > size(a);
        break;
      case "smallest":
        pickB = size(b) < size(a);
        break;
      case "hires":
        pickB = res(b) > res(a);
        break;
      case "folderPriority":
        pickB = folderRank(b) < folderRank(a);
        break;
    }
    
    if (pickB) best = i;
  }
  
  return best;
}

/**
 * Convert similarity distance to percentage
 */
export function distToPercent(dist, bits = 144) {
  if (dist === null || dist === undefined || !isFinite(dist)) return null;
  if (dist === 0) return 100;
  const pct = 100 * (1 - dist / bits);
  return Math.max(0, Math.min(99, Math.round(pct)));
}

/**
 * Map easy threshold level to Hamming threshold
 * Calibrated for 12x12 dHash (144 bits)
 */
export function thresholdFromEasy(level) {
  const map = { 
    1: 20,  // Very loose - may have false positives
    2: 14,  // Loose
    3: 10,  // Balanced (default)
    4: 6,   // Strict
    5: 3    // Very strict - nearly identical only
  };
  return map[level] ?? 10;
}

/**
 * Estimate similarity category from distance
 */
export function similarityCategory(dist, bits = 144) {
  const pct = distToPercent(dist, bits);
  if (pct === 100) return 'identical';
  if (pct >= 95) return 'near-identical';
  if (pct >= 85) return 'very-similar';
  if (pct >= 70) return 'similar';
  return 'different';
}

// ============================================================================
// pHash distance (Feature #7)
// ============================================================================

export function pHashDistance(a, b) {
  if (!a || !b || a.length !== 8 || b.length !== 8) return Infinity;
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    let x = a[i] ^ b[i];
    while (x) { dist += x & 1; x >>>= 1; }
  }
  return dist;
}

// ============================================================================
// Aspect ratio filter (Feature #8)
// ============================================================================

/**
 * Returns true if two images might be duplicates based on aspect ratio.
 * tolerance: 0 = exact match only, 1 = 10% tolerance, 2 = 20%, etc.
 */
export function aspectRatioCompatible(fileA, fileB, tolerancePct = 20) {
  const wA = fileA?.imageMediaMetadata?.width;
  const hA = fileA?.imageMediaMetadata?.height;
  const wB = fileB?.imageMediaMetadata?.width;
  const hB = fileB?.imageMediaMetadata?.height;

  // If metadata is missing, allow the pair (don't filter blindly)
  if (!wA || !hA || !wB || !hB) return true;

  const ratioA = wA / hA;
  const ratioB = wB / hB;

  // Allow both orientations (portrait vs landscape of same ratio = valid crop)
  const diff = Math.abs(ratioA - ratioB) / Math.max(ratioA, ratioB);
  const diffFlipped = Math.abs(ratioA - 1 / ratioB) / Math.max(ratioA, 1 / ratioB);

  return diff <= tolerancePct / 100 || diffFlipped <= tolerancePct / 100;
}

// ============================================================================
// Extended bestDist with pHash (Feature #7) + aspect filter (Feature #8)  
// ============================================================================

export function bestDistWithPHash(entryA, entryB, withVariants, use12, pHashThreshBits = 12) {
  const dDist = bestDist(entryA, entryB, withVariants, use12);
  if (dDist === 0) return 0;

  // pHash is a 64-bit hash; dHash here is 144-bit. The two distances live in
  // different scales, so we must NOT return the raw pHash distance as if it
  // were a dHash distance (that corrupted the similarity % downstream, which
  // assumes 144-bit space). Instead, when pHash agrees the images match, we
  // return dDist unchanged if it's already a match, otherwise we map the pHash
  // agreement into 144-bit space proportionally so the caller's threshold and
  // the percentage calculation both stay consistent.
  if (entryA.pHashBits && entryB.pHashBits) {
    const pd = pHashDistance(entryA.pHashBits, entryB.pHashBits);
    if (pd <= pHashThreshBits) {
      // Scale the 64-bit pHash distance into 144-bit space for comparability.
      const pdScaled = Math.round(pd * 144 / 64);
      return Math.min(dDist, pdScaled);
    }
  }

  return dDist;
}
