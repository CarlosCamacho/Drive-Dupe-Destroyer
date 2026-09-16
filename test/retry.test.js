/*
 * Drive Dupe Destroyer (DDD) — test/retry.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The retry policy the enumeration path never had (#132).
//
// Measured before this existed: one injected 503 on a branch folder took a
// 20-image fixture to ZERO images, reported as "No images found." The retry
// is half the fix; saying so when a folder still cannot be read is the other
// half, and both are checked here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isRetryableError, retryDelayMs, parseRetryAfter, isBackpressureError } from "../js/errors.js";
import { unreadableFoldersText } from "../js/uiText.js";

const driveError = (status, message = "Drive API error") =>
  Object.assign(new Error(`${message} ${status}`), { status, code: "DRIVE_API" });

describe("which failures are worth trying again", () => {
  test("the transient server statuses are", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableError(driveError(s)), true, `${s} should be retryable`);
    }
  });

  test("a transport failure is -- it is the likeliest one on a long enumeration", () => {
    assert.equal(isRetryableError(Object.assign(new Error("Network request failed"), { code: "NETWORK" })), true);
  });

  test("an answer is not a failure: 400, 404 and a permission 403 are final", () => {
    assert.equal(isRetryableError(driveError(400)), false);
    assert.equal(isRetryableError(driveError(404)), false);
    assert.equal(
      isRetryableError(driveError(403, 'insufficientFilePermissions')),
      false,
      "a folder we may not read will still be unreadable in four seconds",
    );
  });

  test("but a 403 that Drive says is about RATE is retryable", () => {
    // Drive returns rate limiting as a 403 with the reason in the body often
    // enough that treating every 403 as permanent gives up on requests that
    // would have succeeded.
    assert.equal(isRetryableError(driveError(403, 'rateLimitExceeded')), true);
    assert.equal(isRetryableError(driveError(403, 'userRateLimitExceeded')), true);
  });

  test("401 is NOT retried here -- authedFetch already replays it once", () => {
    assert.equal(
      isRetryableError(driveError(401)),
      false,
      "retrying here would replay the request a second time with the same dead token",
    );
  });

  test("a user abort is never retried", () => {
    assert.equal(isRetryableError(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  });

  test("retryable and backpressure are different questions", () => {
    // Both true of a 429, but they part company either way.
    const notFound = driveError(404);
    assert.equal(isRetryableError(notFound), false);
    assert.equal(isBackpressureError(notFound), false);

    const perms = driveError(403, "insufficientFilePermissions");
    assert.equal(isRetryableError(perms), false);
    assert.equal(isBackpressureError(perms), false);

    const throttled = driveError(429);
    assert.equal(isRetryableError(throttled), true);
    assert.equal(isBackpressureError(throttled), true);
  });
});

describe("how long to wait", () => {
  test("backs off exponentially", () => {
    // random() === 1 gives the top of the jitter window, which is the
    // exponential itself.
    const top = (attempt) => retryDelayMs(attempt, { baseMs: 500, random: () => 1 });
    assert.equal(top(1), 500);
    assert.equal(top(2), 1000);
    assert.equal(top(3), 2000);
  });

  test("jitters across the whole window rather than waiting a fixed time", () => {
    // Every in-flight request of a scan hits the same 429 at the same instant.
    // A fixed backoff sends them all back together, which is how a rate limit
    // stays pinned.
    assert.equal(retryDelayMs(3, { baseMs: 500, random: () => 0 }), 0);
    assert.equal(retryDelayMs(3, { baseMs: 500, random: () => 0.5 }), 1000);
    assert.equal(retryDelayMs(3, { baseMs: 500, random: () => 1 }), 2000);
  });

  test("is capped, so attempt 20 does not wait nine days", () => {
    assert.equal(retryDelayMs(20, { baseMs: 500, capMs: 20000, random: () => 1 }), 20000);
  });

  test("Drive's own Retry-After wins over our guess", () => {
    assert.equal(retryDelayMs(1, { baseMs: 500, retryAfterSeconds: 7, random: () => 1 }), 7000);
  });

  test("and is capped too, so a hostile header cannot hang the scan", () => {
    assert.equal(retryDelayMs(1, { capMs: 20000, retryAfterSeconds: 86400 }), 20000);
  });

  test("a nonsense Retry-After falls back to the exponential", () => {
    assert.equal(retryDelayMs(2, { baseMs: 500, retryAfterSeconds: 0, random: () => 1 }), 1000);
    assert.equal(retryDelayMs(2, { baseMs: 500, retryAfterSeconds: -5, random: () => 1 }), 1000);
    assert.equal(retryDelayMs(2, { baseMs: 500, retryAfterSeconds: NaN, random: () => 1 }), 1000);
  });
});

describe("reading Retry-After", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  test("a plain number is seconds", () => {
    assert.equal(parseRetryAfter("30", now), 30);
  });

  test("an HTTP date becomes seconds from now", () => {
    assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:45 GMT", now), 45);
  });

  test("a date already past is not a negative wait", () => {
    assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now), null);
  });

  test("absent or unparseable is null -- the caller still backs off on its own", () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(undefined), null);
    assert.equal(parseRetryAfter("soon"), null);
  });
});

describe("saying a scan did not cover everything", () => {
  test("says nothing when it did", () => {
    assert.equal(unreadableFoldersText(0), "");
    assert.equal(unreadableFoldersText(null), "");
  });

  test("names the count and, more importantly, the consequence", () => {
    const one = unreadableFoldersText(1);
    assert.match(one, /1 folder could not be read/);
    assert.match(one, /does not cover everything/);

    const many = unreadableFoldersText(1234);
    assert.match(many, /1,234 folders could not be read/);
    assert.match(many, /does not cover everything/);
  });
});
