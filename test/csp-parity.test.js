/*
 * Drive Dupe Destroyer (DDD) — test/csp-parity.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// The Content-Security-Policy is declared in THREE places:
//
//   serve_secure.py  — the dev server's response header
//   sw.js            — the service worker sets it on responses it serves
//   js/security.js   — a runtime <meta> fallback when no header is present
//
// Which one applies depends on how the app is being served, so an origin added
// to one and not the others means the app behaves differently on localhost, on
// a static host, and on the second load once the service worker is controlling.
// That is the worst kind of difference: it looks fine wherever you tested.
//
// This deliberately does NOT try to parse three languages' string concatenation
// into a normalised policy — an earlier attempt did, and it broke on Python
// implicit concatenation and on a hostname interpolated from a variable. A test
// that fails for its own reasons is worse than no test. What it checks instead
// is the invariant that actually breaks: every external origin the page loads
// must be permitted by all three, and script-src must never allow inline code.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

const POLICY_FILES = ["serve_secure.py", "sw.js", "js/security.js"];

// Strip comments so an origin merely *mentioned* in prose does not count as
// permitted — js/security.js explains its directives in comments above them,
// and those explanations name the very origins under test.
//
// Only FULL-LINE comments are removed. A general block-comment regex is wrong
// here and this test caught it: CSP source lists contain wildcard origins like
// "https://*.googleapis.com", whose "//*" reads as a comment opener, so a
// non-greedy /\*[\s\S]*?\*\// match ran from inside the policy array to the
// next real "*/" and swallowed the directives it was supposed to check.
// A comment that starts a line cannot be inside a string literal.
const withoutComments = (src) =>
  src.split("\n")
     .filter(line => !/^\s*(\/\/|\/\*|\*|#)/.test(line))
     .join("\n");

// serve_secure.py builds script-src from a SCRIPT_HOSTS constant rather than
// writing the origins inline, so the directive text alone does not contain
// them. Substitute simple `NAME = "..."` definitions before reading the policy,
// otherwise this reports a gap that is not real.
function inlineConstants(src) {
  const consts = new Map();
  for (const m of src.matchAll(/(?:const\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*["']([^"']*)["']/g)) {
    consts.set(m[1], m[2]);
  }
  let out = src;
  for (const [name, value] of consts) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return out;
}

// Stitch string concatenation into one literal. serve_secure.py writes
// `"script-src 'self' " + SCRIPT_HOSTS + "; "`, so without this the span for
// script-src ends at the closing quote after 'self' and the origins — which
// inlineConstants has just resolved — sit outside it.
const stitchConcatenation = (src) =>
  src.replace(/"\s*\+\s*/g, "").replace(/\s*\+\s*"/g, "");

const POLICIES = Object.fromEntries(
  POLICY_FILES.map(f => [f, stitchConcatenation(inlineConstants(withoutComments(read(f))))])
);

// The sources for one directive, as a single string.
//
// A whole-file substring check is not enough and an earlier version of this
// test proved it: deleting the Lineicons origin from style-src alone still
// passed, because font-src elsewhere in the same file still mentioned it. The
// directive has to be isolated.
//
// Each file glues its policy together differently, so quotes, "+" and newlines
// between the directive name and the next ";" are noise and are stripped rather
// than parsed.
function sourcesFor(src, directive) {
  // Stop at a semicolon, a DOUBLE quote, or a newline. Stopping only at ";" was
  // wrong
  // and this test caught it: js/security.js builds its policy as an array of
  // one-directive strings with no semicolons at all, so the span for style-src
  // ran on into font-src and an origin deleted from style-src still "matched"
  // because font-src further down the array still carried it. Single quotes must
  // NOT terminate the span: every directive contains 'self', 'none' or
  // 'unsafe-inline', and excluding ' truncated all of them to nothing.
  const m = new RegExp(directive + '([^;"\n]*)').exec(src);
  if (!m) return null;
  return m[1].replace(/["'`+]/g, " ").replace(/\s+/g, " ").trim();
}

// Every external origin index.html pulls something from, and which directive
// has to permit it.
const EXTERNAL_LOADS = [...read("index.html").matchAll(
  /<(link|script)[^>]+(?:href|src)="(https:\/\/[^/"]+)/g
)].map(m => ({ origin: m[2], directive: m[1] === "script" ? "script-src" : "style-src" }));

describe("Content-Security-Policy parity", () => {
  test("all three files actually declare a policy", () => {
    for (const [file, src] of Object.entries(POLICIES)) {
      assert.match(src, /default-src/, `${file} has no CSP`);
      assert.match(src, /script-src/, `${file} has no script-src`);
    }
  });

  test("the page does load external origins worth checking", () => {
    assert.ok(EXTERNAL_LOADS.length >= 2,
      `expected index.html to reference external origins, found ${EXTERNAL_LOADS.length}`);
  });

  test("every external origin is permitted by the RIGHT directive in all three", () => {
    const missing = [];
    for (const { origin, directive } of EXTERNAL_LOADS) {
      for (const [file, src] of Object.entries(POLICIES)) {
        const sources = sourcesFor(src, directive);
        if (!sources) { missing.push(`${file} has no ${directive}`); continue; }
        if (!sources.includes(origin)) missing.push(`${file} ${directive} does not permit ${origin}`);
      }
    }
    assert.deepEqual(missing, [], "index.html loads an origin some copies of the CSP do not allow");
  });

  test("an icon-font origin allowed by style-src is also allowed by font-src", () => {
    // A stylesheet that loads fine and then cannot fetch its font renders every
    // glyph as nothing -- silently, with no console error that names the cause.
    const missing = [];
    for (const { origin, directive } of EXTERNAL_LOADS) {
      if (directive !== "style-src") continue;
      for (const [file, src] of Object.entries(POLICIES)) {
        const fontSrc = sourcesFor(src, "font-src") || "";
        if (!fontSrc.includes(origin)) missing.push(`${file} font-src does not permit ${origin}`);
      }
    }
    assert.deepEqual(missing, [], "a stylesheet origin is not permitted to serve its fonts");
  });

  test("script-src never gains 'unsafe-inline'", () => {
    // The folder-picker escaping fix in #48 was assessed as not exploitable on
    // the basis that an injected inline handler cannot execute. That holds only
    // while this does.
    for (const [file, src] of Object.entries(POLICIES)) {
      const m = src.match(/script-src[^;"'`]*/);
      assert.ok(m, `${file} has no script-src to check`);
      assert.ok(!m[0].includes("unsafe-inline"), `${file} allows inline script`);
    }
  });

  test("object-src stays 'none' everywhere", () => {
    for (const [file, src] of Object.entries(POLICIES)) {
      assert.match(src, /object-src 'none'/, `${file} does not forbid plugins`);
    }
  });
});
