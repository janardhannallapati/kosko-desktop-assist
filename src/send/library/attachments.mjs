// 467 rule 8 — each attachment decided before anything is sent, and its bytes read from the one place the reader
// validated. A missing file is named on the receipt (465 `missing_from_cache`); a type Kosko does not store, including
// a missing or application/octet-stream type (owner decision 2026-10-06: no local sniffing in W2), keeps a
// placeholder counted as `type_not_stored`. The verdicts and counts are /import's (resolve-media.js), so the two
// receipts read alike.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTE_UPLOADABLE_MIME, CONVERTED_MIME } from '@kosko-app/enex-core/enex';

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MD5 = /^[0-9a-f]{32}$/;

/** { upload: true, type, folder } or { upload: false, missing, count, node } (node: whether a placeholder is kept). */
export function decideAttachment(att, { maxFileBytes }) {
  const placeholder = (missing, count, node = true) => ({ upload: false, missing, count, node });
  if (!MD5.test(String(att.dataHash))) return placeholder('unreadable', 'unreadable', false); // no hash to name it by
  if (att.cacheStatus === 'missing') return placeholder('missing_from_cache', 'placeholder');
  if (att.cacheStatus !== 'present') return placeholder('unreadable', 'unreadable');
  const type = String(att.mime ?? '').trim().toLowerCase();
  if (!NOTE_UPLOADABLE_MIME.has(type) && !CONVERTED_MIME.has(type)) return placeholder('type_not_stored', 'type_not_stored');
  if (Number.isFinite(maxFileBytes) && att.size > maxFileBytes) return placeholder('over_size_cap', 'over_cap');
  return { upload: true, type, folder: type.startsWith('image/') ? 'images' : 'attachments' };
}

/** The file Evernote cached for this attachment: <resource-cache>/<note GUID>/<md5>, ids checked again here. */
export function readCachedBytes(resourceCacheDir, att) {
  if (!GUID.test(String(att.noteId)) || !MD5.test(String(att.dataHash))) throw new Error('That attachment is not a valid resource-cache entry.');
  return new Uint8Array(readFileSync(join(resourceCacheDir, att.noteId, att.dataHash)));
}
