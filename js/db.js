/*
 * Drive Dupe Destroyer (DDD) — db.js
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
// Security: all persistence via IndexedDB only — no localStorage for sensitive data (Refactored)
// IndexedDB operations with optimized batching and cursor handling

import { toIso, chunk } from "./util.js";

const DB_NAME = "drive_dupe_destroyer_db_v1";  // Namespaced: distinct from Drive Dupe Decimator
const DB_VERSION = 2;  // v2: dedicated "rejections" store (was a single settings blob)

// How long to wait for a blocking tab to close before giving up rather than
// hanging. Long enough for someone who reads the message and acts on it.
const BLOCKED_GRACE_MS = 10000;

let dbp = null;
let dbReady = false;

// ============================================================================
// Database Utilities
// ============================================================================

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('Transaction aborted'));
  });
}

/**
 * Open database with migration support
 */
function openDb() {
  if (dbp) return dbp;
  
  dbp = new Promise((resolve, reject) => {
    let blockedTimer = null;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      
      console.log(`[DB] Upgrading from v${oldVersion} to v${DB_VERSION}`);
      
      // Images store with optimized indices
      if (!db.objectStoreNames.contains("images")) {
        const imgStore = db.createObjectStore("images", { keyPath: "id" });
        imgStore.createIndex("md5", "md5", { unique: false });
        imgStore.createIndex("ts", "ts", { unique: false });
        imgStore.createIndex("size", "size", { unique: false });
        // Compound index for efficient queries
        imgStore.createIndex("md5_size", ["md5", "size"], { unique: false });
      }
      
      // Scan state store
      if (!db.objectStoreNames.contains("scanState")) {
        db.createObjectStore("scanState", { keyPath: "key" });
      }
      
      // Trash queue store
      if (!db.objectStoreNames.contains("trashQueue")) {
        db.createObjectStore("trashQueue", { keyPath: "id" });
      }
      
      // Path cache store with timestamp index for cleanup
      if (!db.objectStoreNames.contains("pathCache")) {
        const pcStore = db.createObjectStore("pathCache", { keyPath: "id" });
        pcStore.createIndex("ts", "ts", { unique: false });
      }
      
      // Settings store
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      
      // Hash lookup store for fast MD5-based duplicate detection
      if (!db.objectStoreNames.contains("hashLookup")) {
        const hashStore = db.createObjectStore("hashLookup", { keyPath: "hash" });
        hashStore.createIndex("count", "count", { unique: false });
      }

      // Rejected pairs, one row each.
      //
      // These lived in a single settings value, so every rejection serialized
      // and rewrote the whole collection — up to ~1 MB at the 10,000 cap, on
      // the hot path of pressing "4" repeatedly in the compare modal. One row
      // per pair makes a rejection a single small put, and trimming a cursor
      // delete rather than a rebuild.
      if (!db.objectStoreNames.contains("rejections")) {
        const rejStore = db.createObjectStore("rejections", { keyPath: "key" });
        rejStore.createIndex("ts", "ts", { unique: false });
      }
    };
    
    // A second tab holding the old version blocks the upgrade indefinitely.
    //
    // onblocked settles nothing by itself, and neither onsuccess nor onerror
    // ever fires while the other connection stays open -- so this promise used
    // to stay pending forever. Every database call begins `await openDb()`, so
    // that did not degrade the app, it stopped it: the scan froze mid-phase with
    // no error and nothing shown to the user. Measured as STILL PENDING after
    // three seconds, resolving the instant the holding connection closed.
    //
    // So: say something actionable, and give up rather than hang. A scan
    // without the hash cache is slow but correct; a frozen one is neither.
    req.onblocked = () => {
      console.warn("[DB] Upgrade blocked — another tab has this database open at an older version.");
      notifyDbBlocked();
      clearTimeout(blockedTimer);
      blockedTimer = setTimeout(() => {
        if (dbReady) return;              // it got through after all
        reject(new Error(
          "Another tab has Drive Dupe Destroyer open and is preventing a database " +
          "update. Close the other tabs and reload."
        ));
      }, BLOCKED_GRACE_MS);
    };

    req.onsuccess = () => {
      clearTimeout(blockedTimer);
      dbReady = true;
      const db = req.result;
      // Let a newer tab upgrade instead of deadlocking against our open handle.
      db.onversionchange = () => {
        console.warn("[DB] Another tab requested a database upgrade; closing this connection.");
        try { db.close(); } catch {}
        dbp = null;
        dbReady = false;
      };
      resolve(db);
    };
    
    req.onerror = () => {
      clearTimeout(blockedTimer);
      console.error("[DB] Failed to open:", req.error);
      reject(req.error);
    };
  });
  
  // A rejected open must not be cached: the user can close the other tab and
  // retry, and a stuck rejected promise would deny them that.
  dbp.catch(() => { dbp = null; dbReady = false; });

  return dbp;
}

