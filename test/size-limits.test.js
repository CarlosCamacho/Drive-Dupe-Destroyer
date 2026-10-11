/*
 * Drive Dupe Destroyer (DDD) — test/size-limits.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The Min / Max image size range.
//
// Two defects, one field pair. The defaults lived in two places (index.html
// and settings.js) and disagreed -- 50 KB / 999 MB in the page, 50 KB / "0" in
// the saved-settings table. And nothing checked the range: "min 60 MB, max
// 4 MB" filtered out every image and was reported as an empty Drive.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_SIZE, DEFAULT_MIN_SIZE, formatSizeLimit, sizeLimitsBytes } from "../js/formats.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const SETTINGS = readFileSync(join(ROOT, "js", "settings.js"), "utf8");

const htmlValue = (id) => HTML.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`))?.[1];
const htmlSelected = (id) => {
  const block = HTML.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`))?.[0] || "";
  return block.match(/<option value="([^"]+)" selected>/)?.[1];
};
const savedDefault = (id) => SETTINGS.match(new RegExp(`id: "${id}",[^}]*default: "([^"]*)"`))?.[1];

describe("size range defaults", () => {
  test("are 32 KB to 2 MB", () => {
    assert.deepEqual(DEFAULT_MIN_SIZE, { value: 32, unit: "KB" });
    assert.deepEqual(DEFAULT_MAX_SIZE, { value: 2, unit: "MB" });
  });

  test("index.html shows those defaults", () => {
    assert.equal(htmlValue("imgMinSize"), String(DEFAULT_MIN_SIZE.value));
    assert.equal(htmlSelected("imgMinUnit"), DEFAULT_MIN_SIZE.unit);
    assert.equal(htmlValue("imgMaxSize"), String(DEFAULT_MAX_SIZE.value));
    assert.equal(htmlSelected("imgMaxUnit"), DEFAULT_MAX_SIZE.unit);
  });

  test("settings.js restores to the same defaults", () => {
    assert.equal(savedDefault("imgMinSize"), String(DEFAULT_MIN_SIZE.value));
    assert.equal(savedDefault("imgMinUnit"), DEFAULT_MIN_SIZE.unit);
    assert.equal(savedDefault("imgMaxSize"), String(DEFAULT_MAX_SIZE.value));
    assert.equal(savedDefault("imgMaxUnit"), DEFAULT_MAX_SIZE.unit);
  });

  test("old saved size values are migrated, not restored over the new defaults", () => {
    assert.match(SETTINGS, /SIZE_DEFAULTS_VERSION/);
    assert.match(SETTINGS, /def\.sizeDefaults && !sizeCurrent/);
  });
});

describe("sizeLimitsBytes", () => {
  test("converts the defaults", () => {
    const r = sizeLimitsBytes({ minValue: "32", minUnit: "KB", maxValue: "2", maxUnit: "MB" });
    assert.deepEqual(r, { minBytes: 32 * 1024, maxBytes: 2 * 1024 * 1024, valid: true });
  });

  test("flags a minimum above the maximum -- the screenshot case", () => {
    const r = sizeLimitsBytes({ minValue: "60", minUnit: "MB", maxValue: "4", maxUnit: "MB" });
    assert.equal(r.valid, false);
  });

  test("compares across units", () => {
    assert.equal(sizeLimitsBytes({ minValue: "900", minUnit: "KB", maxValue: "1", maxUnit: "MB" }).valid, true);
    assert.equal(sizeLimitsBytes({ minValue: "2000", minUnit: "KB", maxValue: "1", maxUnit: "MB" }).valid, false);
  });

  test("a blank or zero maximum means no upper limit", () => {
    for (const maxValue of ["", "0", undefined, "abc"]) {
      const r = sizeLimitsBytes({ minValue: "5", minUnit: "MB", maxValue, maxUnit: "MB" });
      assert.equal(r.maxBytes, Infinity, String(maxValue));
      assert.equal(r.valid, true);
    }
  });

  test("negative and junk minimums are zero", () => {
    assert.equal(sizeLimitsBytes({ minValue: "-5", minUnit: "MB", maxValue: "1", maxUnit: "MB" }).minBytes, 0);
    assert.equal(sizeLimitsBytes({ minValue: "x", minUnit: "KB", maxValue: "1", maxUnit: "MB" }).minBytes, 0);
  });

  test("formats limits for messages", () => {
    assert.equal(formatSizeLimit(32 * 1024), "32 KB");
    assert.equal(formatSizeLimit(2 * 1024 * 1024), "2 MB");
    assert.equal(formatSizeLimit(Infinity), "no limit");
  });
});
