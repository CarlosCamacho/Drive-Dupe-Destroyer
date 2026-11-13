# Project & Agent Instructions

## Toolchain & Verification
- **Project Type & Stack:** Static browser app (Google Drive duplicate-image finder), not a CoCo project. Dependency-free vanilla JS ES modules in `js/`, no build step, served as-is by GitHub Pages. Node >=20 `node:test` suite in `test/`, Playwright browser checks in `tools/*.mjs`, Python helpers (`serve_secure.py`, `tools/gen_precache.py`).
- **Build & Test Command:** `npm test && python3 tools/gen_precache.py --check` (exactly what CI runs on Node 20 and 22). Also syntax-check: `for f in js/*.js sw.js; do node --check "$f"; done`
- **Emulator Verification:** For CoCo binaries, test changes in `xroar-dev` (`~/.xroar`) before marking a task complete. (N/A in this repo: no CoCo code.)
- **CoCo Hardware Corpus:** For any 6809/6309 assembly, GIME, VDG, SAM, PIA, BASIC, or disk work, read from `$HOME/CoCo-Skills` (pre-installed by the container setup script—do NOT re-clone if that folder exists). Only if `$HOME/CoCo-Skills` is missing, run `gh repo clone CarlosCamacho/CoCo-Skills "$HOME/CoCo-Skills" -- --depth 1` (or construct the standard GitHub HTTPS clone URL for `CarlosCamacho/CoCo-Skills`). Start with `coco-router/SKILL.md` and load only the specific child skill files needed for this task.

## Standing Rules
- **CoCoSDC Required:** Every CoCo program must support CoCoSDC (and DriveWire via DSKCON) and must never hang on a machine without a disk controller, unless explicitly excluded. (N/A in this repo.)
- **Hardware Discipline:** Preserve Direct Page (`DP`) state across interrupts/subroutines and strictly respect 8KB MMU bank boundaries. (N/A in this repo.)
- **Context Hygiene:** Keep edits focused strictly on the assigned task. Do not refactor or rewrite unrelated files.
- **Releases:** A version bump touches `js/util.js`, `sw.js`, `package.json`, `index.html`, the README badge and `CHANGELOG.md`. After adding or removing a `js/` module, run `python3 tools/gen_precache.py`. Release tags are immutable on GitHub: never push one until the version is final.
- **Authorship:** Commits are authored by the repo owner (copy `git log -1 --format='%an <%ae>' origin/main`). Never add `Co-Authored-By` or other AI-attribution lines.

## Mandatory Session Handoff Rule
- Before ending your session, closing out, or opening a PR, you MUST overwrite `HANDOFF.md` in the repo root (strictly under 35 lines) with:
  1. Current branch/commit status and what builds cleanly
  2. Immediate next backlog task
  3. Dead ends / failed approaches tried in this session that must not be repeated
- Always include the updated `HANDOFF.md` in your commit/PR.