/**
 * Get object store with mode
 */
async function getStore(storeName, mode = "readonly") {
  const db = await openDb();
  return db.transaction(storeName, mode).objectStore(storeName);
}

/**
 * Get multiple stores in a single transaction (more efficient)
 */
async function getStores(storeNames, mode = "readonly") {
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  return storeNames.map(name => tx.objectStore(name));
}

// ============================================================================
// Storage Durability & Quota
// ============================================================================

/**
 * Ask the browser to keep this origin's storage.
 *
 * Without it, IndexedDB is "best effort": the browser may evict the entire
 * database under storage pressure, taking the hash cache AND the user's
 * accumulated rejected-pairs list with it, silently. Chrome grants this without
 * a prompt for sites the user has engaged with; elsewhere it may be declined,
 * which is fine — it is an improvement, not a requirement.
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    const granted = await navigator.storage.persist();
    console.log(`[DB] Persistent storage ${granted ? "granted" : "not granted"}`);
    return granted;
  } catch {
    return false;
  }
}

/** Bytes used / available, or null when the browser will not say. */
export async function getStorageEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, pctUsed: quota > 0 ? (usage / quota) * 100 : 0 };
  } catch {
    return null;
  }
}

/** True for the various shapes a quota failure arrives in. */
export function isQuotaError(e) {
  return (
    e?.name === "QuotaExceededError" ||
    e?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e?.code === 22 ||
    /quota/i.test(e?.message || "")
  );
}

// Report a full cache once per session, not once per failed batch.
let _quotaWarned = false;

// Set by the UI so a blocked upgrade can say something the user can act on.
// Mirrors the quota notifier below; db.js stays free of any UI import.
let _dbBlockedNotify = null;
let _dbBlockedWarned = false;

export function setDbBlockedNotifier(fn) {
  _dbBlockedNotify = typeof fn === "function" ? fn : null;
}

function notifyDbBlocked() {
  if (_dbBlockedWarned) return;
  _dbBlockedWarned = true;
  if (_dbBlockedNotify) {
    _dbBlockedNotify(
      "Another tab has Drive Dupe Destroyer open and is preventing a database " +
      "update. Close the other tabs and reload this page."
    );
  }
}

export function onQuotaExceeded(notify) {
  if (_quotaWarned) return;
  _quotaWarned = true;
  console.warn("[DB] Storage quota exceeded — the hash cache has stopped growing.");
  if (typeof notify === "function") {
    notify(
      "Browser storage is full, so new hashes are no longer being cached. " +
      "Clear the cache in the sidebar to keep caching."
    );
  }
}

// ============================================================================
// Images Store - Optimized
// ============================================================================

export async function dbPutImage(rec) {
  const store = await getStore("images", "readwrite");
  return promisifyRequest(store.put({ ...rec, ts: toIso() }));
}

export async function dbGetImage(id) {
  const store = await getStore("images");
  return promisifyRequest(store.get(id)) || null;
}

export async function dbDelImage(id) {
  const store = await getStore("images", "readwrite");
  return promisifyRequest(store.delete(id));
}

export async function dbClearImages() {
  const store = await getStore("images", "readwrite");
  return promisifyRequest(store.clear());
}

export async function dbCountImages() {
  const store = await getStore("images");
  return promisifyRequest(store.count());
}

