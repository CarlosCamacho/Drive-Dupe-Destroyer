/*
 * Drive Dupe Destroyer (DDD) — test/batch-meta.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// parseBatchBodies reads the JSON payloads out of a multipart batch response,
// which batched ancestor lookups need (#68). parseBatchResponse, which the
// delete path uses, returns statuses only — this is a separate reader rather
// than a change to a function trashing depends on.
//
// It takes a string and returns a Map, so it can be tested against real response
// shapes with no network. That matters: when it fails to parse, path resolution
// silently falls back to one request per ancestor and nothing says so.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseBatchBodies } from "../js/drive.js";

// The shape Google returns: angle-bracketed Content-ID prefixed with "response-",
// sub-response headers, a blank line, then the JSON body.
const RESPONSE = [
  "--batch_meta_abc",
  "Content-Type: application/http",
  "Content-ID: <response-1aBcDeF>",
  "",
  "HTTP/1.1 200 OK",
  "Content-Type: application/json; charset=UTF-8",
  "",
  '{"id":"1aBcDeF","name":"Photos","mimeType":"application/vnd.google-apps.folder","parents":["root"]}',
  "",
  "--batch_meta_abc",
  "Content-Type: application/http",
  "Content-ID: <response-2xYz>",
  "",
  "HTTP/1.1 404 Not Found",
  "Content-Type: application/json; charset=UTF-8",
  "",
  '{"error":{"code":404,"message":"File not found"}}',
  "",
  "--batch_meta_abc",
  "Content-Type: application/http",
  "Content-ID: <response-3mNoP>",
  "",
  "HTTP/1.1 200 OK",
  "Content-Type: application/json; charset=UTF-8",
  "",
  '{"id":"3mNoP","name":"2019","mimeType":"application/vnd.google-apps.folder","parents":["1aBcDeF"]}',
  "",
  "--batch_meta_abc--",
].join("\r\n");

describe("parseBatchBodies", () => {
  test("returns the parsed body for each successful sub-response", () => {
    const out = parseBatchBodies(RESPONSE);
    assert.equal(out.get("1aBcDeF")?.name, "Photos");
    assert.deepEqual(out.get("1aBcDeF")?.parents, ["root"]);
    assert.equal(out.get("3mNoP")?.name, "2019");
  });

  // A failed ancestor must be ABSENT, not present-and-empty: the walk has to be
  // able to tell "not fetched" from "fetched, no parent", because the second
  // ends a path and the first must mark it incomplete (#46).
  test("a non-2xx sub-response is omitted entirely", () => {
    const out = parseBatchBodies(RESPONSE);
    assert.equal(out.has("2xYz"), false, "a 404 must not appear as a resolved folder");
    assert.equal(out.size, 2);
  });

  test("file ids keep their hyphens and underscores", () => {
    const body = [
      "--batch_x",
      "Content-ID: <response-1a-Bc_dE-fG>",
      "",
      "HTTP/1.1 200 OK",
      "",
      '{"id":"1a-Bc_dE-fG","name":"Odd Name"}',
      "--batch_x--",
    ].join("\r\n");
    const out = parseBatchBodies(body);
    assert.equal(out.get("1a-Bc_dE-fG")?.name, "Odd Name");
  });

  test("a bare, unbracketed Content-ID still parses", () => {
    const out = parseBatchBodies(RESPONSE.replace(/<response-/g, "response-").replace(/>/g, ""));
    assert.equal(out.get("1aBcDeF")?.name, "Photos");
  });

  test("a name containing braces survives", () => {
    const body = [
      "--batch_x",
      "Content-ID: <response-b1>",
      "",
      "HTTP/1.1 200 OK",
      "",
      '{"id":"b1","name":"Report {final}"}',
      "--batch_x--",
    ].join("\r\n");
    assert.equal(parseBatchBodies(body).get("b1")?.name, "Report {final}");
  });

  test("empty, null and garbage input return an empty map rather than throwing", () => {
    assert.equal(parseBatchBodies("").size, 0);
    assert.equal(parseBatchBodies(null).size, 0);
    assert.equal(parseBatchBodies("not multipart at all").size, 0);
  });

  test("a truncated body is dropped rather than half-parsed", () => {
    const body = [
      "--batch_x",
      "Content-ID: <response-t1>",
      "",
      "HTTP/1.1 200 OK",
      "",
      '{"id":"t1","name":"Trunc',
      "--batch_x--",
    ].join("\r\n");
    assert.equal(parseBatchBodies(body).has("t1"), false);
  });
});
