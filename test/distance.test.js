/*
 * Drive Dupe Destroyer (DDD) — test/distance.test.js
 *
 * Copyright (c) 2026 Carlos Camacho
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
// Tests for the matching and keep-selection logic, split out of js/common.js
// into js/distance.js, js/formats.js and js/keeprule.js (#121).
//
// These functions are pure (no DOM, no network, no Google APIs), which is why
// they are worth testing first: they decide which files the user is shown as
// delete candidates, and a mistake here is a deleted photo.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { aspectRatioCompatible, hammingBytes32, hammingDistance, thresholdFromEasy } from "../js/distance.js";
import { canBrowserDecode, getFileExtension, isImageFileName, isImageMime, isSupportedImageFile } from "../js/formats.js";
import { chooseKeepIndex } from "../js/keeprule.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Drive file record. `size` is a string, as the API returns. */
function file(id, { w, h, size, modified, name, parents, path } = {}) {
  const f = { id, name: name ?? `${id}.jpg`, size: size == null ? undefined : String(size) };
  if (w && h) f.imageMediaMetadata = { width: w, height: h };
  if (modified) f.modifiedTime = modified;
  if (parents) f.parents = parents;
  if (path) f._path = path;
  return f;
}

// ---------------------------------------------------------------------------
// chooseKeepIndex — decides which file in a duplicate group is NOT deleted
// ---------------------------------------------------------------------------

describe("chooseKeepIndex", () => {
  test("returns 0 for a group of one, or a non-array", () => {
    assert.equal(chooseKeepIndex([file("a")], "hires"), 0);
    assert.equal(chooseKeepIndex([], "hires"), 0);
    assert.equal(chooseKeepIndex(null, "hires"), 0);
  });

  test("hires picks the larger pixel count when both have dimensions", () => {
    const group = [file("small", { w: 800, h: 600 }), file("big", { w: 4000, h: 3000 })];
    assert.equal(chooseKeepIndex(group, "hires"), 1);
  });

  // Regression: res() used to fall back to the byte count when dimensions were
  // missing, then compare that against a pixel count. A 5 MB file with no
  // metadata scored 5,000,000 and beat a real 4000x3000 image scoring 12,000,000
  // only by luck of magnitude -- and reliably beat an 800x600 one (480,000).
  test("hires never prefers a file without dimensions over one with them", () => {
    const group = [
      file("has-dims", { w: 800, h: 600, size: 500_000 }),
      file("no-dims", { size: 5_000_000 }),
    ];
    assert.equal(chooseKeepIndex(group, "hires"), 0, "the file with real dimensions must win");
  });

  test("hires falls back to size only when neither file has dimensions", () => {
    const group = [file("a", { size: 1_000 }), file("b", { size: 9_000 })];
    assert.equal(chooseKeepIndex(group, "hires"), 1);
  });

  test("newest and oldest use modifiedTime", () => {
    const group = [
      file("older", { modified: "2024-01-01T00:00:00.000Z" }),
      file("newer", { modified: "2026-01-01T00:00:00.000Z" }),
    ];
    assert.equal(chooseKeepIndex(group, "newest"), 1);
    assert.equal(chooseKeepIndex(group, "oldest"), 0);
  });

  test("largest and smallest use size", () => {
    const group = [file("a", { size: 10 }), file("b", { size: 999 })];
    assert.equal(chooseKeepIndex(group, "largest"), 1);
    assert.equal(chooseKeepIndex(group, "smallest"), 0);
  });

  // Regression: folderRank matched the pattern against f.parents[0] (an opaque
  // Drive folder ID) and f.name (the FILE name), neither of which is a folder
  // name. Only the resolved _path can match what the help text promises.
  describe("folderPriority", () => {
    test("matches against the resolved folder path", () => {
      const group = [
        file("b", { path: "/My Drive/Downloads" }),
        file("a", { path: "/My Drive/Originals" }),
      ];
      assert.equal(chooseKeepIndex(group, "folderPriority", "originals"), 1);
    });

    test("earlier patterns outrank later ones", () => {
      const group = [
        file("scratch", { path: "/My Drive/Scratch" }),
        file("archive", { path: "/My Drive/Archive" }),
        file("master", { path: "/My Drive/Masters" }),
      ];
      assert.equal(chooseKeepIndex(group, "folderPriority", "masters, archive"), 2);
    });

    test("does not match a pattern against the file name", () => {
      // "originals" appears in the FILE name, not in any folder. It must not win.
      const group = [
        file("a", { name: "originals-backup.jpg", path: "/My Drive/Downloads" }),
        file("b", { name: "photo.jpg", path: "/My Drive/Originals" }),
      ];
      assert.equal(chooseKeepIndex(group, "folderPriority", "originals"), 1);
    });

    test("does not match a pattern against an opaque Drive folder ID", () => {
      // A folder ID that happens to contain the pattern text must not rank.
      const group = [
        file("a", { parents: ["1originals9xKq"], path: "/My Drive/Downloads" }),
        file("b", { parents: ["1zzzzzzzzzzz"], path: "/My Drive/Originals" }),
      ];
      assert.equal(chooseKeepIndex(group, "folderPriority", "originals"), 1);
    });

    test("falls back to a stable choice when nothing matches", () => {
      const group = [file("a", { path: "/x" }), file("b", { path: "/y" })];
      assert.equal(chooseKeepIndex(group, "folderPriority", "nomatch"), 0);
    });
  });

  // Regression: ties kept whichever element union-find iteration emitted first,
  // so the same library scanned twice could nominate a different file to delete.
  test("ties break deterministically regardless of input order", () => {
    const a = file("aaa", { w: 100, h: 100, size: 500, modified: "2025-01-01T00:00:00.000Z" });
    const b = file("bbb", { w: 100, h: 100, size: 500, modified: "2025-01-01T00:00:00.000Z" });

    const forward = [a, b];
    const reverse = [b, a];

    assert.equal(forward[chooseKeepIndex(forward, "hires")].id, reverse[chooseKeepIndex(reverse, "hires")].id);
    assert.equal(forward[chooseKeepIndex(forward, "newest")].id, reverse[chooseKeepIndex(reverse, "newest")].id);
    assert.equal(forward[chooseKeepIndex(forward, "largest")].id, reverse[chooseKeepIndex(reverse, "largest")].id);
  });

  test("an unknown keep rule still returns a valid index", () => {
    const group = [file("a"), file("b")];
    const idx = chooseKeepIndex(group, "not-a-rule");
    assert.ok(idx >= 0 && idx < group.length);
  });
});

