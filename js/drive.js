/*
 * Drive Dupe Destroyer (DDD) — drive.js
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
// Google Drive API operations

import { authedFetch, ensureValidToken } from "./auth.js";
import { sanitizeText } from "./security.js";
import { isSupportedImageFile } from "./common.js";

export function isFolderMime(m) {
  return m === "application/vnd.google-apps.folder";
}

export function isGoogleDocMime(m) {
  return typeof m === "string" && 
         m.startsWith("application/vnd.google-apps.") && 
         !isFolderMime(m);
}

export function isImageMime(m) {
  return typeof m === "string" && m.startsWith("image/");
}

export function driveFilePreviewLink(file) {
  return file.webViewLink || 
         (file.id ? `https://drive.google.com/file/d/${file.id}/view` : null);
}

export function driveFolderLink(folderId) {
  return folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;
}

const driveConfig = {
  supportsAllDrives: false,
  includeItemsFromAllDrives: false,
  corpora: "user",
  driveId: ""
};

export function setDriveConfig(config) {
  Object.assign(driveConfig, config);
}

function driveParamsBase() {
  return {
    supportsAllDrives: driveConfig.supportsAllDrives ? "true" : "false",
    includeItemsFromAllDrives: driveConfig.includeItemsFromAllDrives ? "true" : "false",
    corpora: driveConfig.corpora,
  };
}

export async function driveFetch(path, { method = "GET", params = {}, body = null, signal = null } = {}) {
  // Path sanity check. Note this is a guard against malformed input reaching
  // the URL, not a security boundary: the caller already holds the user's own
  // token and every path here is built from IDs Drive gave us. Rejects the
  // characters that would break out of the path segment, plus traversal.
  if (typeof path !== "string" || path.length > 512 || /[<>"{}|\^`?#\s]/.test(path) || path.includes("..")) {
    throw new Error("Invalid API path");
  }
  await ensureValidToken();
  
  const url = new URL("https://www.googleapis.com/drive/v3/" + path);
  const base = driveParamsBase();
  const merged = { ...base, ...params };
  
  for (const [k, v] of Object.entries(merged)) {
    if (v !== "" && v != null && v !== undefined) {
      url.searchParams.set(k, v);
    }
  }

  const res = await authedFetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : null,
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Attach the real status rather than leaving callers to regex the message.
    // scan.js used to classify failures with e.message.includes("403") etc.,
    // which matches any 403 appearing anywhere in a Drive error body.
    throw Object.assign(
      new Error(`Drive API error ${res.status}: ${sanitizeText(text.slice(0, 200))}`),
      { status: res.status, code: "DRIVE_API" }
    );
  }

  return res.status === 204 ? null : res.json();
}

// Whether Google's thumbnail CDN will serve us a readable blob.
//
// null = not yet probed, true/false = answer for this session.
//
// lh3.googleusercontent.com sends no Access-Control-Allow-Origin, so a
// cors-mode fetch of a thumbnailLink is rejected. That is not a per-file
// condition — it either works for this origin or it never will. Previously we
// attempted it for every file and swallowed the rejection, which on a 20,000
// image scan meant 20,000 doomed requests and 20,000 CORS errors in the console
// before falling back to the full-resolution download each time.
//
// Probe once, remember the answer, and skip the attempt thereafter.
let _thumbFetchUsable = null;

export function getThumbFetchStatus() {
  return _thumbFetchUsable;
}

export async function downloadFileBlob(fileId, { altThumbUrl = null, signal = null, preferThumb = false } = {}) {
  // Hashing only needs a ~256px image, but the Drive `alt=media` endpoint always
  // returns the full-resolution original (often multiple MB). Google's thumbnail
  // URLs are far cheaper when they can be read at all — see the note on
  // _thumbFetchUsable above for why they usually cannot.
  if (preferThumb && altThumbUrl && _thumbFetchUsable !== false) {
    try {
      const tRes = await fetch(altThumbUrl, { method: "GET", signal });
      if (tRes.ok) {
        const blob = await tRes.blob();
        // Validate: must be a non-trivial image blob. Google sometimes returns a
        // tiny HTML/error body with a 200, which would not be a usable image.
        if (blob && blob.size > 512 && /^image\//.test(blob.type || "")) {
          if (_thumbFetchUsable === null) {
            _thumbFetchUsable = true;
            console.log("[Drive] Thumbnail fast-path is available.");
          }
          return blob;
        }
      }
    } catch (e) {
      // An abort is the caller cancelling, not a verdict on the CDN.
      if (signal?.aborted) throw e;
      if (_thumbFetchUsable === null) {
        _thumbFetchUsable = false;
        console.info(
          "[Drive] Thumbnail fast-path unavailable (the thumbnail CDN sends no CORS headers). " +
          "Falling back to full downloads for hashing; will not retry per file."
        );
      }
    }
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await authedFetch(url, { method: "GET", signal });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`Download failed ${res.status}: ${sanitizeText(t.slice(0, 200))}`),
      { status: res.status, code: "DRIVE_DOWNLOAD" }
    );
  }

  return await res.blob();
}

export function thumbLinkSized(thumbnailLink, w = 256) {
  if (!thumbnailLink) return null;
  try {
    const u = new URL(thumbnailLink);
    u.searchParams.set("sz", `w${w}`);
    return u.toString();
  } catch {
    return thumbnailLink;
  }
}

/**
 * Parse a Google batch multipart/mixed response body into a map of
 * Content-ID -> { status, ok }. Each part embeds a full HTTP response whose
 * first status line (e.g. "HTTP/1.1 204 No Content") gives the real per-request
 * outcome. We tagged each sub-request with "Content-ID: <fileId>" on the way
 * out, and Google echoes it back as "Content-ID: response-<fileId>".
 */
