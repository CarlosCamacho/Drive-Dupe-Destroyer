/*
 * Drive Dupe Destroyer (DDD) — errors.js
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
// Classifying a failure by what it means we should DO about it (#121).
//
// Three questions with three different answers:
//   is the server under pressure from us?  -> send fewer requests (AIMD)
//   are we out of memory?                  -> hold less (#126)
//   is this rate limiting specifically?    -> for stats and log wording
//
// Confusing them is not theoretical. A per-file decode failure counting as
// backpressure dragged a whole scan down to concurrency 1 the moment a Drive
// contained a few corrupt images.

/**
 * Should a failed request make us reduce global concurrency?
 *
 * Only for failures that mean the SERVER is under pressure from us. This
 * matters because AIMDController.onError halves concurrency unconditionally —
 * its isThrottle argument only changes the log line — so calling it on every
 * per-file failure dragged a whole scan down to concurrency 1 the moment a Drive
 * contained a few undecodable or corrupt images, with five consecutive
 * successes needed to climb back by one step. A file the browser cannot decode
 * says nothing about how hard we are hitting Drive.
 */
export function isBackpressureError(e) {
  const status = e?.status;
  const msg = e?.message || "";
  const throttled = status === 429 || /\b429\b|rate limit|too many requests/i.test(msg);
  const overloaded =
    (status >= 500 && status < 600) ||
    e?.code === "NETWORK" ||
    /timeout|timed out/i.test(msg);
  return throttled || overloaded;
}

/**
 * True for a failure that means THIS TAB is out of memory, not that the server
 * is under pressure (#126).
 *
 * Deliberately separate from isBackpressureError. That one covers 429, 5xx,
 * network and timeout -- reasons to send Drive fewer requests. Running out of
 * memory is the opposite problem: fewer requests will not help, holding less
 * will. AIMDController's doc comment says "call on 429, timeout, or OOM", but
 * nothing ever detected an OOM to call it with.
 *
 * Matched on the message because there is no status code for this: browsers
 * surface it as RangeError("Array buffer allocation failed"), a bare
 * "Out of memory", or a failed createImageBitmap.
 */
export function isMemoryPressureError(e) {
  const msg = e?.message || String(e || "");
  return e instanceof RangeError
    ? /allocation|memory/i.test(msg)
    : /out of memory|allocation failed|insufficient resources|QuotaExceeded/i.test(msg);
}

/** True only for rate limiting specifically, for stats and log wording. */
export function isThrottleError(e) {
  const msg = e?.message || "";
  return e?.status === 429 || /\b429\b|rate limit|too many requests/i.test(msg);
}

// ---------------------------------------------------------------------------
// Fourth question: will trying the same request again plausibly work? (#132)
// ---------------------------------------------------------------------------
//
// Distinct from isBackpressureError, which asks whether to send FEWER requests.
// Both are true of a 429, but they part company either way: a 404 is neither,
// and a 403 that says `rateLimitExceeded` is both while a 403 that says
// `insufficientFilePermissions` is neither. Drive returns rate limiting as a
// 403 with a reason in the body often enough that treating every 403 as
// permanent gives up on requests that would have succeeded.

/** Statuses worth trying again, on their own. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A 403 is retryable ONLY when Drive says it is about rate, not permission.
 * The message carries the first 200 characters of Drive's error body, which is
 * where the reason lives.
 */
function isRateLimited403(e) {
  return e?.status === 403 &&
    /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|too many requests/i.test(e?.message || "");
}

/**
 * Should this failure be retried?
 *
 * 401 is excluded on purpose: authedFetch already refreshes the token and
 * replays the request once, so retrying here would replay it a second time with
 * the same dead token. 404 and a permission 403 are answers, not failures --
 * a folder that is gone will still be gone in four seconds.
 */
export function isRetryableError(e) {
  if (e?.name === "AbortError") return false;
  if (e?.code === "NETWORK") return true;
  if (isRateLimited403(e)) return true;
  return RETRYABLE_STATUS.has(e?.status);
}

/**
 * How long to wait before attempt N+1, in ms.
 *
 * Exponential with FULL jitter -- a random point in [0, exponential] rather
 * than the exponential itself. Every in-flight request of a scan hits the same
 * 429 at the same moment, and a fixed backoff sends all of them back together,
 * which is how a rate limit stays pinned. The AIMD controller exists for the
 * same reason (see hashing.js).
 *
 * `retryAfterSeconds` is Drive's own instruction and wins outright when present
 * and sane; there is no point guessing better than the server.
 */
export function retryDelayMs(attempt, {
  baseMs = 500,
  capMs = 20000,
  retryAfterSeconds = null,
  random = Math.random,
} = {}) {
  const ra = Number(retryAfterSeconds);
  if (isFinite(ra) && ra > 0) return Math.min(ra * 1000, capMs);
  const n = Math.max(1, Number(attempt) || 1);
  const exponential = Math.min(baseMs * Math.pow(2, n - 1), capMs);
  return Math.floor(random() * exponential);
}

/**
 * Retry-After may be a delay in seconds or an HTTP date. Returns seconds, or
 * null when it is absent or unparseable -- in which case the caller backs off
 * on its own schedule rather than not backing off at all.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const when = Date.parse(s);
  if (!isFinite(when)) return null;
  const seconds = (when - now) / 1000;
  return seconds > 0 ? seconds : null;
}
