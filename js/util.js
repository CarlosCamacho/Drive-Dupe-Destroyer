/*
 * Drive Dupe Destroyer (DDD) — util.js
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
// Centralized utilities and constants

// The single source of truth for the app version.
// Everything that displays or reports a version reads it from here:
//   - ui.js       -> the header badge and document.title
//   - exporter.js -> the `version` field in JSON exports
//   - app.js      -> the boot log, and the service-worker version check
// sw.js cannot import ES modules, so it carries its own SW_VERSION literal;
// app.js compares the two at boot and warns on a mismatch (a stale cache).
// serve_secure.py parses this line at startup, so keep the format as-is.
export const APP_VERSION = "14.7.7";

// Configuration constants
export const CONFIG = {
  // HASH_CONCURRENCY moved to hashing.js, where it is derived from the worker
  // pool size rather than guessed independently of it (#66).
  PATH_CONCURRENCY: 10,
  RENDER_BATCH_SIZE: 100,
  AUTH_TIMEOUT_MS: 60000,
  TOKEN_REFRESH_INTERVAL_MS: 45 * 60 * 1000, // 45 minutes
  DEBOUNCE_MS: 150,
  INTERSECTION_MARGIN: '200px',
  MAX_PATH_DEPTH: 50,
};

// Help text for UI elements
export const HELP_TEXT = {
  recursiveMode: "When enabled, scans all subfolders within selected folders. Disable to scan only the top level.",
  maxItems: "Maximum images to scan per session. Recommended: 15,000 or less for best performance. Use ∞ for unlimited (not recommended for very large libraries).",
  pageSize: "Number of files to fetch per API request. Higher values are faster but may timeout on slow connections. Default 500 works well for most cases.",
  imgMinSize: "Ignore images smaller than this size. Useful to skip tiny thumbnails or icons.",
  imgMaxSize: "Ignore images larger than this size. Useful to skip huge raw files.",
  sensitivityLevel: "Controls how similar images must be to match. 1 = Loose (catches more duplicates, may include false positives). 5 = Strict (only near-identical images).",
  hamThresh: "Hamming distance threshold for perceptual hashing. Lower = stricter matching. 0-2 = nearly identical, 3-5 = very similar, 6-10 = somewhat similar. Default: 2.",
  useDb: "Cache computed hashes in your browser. Dramatically speeds up subsequent scans of the same images.",
  keepRule: "Automatically marks which file to keep in each duplicate group. Options: highest resolution, newest, oldest, smallest, largest, or by folder priority.",
  checkVariants: "Also check for rotated or flipped versions of images. Slower but catches more duplicates.",
  cropDetect: "Detect images that are crops of each other. Hashes multiple sub-regions (center, quadrants) so a cropped version matches the original. Slower but catches cropped duplicates.",
  colorMatch: "Compare color distribution AND edge/texture structure between images. Uses Sobel edge detection to build directional texture histograms, preventing false positives on images that share colors but have different content. Best combined with crop detection.",
  // #63: these six controls had no HELP_TEXT entry, so no popover was ever
  // created for them -- and useDeltaScan already carried a data-help attribute
  // pointing at a key that did not exist, which the wiring silently skips.
  rotationVariants: "Also compare each image rotated 90°, 180° and 270°. Finds duplicates that were re-saved sideways, at the cost of four times the hashing work per image.",
  pHashMode: "Use a DCT-based perceptual hash alongside the difference hash. More tolerant of brightness, contrast and compression changes, and slower. Worth enabling when near-identical edits are being missed.",
  aspectFilter: "Skip comparing two images whose width-to-height ratios differ by more than the tolerance below. A free metadata check that avoids most pointless comparisons — leave it on unless you are looking for heavily cropped versions.",
  aspectTolerance: "How far two aspect ratios may differ and still be compared, as a percentage. Higher values catch more crops and cost more time. Ignored when the aspect ratio pre-filter is off.",
  lshMode: "How aggressively candidate pairs are shortlisted before the expensive comparison. Auto picks from your library size. Loose finds more matches and takes longer; strict is faster and may miss borderline pairs.",
  useDeltaScan: "After scanning the selected folders, also ask Drive what has changed since last time, so files added or removed elsewhere are reconciled. This runs in addition to the folder scan — it does not make the scan shorter.",
  folderPriority: "Comma-separated folder name patterns. Files in folders matching earlier patterns are preferred as keepers.",
  exportResults: "Download the duplicate groups found in this scan as a JSON file. Useful for record-keeping or processing elsewhere.",
  queue: "Files added to the queue will be moved to trash when you process the queue. Use this for bulk deletions across multiple groups.",
  cacheExport: "Save your cached hashes to a file. Useful for backup or transferring to another browser/computer.",
  cacheImport: "Load previously exported hashes. Avoids re-downloading and re-hashing images you've already scanned.",
  cacheClear: "Delete all cached hashes from your browser. You'll need to re-download thumbnails on the next scan.",
};

/**
 * Safe element getter with optional warning
 */
