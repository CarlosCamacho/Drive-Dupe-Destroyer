/*
 * Drive Dupe Destroyer (DDD) — test/unused-exports.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// An export that nothing calls is a feature nobody can reach (#120).
//
// Three times now, a complete and working implementation has been exported and
// then wired to nothing, and each one was found by a human reading the code
// months later:
//
//   #79   clearMemoryPathCaches()  exported, unused, while the wrong function ran
//   #101  clearRejections()        exported, unused; "not a duplicate" was permanent
//   #113  addToQueue()             exported, unused; the ENTIRE trash queue unreachable
//
// This is the mechanical check that would have caught all three in the commit
// that introduced them.
//
// Why it is not a grep
// --------------------
// A naive "exported and not imported anywhere" scan reports 58 candidates in
// this repository and most are false positives. Two categories matter:
//
//   1. INTERNALLY COMPOSED. js/security.js exports applyReferrerPolicy,
//      applyContentSecurityPolicy and stripTokensFromUrl; no other module
//      imports any of them, and all three are called from security.js's own
//      init function. Flagging those would be wrong — and a check that cries
//      wolf over security code is a check people learn to skip.
//
//   2. TEST-ONLY SEAMS. Around 34 exports exist for test/ and tools/ to drive:
//      auth.ensureToken, matcher.OPTIONAL_ENTRY_FIELDS, scan.checkpointInterval,
//      exporter.itemsToCsv. Those are legitimate and must count as used.
//
// So the rule is: an export is dead when NOTHING references it — counting every
// other js/ module, index.html, sw.js, test/, tools/, and its own module body
// outside the declaration itself.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Exports that are allowed to have no caller, each with the reason.
 *
 * Keep this SHORT. Every entry is a small admission that something is not
 * reachable, so it should hurt slightly to add one. "I might need it later" is
 * not a reason; delete it instead — git remembers.
 */
const ALLOWED = new Map([
  // These five are NOT dead code. Each is a working implementation whose
  // missing caller is a real gap, and wiring any of them changes behaviour in a
  // way that deserves its own decision rather than being slipped into the
  // commit that added this check. Listed so the gap is on the record instead of
  // being deleted and forgotten.
  ["js/db.js:dbCleanupOldEntries",
   "The 90-day image-cache pruner has no caller. pathCachePrune does; this does not, " +
   "so the images store grows without bound. Wiring it deletes user cache on a " +
   "schedule nobody has chosen yet."],
  ["js/db.js:isDbReady",
   "Part of the recovery path added for #76 (a blocked upgrade hanging every DB call). " +
   "The notifier is wired; the recovery is not."],
  ["js/db.js:reconnectDb",
   "Same as isDbReady: #76 can detect a blocked database but nothing reconnects after one."],
  ["js/db.js:clearChangesToken",
   "The delta-scan token is set and read (scan.js:957,995,1000) but never cleared, so a " +
   "changed folder selection cannot invalidate it. #116 is where that matters."],
  ["js/drive.js:setDriveConfig",
   "Shared Drives are fully plumbed -- supportsAllDrives, includeItemsFromAllDrives, " +
   "corpora, driveId -- and defaulted off with no UI to turn them on."],
]);

const read = (p) => readFileSync(p, "utf8");

const jsFiles = () =>
  readdirSync(join(ROOT, "js")).filter(f => f.endsWith(".js")).map(f => join(ROOT, "js", f));

/** Files that may legitimately reference an export: everything that ships or tests. */
function consumerFiles() {
  const out = [];
  for (const dir of ["js", "test", "tools"]) {
    const d = join(ROOT, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (/\.(js|mjs)$/.test(f)) out.push(join(d, f));
    }
  }
  for (const f of ["index.html", "sw.js"]) {
    if (existsSync(join(ROOT, f))) out.push(join(ROOT, f));
  }
  return out;
}

/**
 * Named exports of one module.
 *
 * Deliberately does not try to parse JavaScript. It matches the declaration
 * forms this codebase actually uses, and the test below asserts the count is
 * plausible so a syntax change that silently matched nothing cannot turn this
 * check into a no-op that always passes.
 */
function exportsOf(src) {
  const names = [];
  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+(?:const|let|var|class)\s+(\w+)/gm,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) names.push(m[1]);
  }
  return names;
}

/**
 * Strip `import { ... } from "..."` statements.
 *
 * An import is not a use. Without this, removing the last CALL to a function
 * while leaving it in the import list kept the check green -- which would have
 * missed a whole class of the bug it exists to catch. (It still caught #79,
 * #101 and #113, because all three were never imported at all.) A side effect
 * is that an unused import now surfaces as a dead export, which is the correct
 * complaint about the same line.
 */
function stripImports(src) {
  return src
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^import\s+["'][^"']+["'];?\s*$/gm, "");
}

/** Count whole-word occurrences of `name` in `src`. */
function refCount(src, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  return (src.match(re) || []).length;
}

/**
 * References to `name` inside its OWN module, not counting the export
 * declaration itself. This is what spares the security.js trio.
 */
function selfRefCount(src, name) {
  const declaration = new RegExp(
    `^export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`, "m");
  const withoutDecl = src.replace(declaration, "");
  return refCount(withoutDecl, name);
}

describe("unused exports (#120)", () => {
  const files = jsFiles();
  const sources = new Map(files.map(f => [f, read(f)]));
  const consumers = consumerFiles().map(f => [f, read(f)]);

  test("the scan itself finds exports — it is not silently matching nothing", () => {
    const total = [...sources.values()].reduce((n, s) => n + exportsOf(s).length, 0);
    assert.ok(total > 150,
      `only ${total} exports found across ${files.length} modules; the export patterns ` +
      `have probably stopped matching, which would make this whole check pass vacuously`);
  });

  test("every export is reachable from somewhere", () => {
    const dead = [];

    for (const [file, src] of sources) {
      const own = file;
      for (const name of exportsOf(src)) {
        const key = `${file.slice(ROOT.length)}:${name}`;
        if ([...ALLOWED.keys()].some(k => key.endsWith(k))) continue;

        // Used by another shipping/test/tool file?
        let external = 0;
        for (const [cf, csrc] of consumers) {
          if (cf === own) continue;
          external += refCount(stripImports(csrc), name);
        }
        if (external > 0) continue;

        // Used inside its own module (init functions, internal composition)?
        if (selfRefCount(src, name) > 0) continue;

        dead.push(key);
      }
    }

    assert.deepEqual(dead, [],
      `These exports are referenced nowhere — not by js/, index.html, sw.js, test/ or tools/, ` +
      `and not inside their own module. Each is a feature nobody can reach (#79, #101, #113 ` +
      `were all this exact shape). Wire it up, delete it, or add it to ALLOWED with a reason:\n  ` +
      dead.join("\n  "));
  });
});