/**
 * Optimized batch read using IDBObjectStore.getAll with key filtering
 * Much faster than individual gets or cursor iteration for sparse key sets
 */
export async function dbGetImagesBatch(ids) {
  if (!ids || ids.length === 0) return new Map();
  
  const db = await openDb();
  const results = new Map();
  
  // For very small batches, individual gets are faster
  if (ids.length < 20) {
    const tx = db.transaction("images", "readonly");
    const store = tx.objectStore("images");
    
    const promises = ids.map(id =>
      promisifyRequest(store.get(id)).then(rec => {
        if (rec) results.set(id, rec);
      }).catch(() => {})
    );
    
    await Promise.all(promises);
    return results;
  }
  
  // For larger batches, sort IDs and use cursor with key range
  const idSet = new Set(ids);
  const sortedIds = [...ids].sort();
  const minId = sortedIds[0];
  const maxId = sortedIds[sortedIds.length - 1];
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction("images", "readonly");
    const store = tx.objectStore("images");
    
    // Use bounded cursor for efficiency
    const range = IDBKeyRange.bound(minId, maxId);
    const cursor = store.openCursor(range);
    
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) {
        resolve(results);
        return;
      }
      
      if (idSet.has(c.key)) {
        results.set(c.key, c.value);
        idSet.delete(c.key);  // Remove found key for early exit check
      }
      
      // Early exit if all IDs found
      if (idSet.size === 0) {
        resolve(results);
        return;
      }
      
      c.continue();
    };
    
    cursor.onerror = () => reject(cursor.error);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Optimized batch write using single transaction
 */
export async function dbPutImagesBatch(records) {
  if (!records || records.length === 0) return;

  const db = await openDb();
  const tx = db.transaction("images", "readwrite");
  const store = tx.objectStore("images");
  const ts = toIso();

  // Use put without waiting for each one
  for (const rec of records) {
    store.put({ ...rec, ts });
  }

  try {
    return await promisifyTransaction(tx);
  } catch (e) {
    // A quota failure used to be swallowed by the caller's .catch(console.warn),
    // so the cache silently stopped working and the user only saw that repeat
    // scans were as slow as the first. Re-thrown with a flag so scan.js can tell
    // "storage is full" apart from a transient write error.
    if (isQuotaError(e)) throw Object.assign(e, { code: "QUOTA" });
    throw e;
  }
}

/**
 * Find images by MD5 hash (for exact duplicate detection)
 */
export async function dbGetImagesByMd5(md5) {
  if (!md5) return [];
  
  const store = await getStore("images");
  const index = store.index("md5");
  const results = [];
  
  return new Promise((resolve, reject) => {
    const cursor = index.openCursor(IDBKeyRange.only(md5));
    
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) {
        resolve(results);
        return;
      }
      results.push(c.value);
      c.continue();
    };
    
    cursor.onerror = () => reject(cursor.error);
  });
}

/**
 * Export all images with streaming progress
 */
export async function dbExportImages(onProgress = null) {
  const store = await getStore("images");
  
  return new Promise((resolve, reject) => {
    const out = [];
    let count = 0;
    
    const cursor = store.openCursor();
    
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) {
        if (onProgress) onProgress(count, count, true);
        resolve(out);
        return;
      }
      
      out.push(c.value);
      count++;
      
      // Report progress every 1000 records
      if (onProgress && count % 1000 === 0) {
        onProgress(count, -1, false);
      }
      
      c.continue();
    };
    
    cursor.onerror = () => reject(cursor.error);
  });
}

/**
 * Import images with batched writes for better performance
 */
