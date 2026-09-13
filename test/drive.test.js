/*
 * Drive Dupe Destroyer (DDD) — test/drive.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Tests for the pure helpers in js/drive.js.
//
// parseBatchResponse takes a string and returns a Map, so it can be tested
// against real captured response bodies with no network involved. That matters:
// when it fails to parse, batchTrash silently degrades to 100 individual PATCH
// requests per chunk, which is invisible from the UI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseBatchResponse, thumbLinkSized, isFolderMime, isGoogleDocMime } from "../js/drive.js";

// A batch response in the shape Google actually returns: the Content-ID is
// angle-bracketed and prefixed with "response-".
const REAL_RESPONSE = [
  "--batch_abc123",
  "Content-Type: application/http",
  "Content-ID: <response-1aBcDeFgHiJkLmNoP>",
  "",
  "HTTP/1.1 204 No Content",
  "Content-Type: text/html",
  "",
  "--batch_abc123",
  "Content-Type: application/http",
  "Content-ID: <response-2qRsTuVwXyZ01234>",
  "",
  "HTTP/1.1 404 Not Found",
  "Content-Type: application/json; charset=UTF-8",
  "",
  '{"error":{"code":404,"message":"File not found"}}',
  "",
  "--batch_abc123",
  "Content-Type: application/http",
  "Content-ID: <response-3hIjKlMnOpQrStUv>",
  "",
  "HTTP/1.1 403 Forbidden",
  "Content-Type: application/json; charset=UTF-8",
  "",
  '{"error":{"code":403,"message":"Insufficient permissions"}}',
  "",
  "--batch_abc123--",
].join("\r\n");

describe("parseBatchResponse", () => {
  // Regression: the pattern required "response-" immediately after the colon, so
  // the "<" Google actually sends meant nothing ever matched.
  test("parses angle-bracketed Content-ID headers", () => {
    const out = parseBatchResponse(REAL_RESPONSE);
    assert.equal(out.size, 3, "all three sub-responses must be accounted for");
    assert.deepEqual(out.get("1aBcDeFgHiJkLmNoP"), { status: 204, ok: true });
    assert.deepEqual(out.get("2qRsTuVwXyZ01234"), { status: 404, ok: false });
    assert.deepEqual(out.get("3hIjKlMnOpQrStUv"), { status: 403, ok: false });
  });

  test("does not swallow the closing bracket into the file ID", () => {
    const out = parseBatchResponse(REAL_RESPONSE);
    for (const key of out.keys()) {
      assert.ok(!key.includes(">"), `file ID "${key}" must not contain ">"`);
      assert.ok(!key.includes("<"), `file ID "${key}" must not contain "<"`);
    }
  });

  test("still parses a bare, unbracketed Content-ID", () => {
    const bare = REAL_RESPONSE.replace(/<response-/g, "response-").replace(/>/g, "");
    const out = parseBatchResponse(bare);
    assert.equal(out.size, 3);
    assert.equal(out.get("1aBcDeFgHiJkLmNoP").ok, true);
  });

  test("file IDs containing hyphens and underscores survive intact", () => {
    const body = [
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-1a-Bc_dE-fG_hI>",
      "",
      "HTTP/1.1 204 No Content",
      "",
      "--batch_x--",
    ].join("\r\n");
    const out = parseBatchResponse(body);
    assert.ok(out.has("1a-Bc_dE-fG_hI"));
  });

  test("empty or garbage input returns an empty map rather than throwing", () => {
    assert.equal(parseBatchResponse("").size, 0);
    assert.equal(parseBatchResponse(null).size, 0);
    assert.equal(parseBatchResponse("not a multipart body at all").size, 0);
  });

  test("2xx is ok, everything else is not", () => {
    const mk = (status) =>
      ["--batch_z", "Content-ID: <response-id1>", "", `HTTP/1.1 ${status} X`, "", "--batch_z--"].join("\r\n");
    assert.equal(parseBatchResponse(mk(200)).get("id1").ok, true);
    assert.equal(parseBatchResponse(mk(204)).get("id1").ok, true);
    assert.equal(parseBatchResponse(mk(299)).get("id1").ok, true);
    assert.equal(parseBatchResponse(mk(300)).get("id1").ok, false);
    assert.equal(parseBatchResponse(mk(500)).get("id1").ok, false);
  });
});

describe("thumbLinkSized", () => {
  test("sets the sz parameter", () => {
    const out = thumbLinkSized("https://lh3.googleusercontent.com/abc=s220", 512);
    assert.ok(out.includes("sz=w512"));
  });

  test("replaces an existing sz rather than appending a second one", () => {
    const out = thumbLinkSized("https://lh3.googleusercontent.com/abc?sz=w100", 256);
    assert.equal(out.match(/sz=/g).length, 1);
    assert.ok(out.includes("sz=w256"));
  });

  test("returns null for a missing link and passes through an unparseable one", () => {
    assert.equal(thumbLinkSized(null), null);
    assert.equal(thumbLinkSized("not a url"), "not a url");
  });
});

describe("mime helpers", () => {
  test("isFolderMime identifies the Drive folder type", () => {
    assert.equal(isFolderMime("application/vnd.google-apps.folder"), true);
    assert.equal(isFolderMime("image/jpeg"), false);
  });

  test("isGoogleDocMime excludes folders", () => {
    assert.equal(isGoogleDocMime("application/vnd.google-apps.document"), true);
    assert.equal(isGoogleDocMime("application/vnd.google-apps.folder"), false);
    assert.equal(isGoogleDocMime("image/png"), false);
  });
});
