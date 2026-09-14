/*
 * Drive Dupe Destroyer (DDD) — worker-match.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Runs the pair-matching core off the UI thread (#69).
//
// This file is a transport, nothing more. Every matching decision lives in
// matcher.js, which the main thread also runs verbatim when a worker cannot
// start — that shared module is what makes the two paths provably equivalent
// rather than two implementations that happen to agree today.
//
// Messages in:   { type: "run", payload }   { type: "stop" }
// Messages out:  { type: "groups" | "progress" | "status" | "done" | "error" }
//
// Groups stream out as they form. The progressive view depends on that: it
// renders matches while the scan continues, so one array at the end would be a
// visible regression even if the totals came out the same.

import { runMatching, unpackEntries } from "./matcher.js";

let stopRequested = false;

self.onmessage = async (ev) => {
  const msg = ev.data || {};

  if (msg.type === "stop") {
    stopRequested = true;
    return;
  }

  if (msg.type !== "run") return;

  stopRequested = false;
  const p = msg.payload || {};

  try {
    // Hashes arrive packed into two flat buffers (see packEntries): handing
    // over thousands of small objects cost more in structured-clone than the
    // matching itself.
    const entries = p.packed ? unpackEntries(p.packed) : new Map(p.entries || []);
    const meta = p.meta ? new Map(p.meta) : null;

    const result = await runMatching({
      entries,
      meta,
      allIds: p.allIds || null,
      exactGroupIds: p.exactGroupIds || [],
      hamThresh: p.hamThresh,
      withVariants: p.withVariants,
      withCropDetect: p.withCropDetect,
      withColorMatch: p.withColorMatch,
      withPHash: p.withPHash,
      useAspectFilter: p.useAspectFilter,
      aspectTolerancePct: p.aspectTolerancePct,
      lshForceMode: p.lshForceMode,
      emitInterval: p.emitInterval,
      rejectedKeys: p.rejectedKeys || null,
      shouldStop: () => stopRequested,
      onGroups: (info) => self.postMessage({ type: "groups", ...info }),
      onProgress: (done, total, matches, groups) =>
        self.postMessage({ type: "progress", done, total, matches, groups }),
      onStatus: (s) => self.postMessage({ type: "status", ...s }),
      // No yieldFn: there is no UI in here to yield to, and the check would be
      // the only thing it cost.
    });

    self.postMessage({ type: "done", ...result });
  } catch (e) {
    self.postMessage({ type: "error", message: e?.message || String(e), stopped: stopRequested });
  }
};
