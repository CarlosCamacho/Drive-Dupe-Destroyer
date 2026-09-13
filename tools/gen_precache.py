#!/usr/bin/env python3
# Drive Dupe Destroyer (DDD) — tools/gen_precache.py
#
# Copyright (c) 2026 Carlos Camacho
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Regenerate (or verify) the PRECACHE list in sw.js from the contents of js/.

The list was hand-maintained and drifted in both directions: nine modules the
app statically imports were missing — so an offline load fetched the shell from
cache and then failed on the first missing import — while two files nothing
imported were still being precached.

Usage:
    python3 tools/gen_precache.py            # rewrite sw.js in place
    python3 tools/gen_precache.py --check    # exit 1 if the list is stale (CI)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(ROOT, "sw.js")
JS_DIR = os.path.join(ROOT, "js")

HEADER = """// PRECACHE is generated from the contents of js/ — see tools/gen_precache.py.
// It was hand-maintained and had drifted in both directions: nine modules the
// app statically imports were missing (so offline loaded the shell and then
// failed on the first missing import), while two files nothing imported were
// still listed. Regenerate with `python3 tools/gen_precache.py` after adding or
// removing a module; CI fails if the list is stale."""

SHELL = ["./", "./index.html", "./styles.css"]


def build_block():
    mods = sorted(f for f in os.listdir(JS_DIR) if f.endswith(".js"))
    lines = [f'  "{p}",' for p in SHELL]
    lines += [f'  "./js/{m}",' for m in mods]
    return HEADER + "\nconst PRECACHE = [\n" + "\n".join(lines) + "\n];"


def main():
    check = "--check" in sys.argv
    src = open(SW, encoding="utf-8").read()

    m = re.search(r"(?:^//[^\n]*\n)*const PRECACHE = \[.*?\];", src, re.S | re.M)
    if not m:
        print("error: could not locate the PRECACHE block in sw.js", file=sys.stderr)
        return 2

    wanted = build_block()
    if m.group(0).strip() == wanted.strip():
        print("PRECACHE is up to date.")
        return 0

    if check:
        print(
            "error: sw.js PRECACHE is stale. Run `python3 tools/gen_precache.py` "
            "and commit the result.",
            file=sys.stderr,
        )
        return 1

    open(SW, "w", encoding="utf-8").write(src[: m.start()] + wanted + src[m.end():])
    print("PRECACHE regenerated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
