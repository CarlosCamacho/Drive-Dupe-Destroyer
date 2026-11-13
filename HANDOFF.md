# Current Baton Pass
- **Current State:** `main` is at v14.8.5 (`1c40b0a`). There is no build step; `npm test` (509 tests) and the service-worker precache check pass on Node 20 and 22. Recent commits: one-click Trash with Undo (v14.8.4), phone layout fixes (v14.8.3), and a service-worker fix so a new version is checked for on every page load (v14.8.5).
- **Immediate Next Step:**
  - Confirm in a real browser that opening the live site from a plain link picks up the newest version; so far only unit tests and fake-Drive browser checks cover the update flow.
  - Decide whether Trash Selected and Process Queue should also stop asking before trashing (a per-file Trash is already one click, with Undo).
- **Dead Ends / Do Not Repeat:**
  - Release tags `v14.8.1` and `v14.8.4` cannot be deleted or moved: they belong to immutable GitHub releases and `git push --delete` fails with GH013. Only GitHub Support can remove them. Use a new version number instead.
  - The cloud container's default Git identity is not the repo owner. Set the owner's name and email before committing, or GitHub adds a `Co-authored-by` line when a PR is squash-merged.
- **Verification:** Run `npm test && python3 tools/gen_precache.py --check` and confirm zero errors before committing.
