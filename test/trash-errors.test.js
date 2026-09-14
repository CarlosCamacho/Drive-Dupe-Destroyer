/*
 * Drive Dupe Destroyer (DDD) — test/trash-errors.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// How batchTrash and undoLastDelete classify a failed PATCH (#81).
//
// Both decisions used to be made by searching the error MESSAGE, which embeds
// up to 200 characters of Drive's own error body. Both err in the same
// direction when they are wrong -- toward reporting a file as gone when it is
// still there -- which is the failure the batch path's comment says was fixed
// and the fallback path kept.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isAlreadyGoneError, isTerminalTrashError } from "../js/drive.js";

/** An error exactly as driveFetch builds it. */
function driveError(status, body) {
  return Object.assign(
    new Error(`Drive API error ${status}: ${body}`),
    { status, code: "DRIVE_API" }
  );
}

describe("isAlreadyGoneError", () => {
  test("a 404 is already gone — the goal state is met", () => {
    assert.equal(isAlreadyGoneError(driveError(404, '{"error":{"code":404,"message":"File not found: 1aBcD."}}')), true);
  });

  // The regression. Drive names the file in its permission errors, and a Drive
  // file ID is 33 characters of [A-Za-z0-9_-] — so one in roughly 8,000 of them
  // contains "404" somewhere. The old `.includes("404")` reported that file as
  // trashed, dropped it from the queue, and recorded it in the undo stack,
  // while it sat untouched in Drive.
  test("a 403 whose body happens to contain 404 is NOT already gone", () => {
    const e = driveError(403, '{"error":{"code":403,"message":"The user does not have sufficient permissions for file 1Ab404cDeFgHiJkLmNoPqRsTuVwXyZ012."}}');
    assert.match(e.message, /404/, "the message really does contain 404");
    assert.equal(isAlreadyGoneError(e), false);
  });

  test("a 500 whose body quotes a 404 from an inner service is NOT already gone", () => {
    assert.equal(isAlreadyGoneError(driveError(500, '{"error":{"code":500,"message":"Internal error; upstream returned 404"}}')), false);
  });

  test("a transport failure with no status is not already gone", () => {
    assert.equal(isAlreadyGoneError(Object.assign(new Error("Network request failed"), { code: "NETWORK" })), false);
  });

  test("a missing or malformed error is not already gone", () => {
    assert.equal(isAlreadyGoneError(null), false);
    assert.equal(isAlreadyGoneError(undefined), false);
    assert.equal(isAlreadyGoneError({}), false);
    assert.equal(isAlreadyGoneError({ status: "404" }), false, "a string status is not a status");
  });
});

describe("isTerminalTrashError", () => {
  // Retrying these per file buys nothing: every remaining request fails the
  // same way, and for an auth failure each one drags a fresh doomed GIS attempt
  // behind it — 204 of them across a 100-file chunk, measured.
  test("a dead session stops the run", () => {
    assert.equal(isTerminalTrashError(Object.assign(new Error("Failed to obtain access token (interaction_required)"), { code: "AUTH" })), true);
  });

  test("a sign-in timeout stops the run", () => {
    // Only true because ensureToken now preserves the code when it rewrites the
    // message. It used to throw a bare Error, and this would have been false.
    assert.equal(isTerminalTrashError(Object.assign(new Error("Sign-in timed out. ..."), { code: "AUTH_TIMEOUT" })), true);
  });

  test("a cancel stops the run", () => {
    assert.equal(isTerminalTrashError(new Error("Operation cancelled")), true);
    assert.equal(isTerminalTrashError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  });

  test("an ordinary per-file failure does not", () => {
    assert.equal(isTerminalTrashError(driveError(403, "insufficientFilePermissions")), false);
    assert.equal(isTerminalTrashError(driveError(404, "File not found")), false);
    assert.equal(isTerminalTrashError(driveError(503, "Backend Error")), false);
    assert.equal(isTerminalTrashError(Object.assign(new Error("Network request failed"), { code: "NETWORK" })), false);
    assert.equal(isTerminalTrashError(null), false);
  });
});
