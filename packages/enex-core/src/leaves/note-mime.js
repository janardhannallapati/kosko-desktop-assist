// The MIME sets the converter decides with, and that Kosko's store allowlist is derived from.
//
// ONE copy, owned here (owner, 2026-10-04): the converter turns an <en-media> into an image node only for
// a type the store can hold as an image (or one Kosko converts on upload), so the desktop tool and Kosko's
// /import must read the SAME set or they build different notes from the same ENML. Kosko's
// lib/attachable-types.js imports both sets and derives its upload allowlists from them. A change here is
// therefore a change to what Kosko stores, and it ships only through a reviewed release and a pin bump.

// Every type the store may hold.
export const STORABLE_MIME = Object.freeze(
  new Set([
    // documents (baseline migration)
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/html',
    // images (baseline + 20260831000000)
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    // audio (20260829120000 + 20260831000000)
    'audio/mpeg',
    'audio/wav',
    'audio/webm',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
    // video (20260829120000 + 20260831000000)
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-matroska',
    'video/x-msvideo',
    // storage-readiness W1 — every other format found in the measured Evernote archive
    'image/svg+xml',
    'image/x-icon',
    'application/zip',
    'application/epub+zip',
    'text/plain'
  ])
);

// What a note may hold (Kosko 374: every storable type).
export const NOTE_UPLOADABLE_MIME = STORABLE_MIME;

// Accepted from the user even though the store never holds them: Kosko converts a HEIC/HEIF to JPEG on
// upload and stores that instead.
export const CONVERTED_MIME = Object.freeze(new Set(['image/heic', 'image/heif']));
