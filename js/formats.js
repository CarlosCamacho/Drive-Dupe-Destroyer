/*
 * Drive Dupe Destroyer (DDD) — formats.js
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
// Which image formats this app can do what with (#121).
//
// Two tiers, and the distinction is the reason this table exists at all:
// formats a browser can DECODE can be matched visually, and formats it cannot
// are still matched exactly by Drive's MD5 checksum -- which needs no decoder
// and no download, so a library of RAW files costs no bandwidth.
//
// Data and predicates over it. Nothing here computes a distance or decides
// which file to keep. All three lived in one 806-line common.js, so every
// consumer pulled in the other two concerns to get one.

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

// Extensions no browser's createImageBitmap can decode.
//
// The app lists and downloads these formats, then fails to hash them. For a
// photographer's Drive that is gigabytes of transfer -- a 60 MB CR2, a 300 MB
// layered PSD -- for zero results. They are still scanned, but via MD5 only:
// exact-duplicate detection needs no decoder and works perfectly for them,
// which is also where byte-identical copies are most likely (camera imports,
// backup folders, "Copy of" duplicates).
const UNDECODABLE_EXTENSIONS = new Set([
  '.psd',                                     // Photoshop
  '.tga', '.targa',                           // Truevision TGA
  '.iff', '.ilbm', '.lbm',                    // Amiga IFF / ILBM
  '.pcx',                                     // PiCture eXchange
  '.ppm', '.pgm', '.pbm',                     // Netpbm
  '.jp2', '.jpx',                             // JPEG 2000 (Safari only)
  '.jxl',                                     // JPEG XL (shipped disabled)
  '.cr2', '.crw', '.nef', '.arw', '.raw',     // RAW
  '.orf', '.raf', '.dng',
]);

/**
 * Can this browser turn the file into pixels?
 *
 * False only for formats NO mainstream browser decodes, where the download is
 * guaranteed to be wasted. Everything else returns true and we simply try —
 * including the genuinely ambiguous ones (TIFF, HEIC, AVIF), which Safari
 * decodes and others do not.
 *
 * An earlier version tried to probe those three at runtime. It was unsound:
 * the check leaned on ImageDecoder.isTypeSupported, which is absent in Safari —
 * the very browser that CAN decode TIFF and HEIC — so Safari users would have
 * had those files skipped and lost real matches. Guessing wrong in that
 * direction costs more than one failed decode, and computeHashForFileWithRetry
 * no longer retries a decode failure, so the cost of trying is a single
 * download rather than three.
 */
export function canBrowserDecode(file) {
  return !UNDECODABLE_EXTENSIONS.has(getFileExtension(file?.name));
}

export function getFileExtension(name) {
  if (!name || typeof name !== 'string') return '';
  const clean = name.toLowerCase().split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot) : '';
}

export function isImageFileName(name) {
  return SUPPORTED_IMAGE_EXTENSIONS.has(getFileExtension(name));
}

// MIME types Drive hands back that carry no format information on their own.
// Drive reports many PSD/TGA/IFF/PCX uploads this way, which is why
// application/octet-stream is in SUPPORTED_IMAGE_MIMES at all -- but it is also
// what Drive reports for .zip, .exe, .dmg and every other binary. For these the
// MIME type alone must NOT be sufficient; the filename has to corroborate it.
const AMBIGUOUS_MIMES = new Set(['application/octet-stream']);

export function isSupportedImageFile(file) {
  if (!file) return false;
  const mime = typeof file.mimeType === 'string' ? file.mimeType.toLowerCase() : '';

  // Folders are never scan candidates, whatever else matches.
  if (mime === 'application/vnd.google-apps.folder') return false;

  // For an ambiguous MIME the extension is the only real evidence, so require it.
  // This was previously an OR, so octet-stream passed on the MIME alone and every
  // archive and installer in the user's Drive was downloaded in full before
  // failing to decode.
  if (AMBIGUOUS_MIMES.has(mime)) return isImageFileName(file.name);

  return isImageMime(mime) || isImageFileName(file.name);
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