export function parseBatchResponse(text, boundaryHint) {
  const out = new Map();
  if (!text) return out;

  // The response uses its own boundary (in the Content-Type header we don't see
  // here), but every boundary line starts with "--". Split on lines that look
  // like a boundary delimiter; the batch boundary always begins with "--batch".
  // Fall back to a generic "--" boundary split if needed.
  let boundary = null;
  const bMatch = text.match(/--(batch[^\r\n]+)/);
  if (bMatch) boundary = "--" + bMatch[1];

  const parts = boundary ? text.split(boundary) : text.split(/\r\n--/);

  for (const part of parts) {
    if (!part || part === "--\r\n" || part.trim() === "--") continue;

    // Content-ID echoed by Google is angle-bracketed: "Content-ID: <response-abc123>".
    // The previous pattern required "response-" to follow the colon directly, so
    // the leading "<" made it never match. statusById then came back empty and
    // every chunk silently fell through to fallbackPatch -- one batch request
    // followed by 100 individual PATCHes. Brackets are optional here so a
    // bare "Content-ID: response-abc123" still parses, and the capture stops at
    // ">" so the closing bracket is not swallowed into the file ID.
    const idMatch = part.match(/Content-ID:\s*<?\s*response-([^>\r\n]+)>?/i);
    // The embedded HTTP status line, e.g. "HTTP/1.1 204 No Content"
    const statusMatch = part.match(/HTTP\/\d\.\d\s+(\d{3})/);

    if (idMatch && statusMatch) {
      const id = idMatch[1].trim();
      const status = parseInt(statusMatch[1], 10);
      out.set(id, { status, ok: status >= 200 && status < 300 });
    }
  }

  return out;
}

/**
 * Fetch metadata for many files in one request.
 *
 * Path resolution issued one GET per ancestor folder (#68): a deep tree became
 * a long tail of small sequential requests, since level 5 could not be asked
 * for until level 6 came back. The batch endpoint was already implemented here
 * for trashing and is not trash-specific.
 *
 * Returns a Map of id to metadata for everything that came back. Ids that
 * failed are simply absent — the caller decides whether that is fatal, which
 * matters because a failed ancestor lookup must mark a path INCOMPLETE rather
 * than silently truncate it (#46).
 *
 * Falls back to individual GETs if the batch endpoint itself errors, so this can
 * only be faster or equal, never a new failure mode.
 */