// Inline SVG placeholder shown for images that haven't loaded yet (e.g. during a
// live scan before thumbnails exist) and for any image that fails to load. Kept
// as a data URI so it needs no network request and never itself 404s. The SVG
// is percent-encoded (via encodeURIComponent) so the data URI is valid in strict
// parsers, not just lenient browsers.
const _PLACEHOLDER_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44' viewBox='0 0 44 44'>" +
  "<rect width='44' height='44' rx='6' fill='#2a2f3a'/>" +
  "<rect x='7' y='9' width='30' height='26' rx='3' fill='none' stroke='#5b6472' stroke-width='2'/>" +
  "<circle cx='16' cy='17' r='3' fill='#5b6472'/>" +
  "<path d='M10 31l8-9 5 5 6-7 5 11z' fill='#5b6472'/>" +
  "</svg>";
export const IMAGE_PLACEHOLDER =
  "data:image/svg+xml," + encodeURIComponent(_PLACEHOLDER_SVG);

export function el(id, warn = false) {
  const element = document.getElementById(id);
  if (!element && warn) {
    console.warn(`Element not found: #${id}`);
  }
  return element;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function bytesToHuman(n) {
  const x = Number(n);
  // Distinguish "no size information" from "genuinely empty". Collapsing both to
  // an em dash made a 0-byte file indistinguishable from one whose size Drive
  // did not report, which matters when deciding whether a file is worth keeping.
  if (!isFinite(x) || x < 0) return "—";
  if (x === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = x;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { 
    year: "numeric", 
    month: "short", 
    day: "2-digit", 
    hour: "2-digit", 
    minute: "2-digit" 
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

// True when any modal is on screen. Every modal in index.html carries
// class="modal" and is shown by setting display:flex, so one query covers all
// seven -- About, auth, folder picker, compare, crop, error and queue.
//
// This exists because Escape had two owners: each modal closed itself, and
// keyboard.js independently clicked "Select none". One keypress therefore
// dismissed a dialog AND discarded a deletion selection that has no undo.
export function anyModalOpen() {
  for (const m of document.querySelectorAll(".modal")) {
    if (m.style.display && m.style.display !== "none") return true;
    // A modal shown by a stylesheet rule rather than an inline style.
    if (!m.style.display && getComputedStyle(m).display !== "none") return true;
  }
  return false;
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function nowMs() {
  return performance.now();
}

export function toIso() {
  return new Date().toISOString();
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Concurrency limiter whose limit can change while jobs are in flight.
 *
 * `limit.setConcurrency(n)` is what lets the AIMD controller actually throttle:
 * the limit was previously captured as a constant, so nothing could reduce
 * in-flight work when Drive started returning 429s.
 *
 * Lowering the limit never cancels running jobs — it just stops new ones from
 * starting until enough have drained. Raising it immediately starts as many
 * queued jobs as the new headroom allows.
 */
export function makeLimiter(concurrency) {
  let limit_ = Math.max(1, concurrency | 0);
  let active = 0;
  const q = [];

  const runNext = () => {
    if (active >= limit_) return;
    const job = q.shift();
    if (!job) return;
    active++;
    (async () => {
      try {
        job.resolve(await job.fn());
      } catch (e) {
        job.reject(e);
      } finally {
        active--;
        runNext();
      }
    })();
  };

  function limit(fn) {
    return new Promise((resolve, reject) => {
      q.push({ fn, resolve, reject });
      runNext();
    });
  }

  limit.setConcurrency = (n) => {
    const next = Math.max(1, Math.floor(n) || 1);
    if (next === limit_) return;
    const raised = next > limit_;
    limit_ = next;
    // Fill the new headroom right away; a reduction just lets actives drain.
    if (raised) for (let i = active; i < limit_; i++) runNext();
  };

  limit.getConcurrency = () => limit_;
  limit.pending = () => q.length;
  limit.active = () => active;

  return limit;
}

export function humanDuration(ms) {
  if (!isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

export function debounce(fn, ms = CONFIG.DEBOUNCE_MS) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return function(...args) {
    const now = Date.now();
    const remaining = ms - (now - last);
    clearTimeout(timer);
    if (remaining <= 0) {
      last = now;
      fn.apply(this, args);
    } else {
      timer = setTimeout(() => {
        last = Date.now();
        fn.apply(this, args);
      }, remaining);
    }
  };
}

export function getCurrentYear() {
  return new Date().getFullYear();
}
