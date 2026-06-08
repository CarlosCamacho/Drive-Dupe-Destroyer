/*
 * Drive Dupe Destroyer (DDD) v14.0 — paths.js
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

async function getMeta(id, fields, { signal = null } = {}) {
  const key = id + "|" + fields;
  
  if (metaCache.has(key)) return metaCache.get(key);
  
  const promise = getFileMeta(id, fields, { signal });
  metaCache.set(key, promise);
  
  return promise;
}

export async function getPathForItem(file, { signal = null } = {}) {
  if (pathCache.has(file.id)) return pathCache.get(file.id);
  
  const cached = await pathCacheGet(file.id);
  if (cached) {
    pathCache.set(file.id, cached);
    return cached;
  }
  
  const parts = [];
  let cur = file;
  let loops = 0;
  
  while (cur?.parents?.[0] && loops++ < CONFIG.MAX_PATH_DEPTH) {
    if (signal?.aborted) throw new Error("Scan stopped.");
    
    const pid = cur.parents[0];
    
    try {
      const meta = await getMeta(pid, "id,name,parents,mimeType", { signal });
      parts.unshift(meta.name || "");
      cur = meta;
    } catch (e) {
      console.warn(`Could not get parent ${pid}:`, e.message);
      break;
    }
  }
  
  const path = "/" + parts.join("/");
  
  pathCache.set(file.id, path);
  await pathCacheSet(file.id, path).catch(() => {});
  
  return path;
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
