/*
 * Drive Dupe Destroyer (DDD) — test/security.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Input validation from js/security.js. These gate values that are interpolated
// into Drive `q` expressions and API paths, so a gap here is a malformed query
// rather than a loud failure.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateFolderId, validateClientId, sanitizeText, isAllowedOrigin } from "../js/security.js";

describe("validateFolderId", () => {
  test("accepts a real Drive folder ID", () => {
    assert.equal(validateFolderId("1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P"), true);
    assert.equal(validateFolderId("1a-Bc_dE-fG_hI-jKl"), true);
  });

  // Regression: the length floor of 10 rejected "root", Drive's alias for My
  // Drive and the value the folder picker starts on. Wiring this validator into
  // buildQuery without allowing it would have thrown on a root-level scan.
  test("accepts Drive's folder aliases", () => {
    assert.equal(validateFolderId("root"), true);
    assert.equal(validateFolderId("appDataFolder"), true);
  });

  test("rejects anything that could break out of a q expression", () => {
    for (const bad of [
      "abc'def",           // quote — would terminate the literal
      "abc def",           // space
      "abc/def",           // path separator
      "../../etc",         // traversal
      "abc\"def",
      "",
      null,
      undefined,
      12345,
      "short",             // below the length floor and not an alias
      "x".repeat(65),      // above the ceiling
    ]) {
      assert.equal(validateFolderId(bad), false, JSON.stringify(bad));
    }
  });
});

describe("validateClientId", () => {
  test("accepts a well-formed Google client ID", () => {
    assert.equal(validateClientId("123456789-abc.apps.googleusercontent.com"), true);
  });

  test("rejects anything else", () => {
    for (const bad of [
      "123456789.apps.googleusercontent.com.evil.com",
      "not-a-client-id",
      "<script>.apps.googleusercontent.com",
      "a b.apps.googleusercontent.com",
      "",
      null,
      "x".repeat(300) + ".apps.googleusercontent.com",
    ]) {
      assert.equal(validateClientId(bad), false, JSON.stringify(bad));
    }
  });
});

describe("sanitizeText", () => {
  test("escapes every character that matters in HTML", () => {
    assert.equal(sanitizeText(`<img src=x onerror="alert('x')">`),
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;");
  });

  test("escapes ampersands first so entities are not double-formed", () => {
    assert.equal(sanitizeText("&lt;"), "&amp;lt;");
  });

  test("null and undefined become an empty string", () => {
    assert.equal(sanitizeText(null), "");
    assert.equal(sanitizeText(undefined), "");
  });
});

describe("isAllowedOrigin", () => {
  test("accepts Google origins", () => {
    assert.equal(isAllowedOrigin("https://accounts.google.com"), true);
    assert.equal(isAllowedOrigin("https://www.googleapis.com"), true);
  });

  test("rejects look-alike origins and junk", () => {
    assert.equal(isAllowedOrigin("https://accounts.google.com.evil.test"), false);
    assert.equal(isAllowedOrigin("https://evil.test"), false);
    assert.equal(isAllowedOrigin(""), false);
    assert.equal(isAllowedOrigin(null), false);
  });
});
