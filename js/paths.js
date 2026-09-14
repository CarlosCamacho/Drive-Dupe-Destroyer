/*
 * Drive Dupe Destroyer (DDD) — paths.js
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
// Path resolution with caching

import { driveFetch, getFileMeta } from "./drive.js";
import { makeLimiter, CONFIG } from "./util.js";
import { pathCacheGet, pathCacheSet, pathCacheGetBatch, pathCacheClear } from "./db.js";

const metaCache = new Map();
const pathCache = new Map();

// The PROMISE is cached, not the result, so a rejection used to be cached too --
// permanently. One 500 or one dropped connection on a folder near the top of a
// Drive meant every later file beneath it got the rejected promise back
// instantly and gave up without retrying, for the lifetime of the page. Evict
// on rejection so a retry is possible.
async function getMeta(id, fields, { signal = null } = {}) {
  const key = id + "|" + fields;
  
  if (metaCache.has(key)) return metaCache.get(key);
  
  const promise = getFileMeta(id, fields, { signal });
  metaCache.set(key, promise);
  promise.catch(() => {
    // Only evict our own entry: a later call may already have replaced it.
    if (metaCache.get(key) === promise) metaCache.delete(key);
  });
  
  return promise;
}

function isAbort(e) {
  return e?.name === "AbortError" || /abort/i.test(e?.message || "");
}

export async function getPathForItem(file, { signal = null } = {}) {
  if (pathCache.has(file.id)) return pathCache.get(file.id);
  
  const cached = await pathCacheGet(file.id);
  if (cached) {
    pathCache.set(file.id, cached);
    return cached;
  }
  
  const { path, complete } = await walkParents(
    file,
    (pid) => getMeta(pid, "id,name,parents,mimeType", { signal }),
    { maxDepth: CONFIG.MAX_PATH_DEPTH, signal }
  );

  // Return the partial path for display, but do not cache a guess -- in memory
  // or on disk -- or the next scan inherits it with no way to tell it apart
  // from a real answer.
  if (!complete) return path;

  pathCache.set(file.id, path);
  await pathCacheSet(file.id, path).catch(() => {});

  return path;
}

/**
 * Walk a file's parent chain into a "/a/b/c" folder path.
 *
 * `complete` is the whole point. The walk is only trustworthy if it ran out of
 * parents; ending on an error or on the depth cap yields a TRUNCATED path, and
 * that used to be written to the durable IndexedDB cache as though it were
 * correct -- a file in /My Drive/Photos/2019/Hawaii recorded as /Hawaii,
 * permanently, and never retried. `_path` decides folder-priority keep
 * selection in common.js and is what the CSV export reports as the file's
 * location, so a truncated path silently changes which file the app offers to
 * delete.
 *
 * `fetchMeta` is injected so this is testable without a network: it is the one
 * part of path resolution with real branching.
 *
 * An abort is NOT a path failure -- it re-throws, leaving the caller's caches
 * untouched, because pressing Stop should not persist a half-finished walk.
 */
export async function walkParents(file, fetchMeta, { maxDepth = 20, signal = null } = {}) {
  const parts = [];
  let cur = file;
  let loops = 0;
  let complete = true;

  while (cur?.parents?.[0] && loops++ < maxDepth) {
    if (signal?.aborted) throw new Error("Scan stopped.");

    const pid = cur.parents[0];

    try {
      const meta = await fetchMeta(pid);
      parts.unshift(meta?.name || "");
      cur = meta;
    } catch (e) {
      // An abort that lands DURING a request arrives here rather than at the
      // guard above.
      if (isAbort(e) || signal?.aborted) throw new Error("Scan stopped.");
      console.warn(`Could not get parent ${pid}:`, e.message);
      complete = false;
      break;
    }
  }

  // Ran out of depth with parents still to go: also truncated.
  if (complete && cur?.parents?.[0]) complete = false;

  return { path: "/" + parts.join("/"), complete };
}

export async function buildPathsParallel(files, { 
  concurrency = CONFIG.PATH_CONCURRENCY, 
  signal = null, 
  onProgress = null 
} = {}) {
  const limit = makeLimiter(concurrency);
  const map = new Map();
  let done = 0;
  
  const fileIds = files.map(f => f.id);
  const cachedPaths = await pathCacheGetBatch(fileIds).catch(() => new Map());
  
  for (const [id, path] of cachedPaths) {
    map.set(id, path);
    pathCache.set(id, path);
  }
  
  const uncachedFiles = files.filter(f => !map.has(f.id));
  
  if (uncachedFiles.length === 0) {
    if (onProgress) onProgress(files.length, files.length);
    return map;
  }
  
  done = files.length - uncachedFiles.length;
  if (onProgress && done > 0) onProgress(done, files.length);
  
  await Promise.all(uncachedFiles.map(f => limit(async () => {
    if (signal?.aborted) throw new Error("Scan stopped.");
    
    try {
      const p = await getPathForItem(f, { signal });
      map.set(f.id, p);
    } catch (e) {
      if (e.message !== "Scan stopped.") console.warn(`Path error for ${f.name}:`, e.message);
      map.set(f.id, "");
    }
    
    done++;
    if (onProgress) onProgress(done, files.length);
  })));
  
  return map;
}

export async function clearPathCaches() {
  metaCache.clear();
  pathCache.clear();
  await pathCacheClear().catch(() => {});
}

export function clearMemoryPathCaches() {
  metaCache.clear();
  pathCache.clear();
}