export async function batchGetFileMeta(fileIds, fields = "id,name,parents,mimeType", { signal = null } = {}) {
  const out = new Map();
  const ids = [...new Set(fileIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const individually = async (subset) => {
    await Promise.all(subset.map(async (id) => {
      try { out.set(id, await getFileMeta(id, fields, { signal })); } catch { /* caller treats absence as failure */ }
    }));
  };

  // Google caps a batch at 100 sub-requests.
  for (let i = 0; i < ids.length; i += 100) {
    if (signal?.aborted) throw new Error("Operation cancelled");
    const chunk = ids.slice(i, i + 100);
    const boundary = `batch_meta_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    let body = "";
    for (const id of chunk) {
      body += `--${boundary}\r\n`;
      body += `Content-Type: application/http\r\n`;
      body += `Content-ID: ${id}\r\n`;
      body += `Content-Transfer-Encoding: binary\r\n\r\n`;
      body += `GET /drive/v3/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)} HTTP/1.1\r\n\r\n`;
    }
    body += `--${boundary}--`;

    try {
      const res = await authedFetch("https://www.googleapis.com/batch/drive/v3", {
        method: "POST",
        headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
        body,
        signal
      });
      if (!res.ok) { await individually(chunk); continue; }

      const parsed = parseBatchBodies(await res.text().catch(() => ""));
      const missing = [];
      for (const id of chunk) {
        const meta = parsed.get(id);
        if (meta) out.set(id, meta); else missing.push(id);
      }
      if (missing.length) await individually(missing);
    } catch (e) {
      if (signal?.aborted || /abort/i.test(e?.message || "")) throw e;
      await individually(chunk);
    }
  }

  return out;
}

/**
 * Parse the JSON bodies out of a multipart batch response.
 *
 * parseBatchResponse returns statuses only, which is all batchTrash needs. A
 * batched GET needs the payload, so this is a separate reader rather than a
 * change to a function the delete path depends on.
 */
export function parseBatchBodies(text) {
  const out = new Map();
  if (!text) return out;

  const bMatch = text.match(/--(batch[^\r\n]+)/);
  const parts = bMatch ? text.split("--" + bMatch[1]) : text.split(/\r\n--/);

  for (const part of parts) {
    if (!part || part.trim() === "--") continue;
    const idMatch = part.match(/Content-ID:\s*<?\s*response-([^>\r\n]+)>?/i);
    const statusMatch = part.match(/HTTP\/\d\.\d\s+(\d{3})/);
    if (!idMatch || !statusMatch) continue;
    if (parseInt(statusMatch[1], 10) >= 300) continue;

    // The JSON body is whatever follows the blank line after the sub-response
    // headers. Take from the first "{" so a stray header ordering cannot throw
    // the offset out.
    const brace = part.indexOf("{", part.indexOf(statusMatch[0]));
    if (brace < 0) continue;
    const end = part.lastIndexOf("}");
    if (end <= brace) continue;
    try {
      out.set(idMatch[1].trim(), JSON.parse(part.slice(brace, end + 1)));
    } catch { /* a body we cannot read is the same as one we did not get */ }
  }
  return out;
}

/**
 * Errors that mean every remaining request would fail the same way: the user
 * cancelled, or the session is gone. Retrying each id individually into one of
 * these buys nothing and costs a round trip -- plus, for an auth failure, a
 * fresh doomed GIS attempt -- per file (#81).
 */
export function isTerminalTrashError(e) {
  return e?.code === "AUTH" || e?.code === "AUTH_TIMEOUT" ||
         e?.name === "AbortError" || e?.message === "Operation cancelled";
}

/**
 * Whether a failed trash/restore PATCH means the file is already in the state we
 * wanted -- i.e. gone. Read the status driveFetch attaches; do NOT match the
 * message, which embeds 200 characters of Drive's error body. A 403 naming a
 * file whose ID happens to contain "404" would otherwise be reported as a
 * success, removing it from the queue while it is still in Drive (#81). The
 * same pattern was removed from scan.js for the same reason.
 */
export function isAlreadyGoneError(e) {
  return e?.status === 404;
}

export async function batchTrash(fileIds, { signal = null } = {}) {
  const results = { success: [], failed: [] };

  // Files this run has ALREADY moved to the trash must survive the error that
  // stops it. They used to be thrown away with `results`, so processQueue's
  // catch skipped the undo record, the queue cleanup and the ddd:trashed event
  // for deletions that had really happened -- the queue claimed 250 files were
  // still there while 100 of them sat in Drive's trash, unrecoverable by Undo
  // because nothing had recorded them (#81).
  const stop = (e) => Object.assign(e, { partial: results, stoppedRun: true });

  // Per-file fallback: PATCH each id individually. Used when the batch endpoint
  // errors out entirely, or for ids the batch response didn't account for.
  const fallbackPatch = async (ids) => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (signal?.aborted) {
        for (const rest of ids.slice(i)) results.failed.push(rest);
        throw stop(new Error("Operation cancelled"));
      }
      try {
        await driveFetch(`files/${id}`, { method: "PATCH", body: { trashed: true }, signal });
        results.success.push(id);
      } catch (e) {
        if (isTerminalTrashError(e)) {
          // Nothing from here on was attempted. Say so, and stop.
          for (const rest of ids.slice(i)) results.failed.push(rest);
          throw stop(e);
        }
        // A 404 means the file is already gone — the goal (not present) is met.
        if (isAlreadyGoneError(e)) results.success.push(id);
        else results.failed.push(id);
      }
    }
  };

  const chunks = [];
  for (let i = 0; i < fileIds.length; i += 100) {
    chunks.push(fileIds.slice(i, i + 100));
  }

  for (const ids of chunks) {
    if (signal?.aborted) throw stop(new Error("Operation cancelled"));

    // Ensure token valid before batch. This sits outside the try on purpose --
    // a dead session is not something a per-file retry can fix -- but it must
    // still hand back what earlier chunks accomplished.
    try {
      await ensureValidToken();
    } catch (e) {
      throw stop(e);
    }

    const boundary = "batch_" + Math.random().toString(16).slice(2);
    let body = "";

    ids.forEach((id) => {
      body += `--${boundary}\r\n`;
      body += `Content-Type: application/http\r\n`;
      // Tag each sub-request so we can map its response back by file id,
      // regardless of the order Google returns the parts in.
      body += `Content-ID: ${id}\r\n`;
      body += `Content-Transfer-Encoding: binary\r\n\r\n`;
      body += `PATCH /drive/v3/files/${id} HTTP/1.1\r\n`;
      body += `Content-Type: application/json; charset=UTF-8\r\n\r\n`;
      body += JSON.stringify({ trashed: true }) + "\r\n\r\n";
    });
    body += `--${boundary}--`;

    try {
      const res = await authedFetch("https://www.googleapis.com/batch/drive/v3", {
        method: "POST",
        headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
        body,
        signal
      });

      if (!res.ok) {
        // Whole batch endpoint failed — fall back to individual PATCHes.
        await fallbackPatch(ids);
        continue;
      }

      // Parse the multipart body to learn each sub-request's real outcome.
      // Previously a 200 on the batch was assumed to mean every file was
      // trashed, so individual failures (404/403/etc.) were silently reported
      // as successes and removed from the UI while still in Drive.
      const text = await res.text().catch(() => "");
      const statusById = parseBatchResponse(text, boundary);

      const unaccounted = [];
      for (const id of ids) {
        const r = statusById.get(id);
        if (!r) {
          unaccounted.push(id);          // couldn't match a part — verify individually
        } else if (r.ok || r.status === 404) {
          results.success.push(id);      // 404 = already gone, goal met
        } else {
          results.failed.push(id);       // real failure (403, 5xx, etc.)
        }
      }

      // If parsing matched nothing at all (unexpected response shape), don't
      // blindly trust it — verify the whole chunk individually instead.
      if (statusById.size === 0) {
        await fallbackPatch(ids);
      } else if (unaccounted.length > 0) {
        await fallbackPatch(unaccounted);
      }
    } catch (e) {
      // fallbackPatch already accounted for every id in this chunk before it
      // threw; re-entering it here would retry them.
      if (e?.stoppedRun) throw e;
      if (signal?.aborted || e.message === "Operation cancelled") throw stop(e);
      await fallbackPatch(ids);
    }
  }

  return results;
}

export async function getFileMeta(fileId, fields = "id,name,parents,mimeType", { signal = null } = {}) {
  return driveFetch(`files/${fileId}`, { params: { fields }, signal });
}

/**
 * Upload a file to Google Drive
 * @param {Blob} blob - File content
 * @param {string} name - File name
 * @param {string} parentId - Parent folder ID
 * @param {string} mimeType - File MIME type
 * @returns {Object} Uploaded file metadata
 */
export async function uploadFile(blob, name, parentId, mimeType = "image/jpeg") {
  await ensureValidToken();
  
  const metadata = {
    name: name,
    parents: [parentId],
    mimeType: mimeType
  };
  
  // Use multipart upload for simplicity
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);
  
  const { getAccessToken } = await import("./auth.js");
  const token = getAccessToken();
  
  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,parents,imageMediaMetadata,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    }
  );
  
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Upload failed: ${response.status} ${text}`);
  }
  
  return response.json();
}

