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
// Security: all file/folder IDs validated before API calls
// Google Drive API operations

import { authedFetch, ensureValidToken } from "./auth.js";
import { validateFolderId, sanitizeText } from "./security.js";
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
  // Security: basic path sanity check - no traversal, no injection
  if (typeof path !== "string" || path.length > 512 || /[<>"{}|\^`]/.test(path)) {
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

export async function batchTrash(fileIds, { signal = null } = {}) {
  const results = { success: [], failed: [] };

  // Per-file fallback: PATCH each id individually. Used when the batch endpoint
  // errors out entirely, or for ids the batch response didn't account for.
  const fallbackPatch = async (ids) => {
    for (const id of ids) {
      if (signal?.aborted) throw new Error("Operation cancelled");
      try {
        await driveFetch(`files/${id}`, { method: "PATCH", body: { trashed: true }, signal });
        results.success.push(id);
      } catch (e) {
        // A 404 means the file is already gone — the goal (not present) is met.
        if (String(e?.message || "").includes("404")) results.success.push(id);
        else results.failed.push(id);
      }
    }
  };

  const chunks = [];
  for (let i = 0; i < fileIds.length; i += 100) {
    chunks.push(fileIds.slice(i, i + 100));
  }

  for (const ids of chunks) {
    if (signal?.aborted) throw new Error("Operation cancelled");

    // Ensure token valid before batch
    await ensureValidToken();

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
      if (signal?.aborted || e.message === "Operation cancelled") throw e;
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
