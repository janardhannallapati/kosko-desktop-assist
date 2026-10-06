// @kosko-app/enex-core/enex — reading ENEX and keying notes, with no editor schema behind it.
//
// This entry point never imports Tiptap, so a consumer that only reads exports and computes fp1 (the desktop tool)
// installs sax and hash-wasm and nothing else. package-boundary.test.js holds that true.
export { readEnex } from './enex-reader.js';
export { formatEnexDate } from './enex-date.js';
export { fingerprintNote, assignFingerprints, FINGERPRINT_SCHEME } from '../fingerprint.js';
// 0.2.1 (Kosko 467): the MIME sets, so the desktop tool decides an attachment exactly as /import does without
// loading the editor schema. The same Set objects the root entry exports.
export { STORABLE_MIME, NOTE_UPLOADABLE_MIME, CONVERTED_MIME } from '../leaves/note-mime.js';