// Re-export getAccessToken for modules that need direct API access
export { getAccessToken } from "./auth.js";

// ============================================================================
// Drive Changes API (Feature #13 - incremental/delta scan)
// ============================================================================

/**
 * Get the starting pageToken for the Changes API.
 * Call once before the first scan to establish a baseline.
 */
export async function getChangesStartToken({ signal = null } = {}) {
  const res = await driveFetch("changes/startPageToken", { signal });
  return res?.startPageToken || null;
}

/**
 * Fetch changed files since a saved pageToken.
 * Returns { files: [...], nextToken } where files are changed/deleted items.
 * Only returns image files. Trashed/removed files are flagged with removed=true.
 */
export async function fetchChangesSince(pageToken, { signal = null } = {}) {
  if (!pageToken) return { files: [], nextToken: null };

  const changed = [];
  let token = pageToken;

  do {
    if (signal?.aborted) throw new Error("Scan stopped.");
    await ensureValidToken();

    const res = await driveFetch("changes", {
      params: {
        pageToken: token,
        fields: "nextPageToken,newStartPageToken,changes(removed,fileId,file(id,name,mimeType,size,modifiedTime,createdTime,parents,thumbnailLink,md5Checksum,webViewLink,imageMediaMetadata(width,height)))",
        pageSize: "1000",
        spaces: "drive"
      },
      signal
    });

    for (const c of (res.changes || [])) {
      if (c.removed) {
        changed.push({ id: c.fileId, _removed: true });
      } else if (c.file && isSupportedImageFile(c.file)) {
        changed.push({ ...c.file, _changed: true });
      }
    }

    token = res.nextPageToken || null;
    if (!token) {
      return { files: changed, nextToken: res.newStartPageToken || pageToken };
    }
  } while (token);

  return { files: changed, nextToken: null };
}

/**
 * Restore a file from trash (undo delete).
 */
export async function restoreFromTrash(fileId, { signal = null } = {}) {
  return driveFetch(`files/${fileId}`, {
    method: "PATCH",
    body: { trashed: false },
    signal
  });
}
