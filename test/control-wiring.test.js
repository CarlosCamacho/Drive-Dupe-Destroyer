/*
 * Drive Dupe Destroyer (DDD) — test/control-wiring.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// A control nobody reads is a setting that does nothing (#139).
//
// #120 catches the JS half of this: an export with no caller. It cannot see
// the HTML half, and the HTML half is worse, because a dead control does not
// merely sit there -- it LOOKS like it works. It has a label, a help icon, and
// a readout that moves as you drag it.
//
// #137 was exactly that. The Advanced "Hamming threshold" slider was displayed
// (index.html), given a live readout (app.js), persisted (settings.js) and
// documented (util.js), and the scan never read it. Running this check against
// the history shows it was unread in the FIRST COMMIT of the repository and
// every commit after -- the slider has never once worked.
//
// Why "is it mentioned in js/" is not the rule
// --------------------------------------------
// hamThresh WAS mentioned in js/, three times. Every mention registered it in
// a generic table -- display it, save it, describe it -- and none of them read
// its value. Registering a control is not consuming it.
//
// So the rule is about the SHAPE of the reference: a control is read when some
// code looks the element up by its id. el("x"), getElementById("x"), or a
// querySelector for "#x". A loop over a table of ids calling el(entry.id) does
// not count, which is precisely the distinction that was missing.
//
// Verified against the real history rather than asserted: on the commit before
// the #137 fix this flags hamThresh and nothing else, and on the commit after
// it flags nothing, across 88 controls.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/**
 * Controls allowed to have no id lookup, each with the reason.
 *
 * Keep this SHORT, for the same reason #120's list is short: every entry
 * admits that something on screen may do nothing. A control driven entirely by
 * a class selector or by a delegated listener on an ancestor is the legitimate
 * case; "I will wire it later" is not -- delete it instead, git remembers.
 */
const ALLOWED = new Map([]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every interactive control in index.html that carries an id. */
function controlIds(html) {
  const out = new Map();
  const re = /<(input|select|textarea|button)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = /\bid="([^"]+)"/.exec(m[2]);
    if (id) out.set(id[1], m[1].toLowerCase());
  }
  return out;
}

/** Everything that ships and could read a control. */
function scriptSources() {
  const files = readdirSync(join(ROOT, "js"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => join("js", f));
  if (existsSync(join(ROOT, "sw.js"))) files.push("sw.js");
  return files.map((f) => ({ file: f, text: read(f) }));
}

/** Does anything look this element up by id? */
function lookupSites(id, sources) {
  const e = escapeRe(id);
  const patterns = [
    new RegExp(`\\bel\\(\\s*["'\`]${e}["'\`]`),
    new RegExp(`getElementById\\(\\s*["'\`]${e}["'\`]`),
    new RegExp(`querySelector(?:All)?\\(\\s*["'\`][^"'\`]*#${e}\\b`),
  ];
  return sources.filter((s) => patterns.some((p) => p.test(s.text))).map((s) => s.file);
}

const html = read("index.html");
const controls = controlIds(html);
const sources = scriptSources();

describe("every control on the page is read by something (#139)", () => {
  test("the page really does have controls to check", () => {
    // Without this, a parser that silently matched nothing would make every
    // assertion below pass over an empty list.
    assert.ok(controls.size > 50, `expected the app's controls, found ${controls.size}`);
    assert.ok(sources.length > 10, `expected the app's modules, found ${sources.length}`);
    assert.ok(controls.has("hamThresh"), "the control from #137 should still be on the page");
  });

  test("no control is registered without also being read", () => {
    const dead = [];
    for (const [id, tag] of controls) {
      if (ALLOWED.has(id)) continue;
      if (lookupSites(id, sources).length === 0) dead.push(`<${tag} id="${id}">`);
    }
    assert.deepEqual(
      dead, [],
      `These controls are on the page and nothing looks them up, so whatever they ` +
      `appear to do, they do not do it:\n  ${dead.join("\n  ")}\n` +
      `Wire it, delete it, or add it to ALLOWED with the reason.`,
    );
  });

  test("the control from #137 is read where the scan can see it", () => {
    // Named on purpose. The generic assertion above would go green again if
    // someone moved the read into another display-only table, and this is the
    // one control we know shipped broken for the repository's whole history.
    assert.ok(
      lookupSites("hamThresh", sources).includes("js/scan.js"),
      "js/scan.js must read the threshold slider, not just thresholdFromEasy()",
    );
  });
});

describe("ids and help text line up", () => {
  test("no id appears twice", () => {
    // el() returns the first match, so a duplicate makes one of the two
    // elements silently unreachable -- the same failure with no dead control
    // to notice.
    const seen = new Map();
    const dupes = [];
    for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
      const id = m[1];
      if (seen.has(id)) dupes.push(id);
      seen.set(id, true);
    }
    assert.deepEqual([...new Set(dupes)], []);
  });

  test("every HELP_TEXT entry names something on the page", () => {
    // ui.js creates a help icon by looking up el(key), so an entry whose key
    // matches no element is help nobody can ever read. Three of these existed
    // for the Cache buttons, whose real ids are btnDbExport / btnDbImport /
    // btnDbClear.
    const util = read("js/util.js");
    const block = /HELP_TEXT\s*=\s*\{([\s\S]*?)\n\}/.exec(util);
    assert.ok(block, "could not find HELP_TEXT in js/util.js");

    const keys = [...block[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]);
    assert.ok(keys.length > 10, `expected the help entries, found ${keys.length}`);

    const orphans = keys.filter(
      (k) => !html.includes(`id="${k}"`) && !html.includes(`data-help="${k}"`),
    );
    assert.deepEqual(
      orphans, [],
      `HELP_TEXT entries that name no element, so the text can never be shown: ${orphans.join(", ")}`,
    );
  });
});