// ---------------------------------------------------------------------------
// Format gating — decides what gets downloaded
// ---------------------------------------------------------------------------

describe("getFileExtension", () => {
  test("lower-cases and strips query/hash", () => {
    assert.equal(getFileExtension("Photo.JPG"), ".jpg");
    assert.equal(getFileExtension("photo.png?sz=w256"), ".png");
    assert.equal(getFileExtension("photo.webp#frag"), ".webp");
  });

  test("returns empty for a name with no extension", () => {
    assert.equal(getFileExtension("IMG_0001"), "");
    assert.equal(getFileExtension(""), "");
    assert.equal(getFileExtension(null), "");
  });
});

describe("isSupportedImageFile", () => {
  test("accepts ordinary image MIME types", () => {
    assert.equal(isSupportedImageFile({ mimeType: "image/jpeg", name: "a.jpg" }), true);
    assert.equal(isSupportedImageFile({ mimeType: "image/png", name: "a.png" }), true);
  });

  test("accepts a known extension even when the MIME type is unhelpful", () => {
    assert.equal(isSupportedImageFile({ mimeType: "", name: "art.psd" }), true);
  });

  // Regression: application/octet-stream is a member of SUPPORTED_IMAGE_MIMES so
  // that Drive-mistyped PSD/TGA/IFF/PCX uploads are still found. But because the
  // check was `isImageMime(mime) || isImageFileName(name)`, the MIME alone was
  // enough -- so every .zip/.exe/.dmg Drive typed as octet-stream was pulled in
  // and fully downloaded before failing to decode.
  describe("application/octet-stream requires a recognised extension", () => {
    const cases = [
      ["archive.zip", false],
      ["installer.exe", false],
      ["disk.dmg", false],
      ["backup.tar.gz", false],
      ["no-extension-at-all", false],
      ["art.psd", true],
      ["sprite.tga", true],
      ["amiga.ilbm", true],
      ["old.pcx", true],
    ];

    for (const [name, expected] of cases) {
      test(`${name} -> ${expected}`, () => {
        assert.equal(isSupportedImageFile({ mimeType: "application/octet-stream", name }), expected);
      });
    }
  });

  test("rejects folders and null input", () => {
    assert.equal(isSupportedImageFile(null), false);
    assert.equal(
      isSupportedImageFile({ mimeType: "application/vnd.google-apps.folder", name: "Photos" }),
      false
    );
  });
});

describe("isImageMime / isImageFileName", () => {
  test("isImageMime accepts the image/ prefix generally", () => {
    assert.equal(isImageMime("image/some-future-format"), true);
    assert.equal(isImageMime("text/plain"), false);
    assert.equal(isImageMime(null), false);
  });

  test("isImageFileName is extension-driven", () => {
    assert.equal(isImageFileName("a.heic"), true);
    assert.equal(isImageFileName("a.txt"), false);
  });
});

// ---------------------------------------------------------------------------
// Hamming distance — the two implementations must agree
// ---------------------------------------------------------------------------

