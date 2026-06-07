<!-- Drive Dupe Destroyer v12.8 — CHANGELOG-v12.8.md -->
# v12.8 — legacy image format discovery

Drive Dupe Destroyer now discovers additional legacy/design image formats in Google Drive scans:

- PSD / Adobe Photoshop (`.psd`)
- TGA / Targa (`.tga`, `.targa`)
- IFF / ILBM / Amiga (`.iff`, `.ilbm`, `.lbm`)
- PCX / PiCture eXchange (`.pcx`)

## Technical notes

- The Drive search query now includes filename-extension checks for these formats, because Google Drive may not report all of them as `image/*` MIME types.
- The image filter now checks both MIME type and filename extension.
- Exact duplicate detection can still use Drive-provided MD5 checksums.
- Perceptual hashing depends on what the browser can decode. Some legacy formats may be found and listed but may not produce perceptual hashes unless the browser can render them.

## Versioning

- App version bumped from v12.7 to v12.8.
- Service worker cache bumped to `drive-dupe-destroyer-v12.8`.
- Folder/package name bumped to `Drive_Dupe_Destroyer_v12.8`.
