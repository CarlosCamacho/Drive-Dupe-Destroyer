# Changelog

All notable changes to **Drive Dupe Destroyer** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/).

> The detailed, original per-version notes are archived in
> [`docs/changelog/`](docs/changelog/). This file is the consolidated summary.

## [14.7.4] - 2026-09-14

### Fixed

- **Crop detection did nothing either** (#86) — the same class of bug as #84,
  which I should have caught in that pass. `packEntries` carried five optional
  fields; the comparators in `common.js` read six. `cropHashes` was the one
  missing, so `bestCropDist` returned `Infinity` for every pair in the worker
  and the crop branch could never fire.
- **And ticking "Crop detection" on its own could not find a candidate.** A crop
  shares no dHash bands with its original — that is the premise of the feature —
  so `runMatching` widens the candidate set using colour and edge similarity.
  That widening was gated on colour matching being ticked *as well*, and the
  histograms it needs were computed only in that case. The widening now runs
  whenever crop detection is on, and the histograms are computed to match.
  `withColorMatch` keeps its meaning: it still decides whether a crop match is
  verified against the histograms.

  Measured on a photo and a crop of it (dHash 86 bits apart, crop hashes exact):
  1 group with everything present, 0 through the worker payload, 0 with crop
  detection alone. All three now find it.

### Changed

- `OPTIONAL_ENTRY_FIELDS` is the single list `packEntries` and `unpackEntries`
  both drive off, so adding a field to the hasher and forgetting the transport
  is one edit rather than two.
- `test/matcher-transport.test.js` (was `phash-plumbing`) now reads `common.js`
  and asserts that **every** field a comparator reaches for on an entry is
  carried by the payload. That is the check that would have caught both #84 and
  #86 from a single file.
- `tools/matcher-parity.mjs` gains a crop-detection parity pass through a real
  worker, with a control proving the fixture is not matching on dHash.
- Crop detection now costs more: full-resolution downloads (already the case),
  plus the colour and edge histograms, plus the bounded candidate walk. It
  previously cost nothing because it did nothing.

## [14.7.3] - 2026-09-14

### Fixed

- **pHash mode did nothing at all** (#84). The hasher writes `pHashBits` and
  `bestDistWithPHash` reads `pHashBits`, but the worker payload carried
  `pHash` — a field nothing set and nothing read. Every entry arrived in the
  match worker with no pHash, so the `withPHash` branch fell straight through
  to the plain dHash distance. Since #75 moved matching into a worker, that was
  the only path a scan took. Measured on a pair 12 dHash bits apart with
  identical pHash: 1 group before the pack, 0 after it.
- **The hash cache dropped pHash too.** `pHashBits` was written on every save
  since the feature shipped and never read back, so a cache hit silently
  downgraded the file to dHash-only even on the main-thread fallback. And with
  no `needsPHash` recompute check beside the existing `needsCrop` /
  `needsColor` ones, turning pHash **on** after a scan had already cached a
  file never recomputed anything — the feature could only ever apply to files
  being hashed for the first time.

### Changed

- `tools/matcher-parity.mjs` now checks worker/main-thread parity **with the
  optional fields present**, through a real worker. The existing run carried
  none, which is why it agreed on both paths for four releases while pHash was
  being dropped in transit.
- The hash-cache decision and the cache-hit entry rebuild are now
  `cacheRecordNeedsRecompute()` and `entryFromCacheRecord()`, so both are
  covered by `npm test` rather than only reachable through a full scan.

## [14.7.2] - 2026-09-14

### Fixed

- **A queue run that stopped part-way lost every deletion it had already
  made** (#81). `batchTrash` works in chunks of 100 and re-checks the token at
  each chunk boundary — outside the `try`. When that check failed, the whole
  function threw and took `results` with it, so `processQueue`'s `catch`
  skipped the undo record, the queue cleanup and the `ddd:trashed` event for
  files that really were in Drive's trash. Measured on 250 queued files with
  the session expiring after the first batch: 100 files trashed, 250 still
  shown in the queue, 0 recoverable by Undo. Any error that stops a run now
  carries what it already did, and the queue settles on it before reporting the
  failure.
- **The per-file fallback kept going after the session was gone**, issuing a
  doomed PATCH — and a fresh doomed sign-in attempt — for every remaining file:
  204 attempts across a 100-file chunk, against 4 now.
- **"Already gone" was decided by searching the error message** for `404`, and
  that message embeds 200 characters of Drive's error body. A 403 naming a file
  whose ID contains `404` was reported as trashed and dropped from the queue
  while the file was still in Drive. Both the trash fallback and Undo's restore
  loop now read the status `driveFetch` already attaches.
- **Sign Out did not stick while a token request was in flight** (#82). The GIS
  callback still wrote into the module state `signOut()` had just cleared, so
  the app signed itself back in a moment later with a live, unrevoked token
  behind a UI that said "Sign In". Measured: token `null` at sign-out, present
  again 700 ms later. A generation counter now makes a stale callback decline
  the token and hand it back to Google instead.
- `ensureToken` no longer drops `code: "AUTH_TIMEOUT"` when it rewrites the
  timeout message, and a superseded token request no longer clears the
  single-flight slot belonging to the request that replaced it.

## [14.7.1] - 2026-09-14

### Fixed

- **A repeat scan re-resolved every folder path over the network, every time.**
  The end of a scan cleared the folder-path cache from browser storage — so
  every path worked out during a scan was deleted the moment it finished, and
  the cache it wrote had never once been read back.

  Three things showed this was not intended: a memory-only version of the same
  function already existed and was never called, every write stamped a
  timestamp, and the store had a timestamp index created "for cleanup" that
  nothing read. The design was persist-and-expire; what shipped stamped the
  timestamp, indexed it, ignored it, and wiped everything after each scan.

  Paths now survive between scans, and stale ones expire after two weeks —
  which is what the timestamp was for. A path goes out of date when you move a
  file in Drive, and the folder is what the "keep by folder priority" rule ranks
  on and what the CSV reports as a file's location, so letting them persist
  forever would trade one bug for another. **Clear cache** still empties them
  on demand.
  ([#79](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/79))

## [14.7.0] - 2026-09-14

### Added

- **The crop tool remembers your selection between images.** Cropping the same
  region out of a run of pictures meant drawing the same rectangle by hand every
  time. The area now carries over to the next image, with a note saying so and a
  way to clear it. On by default; the toggle sits next to the fixed-size
  controls and your choice is remembered.

  The area is stored as **fractions of the picture, not pixels**. The canvas is
  scaled to fit your window, so pixels from one image land somewhere arbitrary
  on the next. Fractions mean "the same part of the picture" — which for a run
  of same-size images, the case this is for, is the identical rectangle, and for
  differently sized ones maps proportionally.

  Nothing is ever cropped without pressing **Crop**, and the restored rectangle
  is drawn on screen first, so a remembered area is always visible and
  adjustable before it is used. An area that does not fit is clamped rather than
  discarded, tiny selections are never remembered, the existing fixed-size lock
  keeps priority, and the area survives zoom and rotate.
  ([#77](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/77))

### Fixed

- **The `drive.file` scope probe could have given the wrong answer, in the
  expensive direction.** Google's own API description — fetched from the
  discovery document, revision 20260904 — lists `drive.file` among the scopes
  `files.list` accepts, and describes it as *"only the specific Google Drive
  files you use with this app"*. So under that scope the call is **permitted**
  and returns only files the app was granted: a folder whose contents were never
  picked answers with HTTP 200 and an empty list, not an error.

  The probe counted a successful call as access. It would therefore have
  reported **"drive.file is sufficient"** for precisely the result that proves
  it is not — and acting on that means a migration that cannot scan anything. It
  now distinguishes "permitted but empty" as its own verdict, says what an empty
  folder would mean, and the verifier covers both new cases. Confirmed against
  the previous version, which fails them.
  ([#28](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/28))

## [14.6.1] - 2026-09-14

### Fixed

- **A blocked database upgrade froze the whole app.** `openDb()` settled only on
  success or error; the `onblocked` event — which fires when another tab holds
  the database at an older version — only wrote a console line. If that tab
  never closed, neither success nor error ever fired and the promise stayed
  pending forever. Every database call begins by awaiting it, so this did not
  degrade the app, it stopped it: the scan froze mid-phase with nothing shown to
  the user.

  Measured as **still pending after three seconds**, resolving the instant the
  holding connection closed. It now says which tab is at fault and what to do,
  and gives up after ten seconds rather than hanging — a scan without the hash
  cache is slow but correct, a frozen one is neither.

  This would not have bitten anyone today, since the schema version has been
  stable. It would have bitten on the next version bump, and then only people
  who keep two tabs open — which is exactly what you do during a long scan.
  ([#76](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/76))

- The service worker rebuilt its known-asset set on **every** request — around
  thirty URL constructions and a `Set` for a value that never changes.
  ([#76](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/76))

## [14.6.0] - 2026-09-14

### Changed

- **Matching is 21x faster, and no longer runs on the UI thread.** The loop that
  decides which files are duplicates held the main thread, handing control back
  every 8 milliseconds. It now runs in a worker, falling back to the same code
  in-process where a worker cannot start.

  The speedup turned out to have almost nothing to do with the worker. Porting
  it forced the phase to be measured properly, and that exposed the real cost:
  every flush of results to the live view walked every scanned id to rebuild the
  groups, and flushing every 25 matches meant roughly 1,900 flushes across
  12,000 images — about 23 million operations, dwarfing the image comparisons
  themselves. Flushing on a 250ms budget makes that proportional to elapsed time
  instead of to how many duplicates the library happens to contain:

  | 12,000 images | before | after | |
  |---|---|---|---|
  | main thread | 15,195ms | 713ms | 21x |
  | worker | 11,721ms | 513ms | 23x |
  | worst frame gap | 58ms | 20ms | |

  The grouping is identical in every case. The worker is worth about 1.4x on top
  of that, and a noticeably freer interface while a scan runs.

  Two wrong turns on the way, both caught by measuring rather than reasoning.
  The first port was **7x slower** — handing thousands of hash objects to a
  worker costs more in serialisation than the matching it offloads, so they are
  packed into flat buffers now and transferred without copying. The second was a
  flaw in the benchmark rather than the code: the main-thread side was not given
  the same callbacks, so it skipped the flush work entirely and made the worker
  look 20x slower when it was in fact faster.
  ([#69](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/69))

### Added

- `js/matcher.js` — the matching core as one module with no interface
  dependencies, shared by the worker and the fallback so the two cannot drift
  apart, and eleven tests pinning its behaviour that were written **before** the
  port rather than after it.

- `tools/matcher-parity.mjs`, `tools/matcher-bench.mjs` and
  `tools/matcher-fallback.mjs` — the harnesses behind the figures above.

## [14.5.0] - 2026-09-14

A pass over everything open: the five UI issues you filed, plus ten performance
and usability findings from reviewing the hot paths. Every figure below was
measured, not estimated.

### Added

- **The results table sorts.** Name, Folder, Dims and Size are clickable; a
  second click reverses, a third returns to the order matching produced. Groups
  move as units — sorting rows independently would shred the groups the table
  exists to show — and **Size** means the space a group's *duplicates* would
  free, which is the number worth triaging by and did not exist as a column
  before. ([#70](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/70))

- **Search over file name and folder path.** Results could previously only be
  narrowed by similarity, which is the one axis already chosen before the scan.
  Matching applies at group level: hiding the siblings of a matched file would
  leave a lone row with nothing to compare against.
  ([#72](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/72))

- **Keep this one instead.** The keeper came from a global rule with no
  per-group override, so a rule right for 95% of groups and wrong for one left
  only bad options. Each duplicate row now has a pin; the keeper shows whether
  the choice came from the rule or from you, and can release it.
  ([#73](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/73))

- **The sidebar starts collapsed**, and remembers which sections you open.
  ([#59](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/59)) Section
  headers have Lineicons glyphs that follow the theme — white in dark mode, blue
  in light — where emoji could not
  ([#60](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/60)), and an
  expand/collapse chevron drawn in CSS
  ([#62](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/62)).

- Help popovers for the eight controls that had none, and a CSP parity test
  pinning the policy's three copies together.
  ([#63](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/63))

### Fixed

- **The crop+colour matching path did up to 10x more work than it needed to, on
  the main thread.** It scanned 2,000 array neighbours in each direction per
  image — and over an ordering that had nothing to do with similarity, so two
  crops of one photo 3,000 apart were never compared while 4,000 unrelated
  images were. It now sorts by the luminance signature the pre-filter reads and
  walks only the plausible run:

  | images | before | after | |
  |---|---|---|---|
  | 2,000 | 3,998,000 | 619,195 | 0.15x |
  | 5,000 | 15,995,000 | 1,885,919 | 0.12x |
  | 10,000 | 35,990,000 | 3,896,481 | 0.11x |
  | 20,000 | 75,980,000 | 7,905,378 | 0.10x |

  It also improves with scale rather than degrading.
  ([#65](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/65))

- **Rendering a row could erase a file's folder path.** `_path` was overwritten
  unconditionally from the path map, so a row whose id was missing from that map
  lost an already-resolved path. That is what folder-priority keep selection
  ranks on and what the CSV reports as a file's location.

- **Hashing left workers idle or queued them up.** Concurrency was a flat 6
  chosen with no reference to the worker pool, so an 8-core machine ran 7
  workers for 6 slots and a 4-core machine queued 6 tasks behind 3. It is
  derived from the pool now, and AIMD's ceiling no longer climbs to 12 against
  as few as 2 workers.
  ([#66](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/66))

- Minimum image size defaults to 50 KB rather than 0 MB, and the unit selects
  are remembered.
  ([#61](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/61))

- "Select All" is now "Select all duplicates" — it never selected keepers, and
  the old name made a safe action sound dangerous.
  ([#71](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/71))

- Ancestor lookups during path resolution are batched a level at a time instead
  of one request per folder.
  ([#68](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/68))

### Removed

- `js/shared-worker-pool.js` — 666 lines whose pool was instantiated only inside
  its own factory, which nothing called, while the real hashing pool lives in
  `hashing.js`. The same shape as the WASM module removed in 14.3.0.
  ([#64](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/64))

### Changed

- The "delta scan" checkbox now says what it does. It never fetched *only*
  changed files — by the time it runs the folder listing is already complete —
  so it reconciles at the edges and saves no round trip.
  ([#67](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/67))

### Known

- The pair-matching loop still runs on the main thread with cooperative
  yielding. Moving it into a worker is real work and touches the code that
  decides which files are duplicates, so it is tracked rather than rushed:
  [#69](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/69).

## [14.4.0] - 2026-09-14

### Fixed

- **The side-by-side view only ever showed two files from a group.** It paired
  the keeper with `group.find(f => f.id !== keep.id)` — the *first* other member
  — and every remaining file was silently skipped. Reaching the end then
  reported **"All groups processed!"**, which reads as having seen everything. A
  cluster of five near-identical shots was reviewed as one pair.

  Groups of more than two are not an edge case; they are the normal shape of the
  problem this app solves — a burst of phone photos, or one image exported at
  several sizes. Measured on a group of five plus a group of two, the old
  behaviour reached **1 of 4** members before jumping to the next group.

  Navigation is now two-dimensional. Prev/Next and the ← → keys step one *pair*
  at a time and roll into the neighbouring group at either end, so walking the
  view visits every member. A counter in the header reads `Group 1 of 2 · pair 2
  of 4`, and Next now hides only once everything really has been seen. Walking
  back retraces the forward path exactly, including across a group boundary,
  rather than restarting a group. Deleting a file keeps your place instead of
  replaying pairs already dealt with, and entering from a row's **Compare**
  button syncs the cursor to the file you clicked.
  ([#55](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/55))

- **`var(--border)` was referenced but never defined.** `styles.css` defines
  `--border-color`; one rule reached for a bare `--border`, so the crop editor's
  footer separator rendered in `currentColor` instead of the border colour. Same
  bug class as the `--accent` fix in #51, which I made without sweeping for
  other instances — a full sweep of all 24 referenced custom properties now
  shows every `var()` resolving. The two remaining `var(--border-color,
  var(--border))` uses are harmless: the fallback never fires.
  ([#57](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/57))

### Added

- **The app now honours your operating system's light/dark setting.** The theme
  had two states and defaulted to dark, so a light-desktop user got a dark app
  until they found the toggle. It has three now: stored `dark`, stored `light`,
  or *absent* meaning follow the OS — and absence is written back as absence, so
  a user who toggles away and back can still return to following the system.
  Changing the OS setting mid-session is picked up without a reload.

  The preference is honoured in **CSS**, not only in JavaScript. The theme is
  resolved from IndexedDB, which is async, so a light-desktop user would
  otherwise see the dark palette flash first — and an inline `<head>` script to
  pre-empt that is impossible, since `script-src` carries no `'unsafe-inline'`.
  Verified in a real browser at both OS settings: first paint is already
  correct, an explicit choice overrides the OS in both directions and survives a
  reload, and the toggle's tooltip says which mode you are in.
  ([#56](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/56))

- **`test/theme-parity.test.js`.** The light palette is now declared twice — once
  for the toggle, once inside the media query — which is the price of a correct
  first paint. This fails if the two copies drift, which a comment saying "keep
  these in sync" would never have caught.

### Removed

- `.btnMiniDangerKeep` and `.modalWide`, two CSS rules nothing applied.
  `.btnMiniDangerKeep` looked like it might be an unfinished intention rather
  than dead weight, so it was checked rather than assumed: `render.js` applies
  `btnDangerKeep`, which has its own rule (a dashed border) and supersedes it.
  ([#57](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/57))

## [14.3.0] - 2026-09-14

### Removed

- **The WebAssembly hashing module, which could never run.** `js/wasm-hash.js`
  advertised a "2-3x speedup" across 566 lines. `initWasm()` fetched
  `./dhash.wasm` — a file that was not in the repository, had never been in its
  history (`git log --all -- "*.wasm"` is empty), and that no build step, npm
  script or tool produced. Measured in the browser: `isWasmAvailable()` returns
  `false`, so the guarded fast path never executed and every image had always
  gone down the worker path.

  Removed rather than completed. Finishing it would have meant committing a
  binary, adding a build step, and — not optionally — a test asserting the two
  paths produce *byte-identical* hashes, because without one they drift and
  reproduce #42, where whether two files matched depended on which code path
  happened to hash them. There is already a latent instance of exactly that in
  the removed code: `jsResizeGrayscale` divided by `dstWidth` where it needed
  `dstWidth - 1`, cropping the right column and bottom row before hashing.

  Three telemetry rows reporting a WASM-versus-JS split are now one "Images
  hashed" count. There was never a split, and "WASM active: ✗ No" read as a
  browser limitation rather than a missing file. The service worker no longer
  precaches the module.

  `HASH_VERSION` is deliberately **unchanged at 3** — removing unreachable code
  must not invalidate anyone's cache. Verified through the real worker after the
  removal: a transparent PNG still measures 0 against its white-flattened copy,
  and genuinely different backgrounds still measure 25 apart.
  ([#47](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/47))

### Added

- **`tools/scope-probe.verify.mjs`** — verifies `tools/scope-probe.html` without
  Google credentials. That probe gets run once, by hand, with real credentials,
  and its verdict decides whether DDD can drop the restricted `auth/drive` scope
  ([#28](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/28)), so a
  wrong verdict would be both expensive and unobvious — and the probe had never
  been executed at all. This drives all four outcomes against a stubbed Picker
  and a stubbed Drive endpoint and checks the conclusion each time. Only the
  transport is faked; the logic under test is the shipped file. All four paths
  reach the right verdict.

  Not part of `npm test`, which is deliberately dependency-free `node:test`;
  this needs Playwright and a running server.

## [14.2.2] - 2026-09-14

Accessibility and theming pass over `styles.css`, the last unreviewed file in
the repository. Everything below was measured in the running app, in both
themes, before and after.

### Fixed

- **A `--accent` variable that was never defined.** `styles.css` defines
  `--accent-blue`, `--accent-green`, `--accent-red` and `--accent-yellow`, but
  eight rules reached for a bare `var(--accent)` with no fallback. An undefined
  custom property makes the whole declaration invalid at computed-value time, so
  `background: var(--accent)` resolved to transparent and
  `border-color: var(--accent)` to `currentColor` — silently. The active zoom
  level, the lock toggle's "on" state and the icon buttons' hover all lost their
  fill while keeping `color: #fff`, which in light theme put white glyphs on an
  `#e8e8e8` panel at **1.23:1**: the icon disappeared exactly while you pointed
  at it. Now 5.02:1 in both themes.
  ([#51](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/51))

- **The focus indicator was suppressed on a third of the keyboard-reachable
  controls.** A global `*:focus-visible` outline existed, but
  `.formRow input:focus` and `.fixedSizeInput:focus` beat it on specificity and
  set `outline: none`, offering a border tint in its place — which a native
  checkbox and select simply ignore, and which in the second rule used the
  undefined `--accent` above, so it supplied nothing at all.

  Measured by Tab-walking the page (so `:focus-visible` genuinely matches),
  against a control run with the stylesheet disabled: **7 of 24** reachable
  controls had no visible focus, including Recursive, Use database and Keep rule
  — the controls that decide what a scan does and which file it keeps. Now
  **0 of 24**. Keyboard navigation is a documented feature of this app, so this
  mattered more here than it would elsewhere.
  ([#51](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/51))

- **Text below the WCAG AA contrast floor.** Walking every visible text-bearing
  element and resolving each one's actual painted background found **7 failures
  in dark theme and 6 in light**. `--text-muted` carried the hint text under the
  controls at 2.79:1 against the darkest surface — less than half the required
  4.5:1 — and white on `--accent-red` measured 3.62:1 on **Trash Selected** and
  **Clear & Reload**, the two controls in the app that destroy something.

  `--text-muted` is now `#9a9ab0` (dark) and `#666666` (light); `--accent-red`
  is `#d62b52` with `#bf1f43` for hover. Dark went 7 → 1 and light 6 → 0. The
  one remaining is `#btnUndo`, which is `disabled` in the markup — WCAG exempts
  disabled controls, and it is listed here only so the figure is not mistaken
  for a real failure.
  ([#52](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/52))

- **Icon buttons were invisible at rest in light theme.** `.btnIcon` took its
  background from a theme variable and hard-coded `color: #fff`, so in light
  theme it painted white on `#e8e8e8` — 1.23:1 — and only became visible on
  hover. It follows the theme now. This was the only rule in the file with that
  shape; the three other hard-coded `#fff` declarations sit on an accent fill,
  where white is correct.
  ([#52](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/52))

### Added

- **`prefers-reduced-motion` support.** The file had none, while two elements
  (`.spinner`, `.collecting-dot`) animate continuously for the whole length of a
  scan. Animations now run once and transitions collapse to instant, so `:hover`
  and `:focus-visible` still change appearance — the motion goes, the meaning
  stays. Verified: `0.8s x infinite` becomes `1e-05s x 1` under the preference.

### Known

- `styles.css` has no `prefers-color-scheme` block: the theme defaults to dark
  and ignores the operating system's setting until the user toggles it by hand.
- `.btnMiniDangerKeep` and `.modalWide` are rules nothing uses.
- Checked and fine: the page does not scroll sideways at 390px
  (`scrollWidth 390 === clientWidth 390`), and `index.html` has no duplicate
  `id` attributes across its 153 of them.

## [14.2.1] - 2026-09-14

### Fixed

- **A saved "Max images" or "Page size" was silently ignored.** Both sliders are
  indexes into a lookup table, and the real value lives in a `data-` attribute
  that only the slider's own `input` handler writes. Restoring a setting
  assigned `.value` without dispatching any event, so the attribute kept the
  HTML default — and the scan reads the attribute. A restored limit of 5,000
  images was therefore scanned as **unlimited**, and a restored page size of 100
  as 500, while the sliders sat exactly where the user had left them and the
  readout beside them contradicted the handle. Restoring a setting now
  dispatches the same events a real interaction would, after every control holds
  its value, so no handler sees a half-applied mixture of saved and default
  state. ([#44](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/44))

- **Escape closed a dialog and threw away your deletion selection.** Escape had
  two independent owners: every modal closed itself, and the keyboard handler
  clicked "Select none" with no idea whether anything was stacked on top. One
  keypress dismissed the About box and discarded a selection that has no undo.
  Escape now clears the selection only when no modal is open, and closing the
  last one hands the shortcut back. The folder picker's search box also stops
  the key from bubbling, so clearing a search no longer closes the whole picker.
  ([#45](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/45))

- **A momentary failure permanently corrupted folder paths.** Two faults
  compounded in `paths.js`. Parent-folder lookups cached the *promise*, so a
  single 500 or dropped connection cached the **rejection** for the life of the
  page — every later file beneath that folder gave up instantly without
  retrying. And a walk that ended on an error, or on the depth cap, wrote its
  truncated result to the durable on-disk cache as though it were correct, so a
  file in `/My Drive/Photos/2019/Hawaii` was recorded as `/Hawaii` forever.
  Pressing **Stop** triggered exactly that, for every file whose lookup was in
  flight: an abort landing mid-request arrived in the error branch rather than
  the abort guard.

  That is not cosmetic. The folder path is what folder-priority keep selection
  ranks on, so a truncated path changes which file the app offers to delete, and
  it is what the CSV and JSON exports report as a file's location. Failed
  lookups are now evicted so they can be retried, an incomplete walk is returned
  for display but never cached, and an abort re-throws instead of persisting a
  half-finished answer.
  ([#46](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/46))

- **Folder picker: a hostile folder name, a 500-subfolder ceiling, and a dead
  readout.** A folder's name was interpolated into an `aria-label` without
  escaping — while the same name was escaped in the element right beside it.
  Anyone can share a folder with you and name it whatever they like, and a
  crafted name injected an element into the page. It was *not* exploitable:
  the CSP that `security.js`, `sw.js` and `serve_secure.py` each independently
  apply blocks inline handlers in every configuration tested, including with the
  service worker disabled. The name is escaped now regardless; a CSP is the wrong
  last line of defense to be relying on, and the unescaped name also corrupted
  what a screen reader announced.

  Listing subfolders requested a page token and discarded it, so a folder with
  more than 500 subfolders was silently truncated — and **Include All** then
  acted on 500 of N while reporting a count that read as completeness. It now
  follows the token, and says so if it ever hits its own ceiling. The folder ID
  going into the query is validated the way `scan.js` already validates it.

  The aspect-tolerance slider's readout was wired to nothing and sat at 20
  forever, however far you dragged it.
  ([#48](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/48))

- **The side-by-side view kept a different file than the list and the export.**
  `compare.js` carried its own private copy of the keep-selection logic, and it
  had drifted from the shared one in four ways: under the "hires" rule it
  compared a byte count against a pixel count, so a 5 MB file Drive gave no
  dimensions for beat a known 800×600 original; the folder-priority term was
  matched against the opaque parent ID and against the file's own name, so
  `originals` matched a file called `originals-backup.jpg` sitting in
  `/Downloads`; an unrecognised rule silently kept whichever file came first;
  and genuine ties were broken by array order, which comes from union-find
  iteration and is not stable between runs. On the same group, all four cases
  picked a different file from the list and the CSV export.

  The consequence was not only a confusing badge. The compare view hard-coded
  the LEFT pane as the keeper, so whenever the copy disagreed, the file the rest
  of the app wanted kept sat on the right — where `rightIsKeep` was `false` and
  the "⚠️ deleting the KEEP file" warning is disabled. Deleting it was undoable,
  but nothing said anything had happened.

  The copy is gone; the keeper is decided in `common.js` alone. Which pane holds
  it is now derived from that one decision rather than asserted by the caller,
  which also fixes the crop editor's return path — it passed `group[0]` and
  `group[1]` in whatever order they happened to be in and labelled the left one
  KEEP regardless. A source-level test now fails if any module reimplements the
  rules privately again.
  ([#50](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/50))

### Known

- The side-by-side view shows only two members of a group. For a cluster of
  three or more near-identical images it pairs the keeper with the first other
  file and ignores the rest, then reports "All groups processed!" — which reads
  as having seen everything. Noted in
  [#50](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/50); it
  needs a decision (cycle through pairs, or show N panes) rather than a patch.

- The WebAssembly hashing path has never been able to run: `js/dhash.wasm` is
  not in the repository, has never been in its history, and nothing builds it.
  So `wasm-hash.js` always falls back to its JavaScript implementation and the
  telemetry panel always reports "WASM active: ✗ No", which reads as a browser
  limitation rather than a missing file. Tracked in
  [#47](https://github.com/CarlosCamacho/Drive-Dupe-Destroyer/issues/47), which
  needs a decision — ship the binary and a build step, or delete the module —
  rather than a patch.

## [14.2.0] - 2026-09-13

### Fixed

- **Transparent images never matched their flattened copies.** Hashes were
  computed on a transparent canvas, and transparent pixels read back as black —
  so a PNG with a transparent background hashed as though it were on black,
  while the same picture saved as JPEG hashed as white. Measured on an identical
  drawing rendered both ways, the two were 22 apart out of 144; the loosest
  sensitivity setting only accepts 20, so **the pair could not match at any
  setting**.

  This is one of the most common ways a real duplicate arises: JPEG has no
  transparency, so every PNG→JPEG export produces exactly this pair. Images are
  now composited onto white before hashing, which is the conventional base for
  perceptual hashing. The same pair now measures 0, while two images that
  genuinely differ in background still measure 22 — background information is
  normalised, not discarded.

  Minor version bump because this changes which files are reported as
  duplicates. Cached hashes are recomputed automatically on the next scan.

## [14.1.4] - 2026-09-13

### Fixed

- **The LSH Mode dropdown did nothing.** Loose, Normal and Strict all produced
  the same internal configuration, so choosing one had no effect on results.
  This setting controls which image pairs get compared at all, so it is the one
  the troubleshooting table points at for "too few matches" — and it was inert.
  Each mode now behaves as labelled, with an unrecognised value falling back to
  Normal rather than failing.

## [14.1.3] - 2026-09-13

Two bugs found reviewing modules that earlier releases never looked at.

### Fixed

- **CSV/JSON export marked every file as a duplicate.** It read three properties
  — `_isKeep`, `_matchDist` and `_matchType` — that nothing in the app ever set.
  The keep-file lookup returned -1, so *no* row was labelled KEEP, and the
  similarity column was always empty. Anyone using an export to decide what to
  delete would have removed the originals along with the copies. The export now
  derives the keep file and the similarity exactly the way the results table
  does, so the two cannot disagree. The percentage also honours the configured
  hash size instead of assuming 12×12, which overstated similarity by roughly
  2.25× on the 8×8 setting.
- **The trash queue recorded no undo.** 14.1 claimed undo covered every delete
  path; it covered four of five. The queue — the bulk path, and the one the undo
  code was designed around — was missed. Trashing files from it now records an
  undo entry like everywhere else.
- **Escape now closes the queue window.** The key handler was attached to the
  window element itself, which never receives key events, so the key did
  nothing.
- The queue stored an always-empty folder path for each file.

## [14.1.2] - 2026-09-13

Two regressions introduced by 14.1 itself, found in a review of that release.

### Fixed

- **A few unreadable images no longer collapse scan throughput.** Wiring up the
  adaptive throttle in 14.1 called it on every per-file failure. The controller
  halves concurrency unconditionally, so a Drive containing a handful of corrupt
  or undecodable images dragged the whole scan down to one file at a time — and
  climbing back needs five consecutive successes per step. Backoff is now
  limited to signals that actually mean Drive is under pressure: rate limiting,
  server errors, network failures and timeouts. A file the browser cannot decode
  says nothing about how hard we are hitting the API.
- **Delta scan's containment check no longer depends on statement order.** The
  recursive collector returned its BFS de-duplication set as "folders visited",
  but that set is seeded with the user's *excluded* folders so the walk skips
  them — so excluded folders counted as in scope. A separate guard happened to
  run first and kept files from leaking back in, but the guarantee rested on the
  order of two lines. Walked folders are now tracked separately from the
  skip-list.

### Corrected

- **The 14.1 claim that `COOP: same-origin` broke Google sign-in was wrong.**
  It was asserted from Google's documentation and never observed. Tested
  directly by restoring the old header: sign-in works. The related claim that
  `COEP: require-corp` blocked Drive thumbnails was likewise never tested and
  should be treated as an open question.

  The headers stay as they are — `same-origin-allow-popups` is documented for
  the popup flow and strictly more permissive, and not sending COEP only
  removes a restriction — but the source comments, the startup banner
  ("incompatible with Google sign-in") and this changelog no longer present
  either claim as established fact.

### Internal

- The backoff decision moved into `common.js` as `isBackpressureError`, so its
  tests exercise the real function rather than a copy that could drift from it.

## [14.1.1] - 2026-09-13

Completes 14.1. Three authentication issues were listed as fixed in the 14.1
pull request but were not actually addressed; this release fixes them.

### Fixed

- **Concurrent token requests no longer hang.** `tokenClient.callback` is a
  single mutable slot, and every caller overwrote it before calling
  `requestAccessToken`. Google fires only the last-installed callback, so when
  the token went stale mid-scan the other in-flight requests — up to sixteen,
  given the hashing and path-building concurrency — waited out their timeouts
  and failed. All callers now share one in-flight request.
- **Cancelling sign-in no longer deletes the stored Client ID.** Any failure
  used to clear it, so closing the Google popup once meant fetching the ID from
  Cloud Console again. Only errors that indicate the ID itself is wrong clear
  it now.
- **Token expiry comes from Google's `expires_in`** instead of a hardcoded 55
  minutes, so a shorter-lived token is no longer treated as valid until a
  request fails. The staleness buffer also scales down for short tokens; the
  old flat five-minute subtraction went negative below that, marking a live
  token already expired.
- A 401 now invalidates only the token the failing request actually carried.
  Clearing it unconditionally discarded a fresh token a parallel request had
  just obtained, sending every other in-flight request through a needless
  refresh.
- `signOut` clears the current Client ID and any in-flight token request, which
  were both left behind.

## [14.1] - 2026-09-13

Correctness and efficiency release. Every open issue filed against 14.0 is
addressed. The headline changes are that Undo now works at all, the logic
deciding which file to delete has been corrected, and a large scan no longer
downloads and retains every image at full resolution.

### Fixed — safety

- **Undo recorded nothing.** No delete path called into the undo stack:
  `compare.js` imported `pushUndoDelete` and never invoked it, and the
  results-table, bulk and crop paths called `batchTrash` directly. The button
  was permanently disabled. It now records every path, stores *operations*
  rather than individual files (one click restores a whole bulk delete), and
  persists to IndexedDB so a refresh no longer discards it.
- **Keep-file selection.** "Highest resolution" compared a pixel count against
  a byte count whenever Drive omitted image dimensions, so a large file with no
  metadata could beat a genuine higher-resolution original. Folder priority
  matched patterns against Drive folder IDs and file names rather than folder
  paths, and ran before paths were resolved, so it silently did nothing. Ties
  now break deterministically instead of depending on scan order.
- **Per-row delete now confirms**, matching the KEEP row.
- **Crop no longer destroys metadata silently.** It re-encoded through a canvas,
  uploaded under the original's exact name and auto-trashed the original. The
  crop is now saved as a separate `(cropped)` file, trashing the original is a
  confirmation that states what the re-encode did not carry over, and the
  uploaded file declares the type it actually is — `toBlob` silently falls back
  to PNG for formats browsers cannot encode.

### Fixed — the app running at all

- **Browser isolation headers changed** in `serve_secure.py`: COOP is now
  `same-origin-allow-popups` (the value Google documents for the sign-in popup
  flow) and COEP is no longer sent.
  > **Corrected in 14.1.2.** This entry originally said the old headers *broke*
  > sign-in and *blocked* Drive thumbnails. The sign-in claim was tested
  > afterwards and is false — sign-in works under `COOP: same-origin`. The
  > thumbnail claim was never tested. Both came from documentation rather than
  > observation. The change is still fine (it only relaxes restrictions) but it
  > fixed no observed defect.
- **Batch trash actually batches.** The parser never matched Google's
  angle-bracketed `Content-ID`, so every chunk fell back to 100 individual
  requests.
- **Non-image files are no longer downloaded.** Files Drive typed
  `application/octet-stream` passed the format filter on MIME alone, so
  archives and installers were fetched in full before failing to decode.
- **Resume actually resumes.** The prompt discarded the user's answer and ran a
  full rescan, and only cleared its state on Cancel, so it reappeared on every
  load for 24 hours. It now checkpoints the folder frontier during collection
  and restarts from it.
- **Delta scan stays in scope.** It added changed files from anywhere in Drive,
  including folders the user had excluded, and bypassed the size and Image
  Types filters entirely.

### Changed — performance

- Hashing no longer retains the downloaded image. The blob cache was bounded by
  entry count, not bytes, and the hashing and display paths shared a cache key —
  so the results table painted full-resolution originals into 44px thumbnails.
- The WASM hash path decoded at full resolution and read the pixels back twice;
  it now downsamples first. Cached hashes carry a version and are recomputed
  when the scheme changes.
- Thumbnails come from Drive's own `thumbnailLink` first, which costs no memory
  and no API quota, with the authenticated download as fallback.
- The thumbnail fast-path is probed once per session rather than attempted and
  failed per file.
- Exact duplicates found by checksum are no longer re-downloaded and re-hashed,
  and formats no browser can decode (PSD, RAW, TGA, PCX, Netpbm, JPEG 2000,
  JPEG XL) are matched by checksum instead of being downloaded to fail.
- Folder traversal makes one API call per folder instead of two.
- The adaptive concurrency throttle described in the source since v12 is now
  actually connected, so a 429 reduces global concurrency instead of making six
  workers back off and resume independently.
- Rejected pairs have their own object store; recording one no longer rewrites
  the entire collection.

### Added

- **About dialog** reachable from a new button beside Donate, with the version,
  copyright, repository link, donation prompt and a bug-report link.
- **Test suite** (`npm test`, no dependencies) and CI. Four of the bugs above
  were in pure functions a test would have caught immediately.
- Storage-quota handling: a full cache is reported once rather than silently
  ending caching, and the app requests persistent storage so the browser does
  not evict the cache and the user's rejected-pairs list without warning.

### Removed

- Dead code: `js/pool.js` and `js/phash.js`, plus an unused token store,
  hand-rolled CSRF helpers, a postMessage guard with no listener, and a
  `Permissions-Policy` meta tag that browsers ignore. Several header comments
  claimed protections that were not in effect.

### Internal

- The version lives in one constant (`APP_VERSION` in `js/util.js`) instead of
  ~56 hardcoded strings; the service worker cache name derives from it.
- The service worker precache list is generated and CI-verified — it was
  missing nine modules the app statically imports, breaking offline.

## [14.0] - 2026-06-07

### Added
- **Image Types panel** (left sidebar). Choose exactly which formats a scan
  includes via per-format checkboxes, with a **Select all** master toggle and a
  live count badge. All formats enabled by default.
- **Download or delete any image from the results table.** Every row — including
  the KEEP row — now has both a Download button and a Trash button. Deleting the
  KEEP file is allowed but asks for confirmation.
- **Clickable File Location.** The Folder cell in the results table and the path
  breadcrumb in the compare modal now open the file's containing Google Drive
  folder in a new tab.
- **Image placeholders.** A lightweight inline placeholder is shown while a
  thumbnail loads (so live scanning isn't slowed by eager thumbnail generation)
  and as a fallback for any image that fails to load.

### Changed
- The group/similarity label (`identical 100%`, `near 100%`, …) moved to a wider
  **Group / Match** column and no longer wraps.
- User manual updated to v14 (`docs/DDD-v14-Manual.docx`).

### Fixed
- Clicking the trash **icon** (not just the button edge) now registers a delete.
- Placeholder asset is a properly percent-encoded data URI (valid in strict
  parsers; never 404s).

## [12.9] - 2026

### Fixed
- **Duplicate discovery query.** v12.8 tried to find PSD/TGA/IFF/PCX with
  `name contains '.ext'` clauses; Google Drive does *prefix* matching on `name`,
  so those never matched and the bloated query could fail server-side and return
  zero files (the reported "two identical GIFs not found" symptom). Discovery is
  now MIME-based, with client-side extension filtering as the reliable narrower.
- **"Ignore" removed the wrong group** because it deleted the group twice (once
  via callback, once via event). Removal now goes through a single path.
- **"Ignore" now persists** across scans — the rejection record is reliably
  written (the live hash map is wired through to the compare modal).

### Changed
- Acting on a pair in the compare modal (delete one/both, or ignore) removes it
  from the results list so it is never reviewed twice.

## [12.8] - 2026

### Added
- Support and discovery for **PSD** (`.psd`), **TGA/Targa** (`.tga`, `.targa`),
  **IFF/ILBM** (`.iff`, `.ilbm`, `.lbm`), and **PCX** (`.pcx`).
- Filtering checks both MIME type and file extension.

## [12.7] - 2026

### Fixed
- **Foreground responsiveness during background scans.** The matching loop now
  yields the main thread time-based from inside the inner comparison loop using
  a `MessageChannel` hand-off; the compare modal shows images instantly via the
  thumbnail URL (upgrading to the authenticated blob in the background); and the
  per-flush group rebuild is now a single O(n) pass.

## [12.6] - 2026

### Fixed
- **`batchTrash` now detects per-file failures.** Google returns HTTP 200 for
  the batch envelope even when individual deletes fail; the multipart response
  is now parsed so a file that failed to trash is reported and kept in the list.

### Changed
- **Thumbnail fast-path for hashing.** Plain perceptual hashing tries a 512px
  thumbnail first and falls back to the full original on any failure, cutting
  download bandwidth.

## [12.5] - 2026

### Fixed
- **Rejection feedback actually applies now** — rejected ("not a duplicate")
  pairs are preloaded and skipped in the match loop instead of reappearing.

### Changed
- Folder paths built only for files shown in results (not every scanned image),
  saving thousands of Drive API calls on large libraries.
- Pairwise similarity memoized in the renderer; hash worker reuses canvases;
  faster rejection-key lookups; removed dead imports.

## [12.4] - 2026

### Fixed
- Implemented the missing `groupBestPct()` and `makeSimilarityBadge()` helpers
  in `render.js` (a `ReferenceError` had surfaced as a scan failure).
- Declared the missing `currentIdToEntry` in `compare.js` (fixing the rejection
  recording path / Feature #19).

## [12.0] - 2026-03

### Added
- **Security hardening for OAuth verification readiness:** new `security.js`
  (runtime CSP, Referrer-Policy, Permissions-Policy, CSRF state tokens, origin
  whitelist, in-memory token storage, DOM sanitizer, input validators); hardened
  `auth.js`, `drive.js`, `scan.js`, `app.js`, `sw.js`, and `index.html`.

### Fixed
- (12.1) CSP blocking Font Awesome fonts and the Google OAuth popup on localhost.
- (12.2) Missing `validateFolderId` import that caused all scans to fail; stale
  service-worker cache lock.

## [11.0] - 2026-03

### Added
- Persistent scan settings (IndexedDB); per-group similarity badge; telemetry
  overlay; recoverable scan resume; MD5 exact-duplicate fast path; **pHash**
  (DCT); aspect-ratio pre-filter; AIMD adaptive concurrency; full CSV/JSON export
  with match metadata; incremental **delta scan**; auto-tuned LSH band config;
  rotation-invariant hashing; SharedArrayBuffer zero-copy pipeline; false-
  positive rejection feedback loop; service-worker background queue; and an
  **Undo delete** button.

## [10.1] - 2026

### Added
- Sobel **edge-texture histogram** combined with color (40% color / 60% edge) to
  cut false positives; delete button + `D` shortcut in the crop modal.

### Changed
- Unified trash-can icons across all result rows; richer folder-traversal status
  reporting during scans.

## [10.0] - 2026

### Added
- **Crop detection** (sub-region hashing) and **color histogram** matching;
  delete button on KEEP rows (with confirmation).

## [9.4] - 2026-01

### Added
- Compare-modal keyboard shortcuts (`1`/`2`/`3`, arrows, `Esc`); download links
  in the compare modal; auto-advance after delete; filter statistics; visual
  group separation.

### Fixed
- "Trash Selected" count no longer resets while scrolling the virtual list; the
  KEEP image is consistently shown on the left in the compare modal.
