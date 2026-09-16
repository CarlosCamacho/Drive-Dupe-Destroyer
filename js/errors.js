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
