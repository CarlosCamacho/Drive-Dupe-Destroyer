/*
 * Drive Dupe Destroyer (DDD) — test/auth-singleflight.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The single-flight guard around GIS token acquisition.
//
// js/auth.js cannot be imported under node:test — it reaches for the DOM at
// module scope through ui.js. So this reproduces the exact shape of the bug
// against the same structure: one mutable callback slot on a token client, many
// concurrent callers. If the guard regresses, the "concurrent callers" test
// below fails the same way the real app did (all but the last caller hang).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

/** Stand-in for google.accounts.oauth2 token client: ONE callback slot. */
function makeFakeTokenClient({ latencyMs = 10, response = { access_token: "tok", expires_in: 3599 } } = {}) {
  const client = { callback: null, requests: 0 };
  client.requestAccessToken = () => {
    client.requests++;
    // Read the slot when the flow COMPLETES, not when it starts. This is the
    // behaviour that makes the bug real: GIS looks up tokenClient.callback at
    // completion, so whoever installed theirs last receives every response and
    // the earlier callers are never called back at all.
    setTimeout(() => client.callback && client.callback(response), latencyMs);
  };
  return client;
}

/** The guard as implemented in js/auth.js. */
function makeSingleFlight(client) {
  let inFlight = null;
  return function requestTokenOnce() {
    if (inFlight) return inFlight;
    inFlight = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("timeout"));
      }, 200);
      client.callback = (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resp?.access_token ? resolve(resp) : reject(new Error(resp?.error || "denied"));
      };
      client.requestAccessToken();
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** The pre-fix behaviour, kept so the test proves it really was broken. */
function makeUnguarded(client) {
  return function requestToken() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("timeout"));
      }, 200);
      client.callback = (resp) => {        // clobbers any earlier caller's slot
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resp?.access_token ? resolve(resp) : reject(new Error("denied"));
      };
      client.requestAccessToken();
    });
  };
}

describe("token acquisition under concurrency", () => {
  // 16 is realistic: HASH_CONCURRENCY (6) + PATH_CONCURRENCY (10) can all hit a
  // stale token at once during a scan.
  const CALLERS = 16;

  test("without the guard, all but the last caller time out", async () => {
    const client = makeFakeTokenClient();
    const request = makeUnguarded(client);

    const results = await Promise.allSettled(
      Array.from({ length: CALLERS }, () => request())
    );

    const fulfilled = results.filter(r => r.status === "fulfilled").length;
    assert.equal(fulfilled, 1, "only the last-installed callback is ever fired");
    assert.equal(client.requests, CALLERS, "and every caller still hit Google");
  });

  test("with the guard, every caller resolves from one request", async () => {
    const client = makeFakeTokenClient();
    const request = makeSingleFlight(client);

    const results = await Promise.all(
      Array.from({ length: CALLERS }, () => request())
    );

    assert.equal(results.length, CALLERS);
    for (const r of results) assert.equal(r.access_token, "tok");
    assert.equal(client.requests, 1, "one request serves all concurrent callers");
  });

  test("the guard resets, so a later refresh issues a new request", async () => {
    const client = makeFakeTokenClient();
    const request = makeSingleFlight(client);

    await Promise.all([request(), request()]);
    assert.equal(client.requests, 1);

    await request();
    assert.equal(client.requests, 2, "a fresh call after settling is not swallowed");
  });

  test("a rejection reaches every waiting caller", async () => {
    const client = makeFakeTokenClient({ response: { error: "access_denied" } });
    const request = makeSingleFlight(client);

    const results = await Promise.allSettled([request(), request(), request()]);
    assert.equal(results.filter(r => r.status === "rejected").length, 3);
    assert.equal(client.requests, 1);
  });
});

// ---------------------------------------------------------------------------
// Token expiry derived from the GIS response
// ---------------------------------------------------------------------------

/** Mirrors expiryFromResponse in js/auth.js. */
function expiryFromResponse(resp, now = Date.now()) {
  const seconds = Number(resp?.expires_in);
  const usable = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  const buffer = Math.min(300, Math.floor(usable * 0.1));
  return now + (usable - buffer) * 1000;
}

describe("expiryFromResponse", () => {
  const NOW = 1_000_000;

  test("uses expires_in, refreshing 5 minutes early for a standard token", () => {
    assert.equal(expiryFromResponse({ expires_in: 3599 }, NOW), NOW + (3599 - 300) * 1000);
  });

  // Regression: the old code subtracted a flat 300s, which goes NEGATIVE for any
  // token shorter than five minutes — marking a live token already expired.
  test("never returns a time in the past for a short-lived token", () => {
    for (const secs of [1, 10, 60, 120, 299]) {
      const exp = expiryFromResponse({ expires_in: secs }, NOW);
      assert.ok(exp > NOW, `expires_in=${secs} must not produce an already-expired token`);
    }
  });

  test("falls back to an hour when GIS omits expires_in", () => {
    assert.equal(expiryFromResponse({}, NOW), NOW + (3600 - 300) * 1000);
    assert.equal(expiryFromResponse({ expires_in: "nonsense" }, NOW), NOW + (3600 - 300) * 1000);
  });
});