export async function dbImportImages(records, onProgress = null) {
  if (!records || records.length === 0) return;
  
  const BATCH_SIZE = 500;
  const total = records.length;
  let imported = 0;
  
  // Process in batches
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await dbPutImagesBatch(batch);
    imported += batch.length;
    
    if (onProgress) {
      onProgress(imported, total);
    }
    
    // Yield to UI periodically
    if (i % (BATCH_SIZE * 5) === 0 && i > 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

/**
 * Cleanup old cache entries (older than specified days)
 */
export async function dbCleanupOldEntries(maxAgeDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffIso = cutoff.toISOString();
  
  const db = await openDb();
  const tx = db.transaction("images", "readwrite");
  const store = tx.objectStore("images");
  const index = store.index("ts");
  
  let deleted = 0;
  
  return new Promise((resolve, reject) => {
    const cursor = index.openCursor(IDBKeyRange.upperBound(cutoffIso));
    
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) {
        console.log(`[DB] Cleaned up ${deleted} old entries`);
        resolve(deleted);
        return;
      }
      
      c.delete();
      deleted++;
      c.continue();
    };
    
    cursor.onerror = () => reject(cursor.error);
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================================
// Scan State Store
// ============================================================================

export async function stateSet(key, value) {
  const store = await getStore("scanState", "readwrite");
  return promisifyRequest(store.put({ key, value }));
}

export async function stateGet(key) {
  const store = await getStore("scanState");
  const result = await promisifyRequest(store.get(key));
  return result?.value ?? null;
}

export async function stateDel(key) {
  const store = await getStore("scanState", "readwrite");
  return promisifyRequest(store.delete(key));
}

// ============================================================================
// Trash Queue Store
// ============================================================================

export async function queueList() {
  const store = await getStore("trashQueue");
  return new Promise((resolve, reject) => {
    const out = [];
    const cursor = store.openCursor();
    
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) {
        resolve(out);
        return;
      }
      out.push(c.value);
      c.continue();
    };
    
    cursor.onerror = () => reject(cursor.error);
  });
}

export async function queueAdd(item) {
  const store = await getStore("trashQueue", "readwrite");
  return promisifyRequest(store.put({ ...item, ts: toIso() }));
}

export async function queueDel(id) {
  const store = await getStore("trashQueue", "readwrite");
  return promisifyRequest(store.delete(id));
}

export async function queueClear() {
  const store = await getStore("trashQueue", "readwrite");
  return promisifyRequest(store.clear());
}

export async function queueAddBatch(items) {
  if (!items || items.length === 0) return;
  
  const db = await openDb();
  const tx = db.transaction("trashQueue", "readwrite");
  const store = tx.objectStore("trashQueue");
  const ts = toIso();
  
  for (const item of items) {
    store.put({ ...item, ts });
  }
  
  return promisifyTransaction(tx);
}

// ============================================================================
// Path Cache Store
// ============================================================================

export async function pathCacheGet(id) {
  try {
    const store = await getStore("pathCache");
    const result = await promisifyRequest(store.get(id));
    return result?.path ?? null;
  } catch {
    return null;
  }
}

export async function pathCacheSet(id, path) {
  try {
    const store = await getStore("pathCache", "readwrite");
    return promisifyRequest(store.put({ id, path, ts: toIso() }));
  } catch {}
}

export async function pathCacheGetBatch(ids) {
  if (!ids || ids.length === 0) return new Map();
  
  const db = await openDb();
  const tx = db.transaction("pathCache", "readonly");
  const store = tx.objectStore("pathCache");
  const results = new Map();
  
  const promises = ids.map(id =>
    promisifyRequest(store.get(id)).then(rec => {
      if (rec?.path) results.set(id, rec.path);
    }).catch(() => {})
  );
  
  await Promise.all(promises);
  return results;
}

export async function pathCacheSetBatch(entries) {
  if (!entries || entries.length === 0) return;
  
  const db = await openDb();
  const tx = db.transaction("pathCache", "readwrite");
  const store = tx.objectStore("pathCache");
  const ts = toIso();
  
  for (const { id, path } of entries) {
    store.put({ id, path, ts });
  }
  
  return promisifyTransaction(tx);
}

export async function pathCacheClear() {
  try {
    const store = await getStore("pathCache", "readwrite");
    return promisifyRequest(store.clear());
  } catch {}
}

// ============================================================================
// Settings Store
// ============================================================================

export async function settingGet(key, defaultValue = null) {
  try {
    const store = await getStore("settings");
    const result = await promisifyRequest(store.get(key));
    return result?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

export async function settingSet(key, value) {
  const store = await getStore("settings", "readwrite");
  return promisifyRequest(store.put({ key, value }));
}

export async function settingDel(key) {
  const store = await getStore("settings", "readwrite");
  return promisifyRequest(store.delete(key));
}

// ============================================================================
// Folder Scan History
// ============================================================================

const SCAN_HISTORY_KEY = "folderScanHistory";

export async function getFolderScanHistory() {
  return (await settingGet(SCAN_HISTORY_KEY, {})) || {};
}

export async function recordFolderScan(folderId, folderName) {
  const history = await getFolderScanHistory();
  history[folderId] = {
    name: folderName,
    lastScanned: new Date().toISOString()
  };
  await settingSet(SCAN_HISTORY_KEY, history);
}

export async function recordFoldersScan(folders) {
  const history = await getFolderScanHistory();
  const now = new Date().toISOString();
  
  for (const f of folders) {
    history[f.id] = {
      name: f.name,
      lastScanned: now
    };
  }
  
  await settingSet(SCAN_HISTORY_KEY, history);
}

// ============================================================================
// Database Utilities
// ============================================================================

/**
 * Get database statistics
 */
export async function getDbStats() {
  const [imageCount, queueCount, pathCount] = await Promise.all([
    dbCountImages(),
    queueList().then(q => q.length),
    getStore("pathCache").then(s => promisifyRequest(s.count()))
  ]);
  
  return {
    images: imageCount,
    queue: queueCount,
    paths: pathCount,
    dbName: DB_NAME,
    dbVersion: DB_VERSION
  };
}

/**
 * Check if database is ready
 */
export function isDbReady() {
  return dbReady;
}

/**
 * Force database reconnection
 */
export async function reconnectDb() {
  dbp = null;
  dbReady = false;
  return openDb();
}

// ============================================================================
// Drive Changes API token storage (Feature #13 - incremental scan)
// ============================================================================

export async function getChangesToken() {
  return settingGet("destroyer_drive_changes_token", null);
}

export async function setChangesToken(token) {
  await settingSet("destroyer_drive_changes_token", token);
}

export async function clearChangesToken() {
  await settingDel("destroyer_drive_changes_token");
}

// ============================================================================
// Rejected Pairs Store
// ============================================================================

/** All rejection keys, for the in-memory set rejection.js keeps. */
export async function rejectionsAll() {
  const store = await getStore("rejections");
  const rows = await promisifyRequest(store.getAll());
  return (rows || []).map(r => r.key);
}

/** Record one rejected pair. A single small put, not a whole-collection rewrite. */
export async function rejectionAdd(key) {
  const store = await getStore("rejections", "readwrite");
  return promisifyRequest(store.put({ key, ts: Date.now() }));
}

export async function rejectionCount() {
  const store = await getStore("rejections");
  return promisifyRequest(store.count());
}

export async function rejectionsClear() {
  const store = await getStore("rejections", "readwrite");
  return promisifyRequest(store.clear());
}

/** Drop the oldest entries once the cap is exceeded. */
export async function rejectionsTrim(maxEntries) {
  const count = await rejectionCount();
  const excess = count - maxEntries;
  if (excess <= 0) return 0;

  const store = await getStore("rejections", "readwrite");
  const index = store.index("ts");
  let removed = 0;

  return new Promise((resolve, reject) => {
    const req = index.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || removed >= excess) return resolve(removed);
      cursor.delete();
      removed++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * One-time migration of the old single-blob rejection list into its own store.
 * Returns the number of entries migrated.
 */
export async function migrateRejectionsFromSettings(settingsKey) {
  const legacy = await settingGet(settingsKey, null).catch(() => null);
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;

  const db = await openDb();
  const tx = db.transaction("rejections", "readwrite");
  const store = tx.objectStore("rejections");
  const ts = Date.now();
  for (const key of legacy) store.put({ key, ts });
  await promisifyTransaction(tx);

  await settingSet(settingsKey, []).catch(() => {});
  console.log(`[DB] Migrated ${legacy.length} rejected pair(s) into the rejections store`);
  return legacy.length;
}