describe("hammingDistance", () => {
  test("identical arrays are distance 0", () => {
    const a = new Uint8Array([0xff, 0x00, 0xaa, 0x55]);
    assert.equal(hammingDistance(a, a.slice()), 0);
  });

  test("counts differing bits", () => {
    assert.equal(hammingDistance(new Uint8Array([0b0000_0000]), new Uint8Array([0b1111_1111])), 8);
    assert.equal(hammingDistance(new Uint8Array([0b0000_0001]), new Uint8Array([0b0000_0000])), 1);
  });

  // hammingDistance switches implementation at 16 bytes: table lookup below,
  // hammingBytes32 above. Both must produce the same answer on the same input.
  test("the <=16-byte and >16-byte paths agree", () => {
    for (const len of [1, 8, 15, 16, 17, 18, 32, 64]) {
      const a = new Uint8Array(len);
      const b = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        a[i] = (i * 37 + 11) & 0xff;
        b[i] = (i * 91 + 200) & 0xff;
      }
      const viaTable = [...a].reduce((acc, v, i) => {
        let x = v ^ b[i], c = 0;
        while (x) { c += x & 1; x >>>= 1; }
        return acc + c;
      }, 0);
      assert.equal(hammingDistance(a, b), viaTable, `length ${len}`);
      if (len > 16) assert.equal(hammingBytes32(a, b), viaTable, `hammingBytes32 length ${len}`);
    }
  });

  test("null input returns null rather than throwing", () => {
    assert.equal(hammingDistance(null, new Uint8Array(4)), null);
  });
});

// ---------------------------------------------------------------------------
// Sensitivity mapping
// ---------------------------------------------------------------------------

describe("thresholdFromEasy", () => {
  test("is monotonically stricter as the level rises", () => {
    const values = [1, 2, 3, 4, 5].map(thresholdFromEasy);
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i] < values[i - 1], `level ${i + 1} must be stricter than ${i}`);
    }
  });

  test("unknown levels fall back to the balanced default", () => {
    assert.equal(thresholdFromEasy(99), thresholdFromEasy(3));
    assert.equal(thresholdFromEasy(undefined), thresholdFromEasy(3));
  });
});

// ---------------------------------------------------------------------------
// Aspect-ratio pre-filter — a false negative here silently drops a true match
// ---------------------------------------------------------------------------

describe("aspectRatioCompatible", () => {
  test("allows the pair when either side lacks metadata", () => {
    assert.equal(aspectRatioCompatible({}, file("b", { w: 100, h: 100 })), true);
  });

  test("accepts identical ratios and rejects clearly different ones", () => {
    const wide = file("a", { w: 4000, h: 3000 });
    const alsoWide = file("b", { w: 800, h: 600 });
    const panorama = file("c", { w: 4000, h: 500 });
    assert.equal(aspectRatioCompatible(wide, alsoWide), true);
    assert.equal(aspectRatioCompatible(wide, panorama), false);
  });

  test("accepts the rotated counterpart of the same ratio", () => {
    const landscape = file("a", { w: 4000, h: 3000 });
    const portrait = file("b", { w: 3000, h: 4000 });
    assert.equal(aspectRatioCompatible(landscape, portrait), true);
  });
});

// ---------------------------------------------------------------------------
// canBrowserDecode — gates whether a file is downloaded for perceptual hashing
// ---------------------------------------------------------------------------

describe("canBrowserDecode", () => {
  test("rejects formats no mainstream browser decodes", () => {
    // Downloading these is guaranteed waste — a 300 MB PSD or a 60 MB CR2
    // fetched only for createImageBitmap to reject it.
    for (const name of [
      "layered.psd", "sprite.tga", "amiga.ilbm", "old.pcx",
      "netpbm.ppm", "gray.pgm", "bw.pbm",
      "scan.jp2", "future.jxl",
      "IMG_1234.cr2", "IMG_1234.nef", "IMG_1234.arw", "IMG_1234.dng",
    ]) {
      assert.equal(canBrowserDecode({ name }), false, name);
    }
  });

  test("accepts the formats every browser decodes", () => {
    for (const name of ["a.jpg", "a.jpeg", "a.png", "a.gif", "a.webp", "a.bmp", "a.ico"]) {
      assert.equal(canBrowserDecode({ name }), true, name);
    }
  });

  // TIFF/HEIC/AVIF are genuinely browser-dependent. We attempt them rather than
  // guessing: a wrong "no" silently loses real matches for Safari users, and the
  // retry loop no longer re-downloads on a decode failure, so a wrong "yes"
  // costs one request.
  test("attempts the ambiguous formats rather than guessing", () => {
    for (const name of ["a.tif", "a.tiff", "a.heic", "a.heif", "a.avif"]) {
      assert.equal(canBrowserDecode({ name }), true, name);
    }
  });

  test("unknown extensions are attempted, and bad input does not throw", () => {
    assert.equal(canBrowserDecode({ name: "a.weirdext" }), true);
    assert.equal(canBrowserDecode({ name: "no-extension" }), true);
    assert.equal(canBrowserDecode({}), true);
    assert.equal(canBrowserDecode(null), true);
  });
});
