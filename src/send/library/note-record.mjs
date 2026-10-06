// 467 rules 6-7 — one note as POST /api/import/notes/batch takes it.
//
// Identity is /import's: fp1 = assignFingerprints over fingerprintNote({ created: formatEnexDate(created) }) — the
// same calls match.mjs (462) measured — so an ENEX export of the same note, dropped on /import later, finds it. The
// Evernote GUID rides along as external_id (463), which a desktop re-run matches first.
//
// The body is the note's plain text, one paragraph per line, then its attachments: Evernote's local data keeps no
// formatting and no position for an attachment inside the text (W4/W5 bring the formatted body). Only four node types
// are ever built — paragraph, text, noteImage, noteAttachment — and test/send-note-record.test.mjs proves every shape
// fits enex-core's note schema (Tiptap is a dev dependency only; owner decision 2026-10-06).
//
// The version hashes what this tool sent (title, plain text, sorted tags, sorted attachment MD5s), through the same
// function /import uses, so a later formatted copy of the note reads as a newer version — the upgrade W5 wants.
import { formatEnexDate, fingerprintNote, assignFingerprints } from '@kosko-app/enex-core/enex';

const EXTERNAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // Kosko 463's column check
const PLACEHOLDER = 'enex-resource:';

// U+0000 and lone surrogates are not storable text in Postgres (Kosko 432 review F1); everything else is kept.
const storable = (s) => String(s ?? '').replaceAll('\u0000', '').toWellFormed();

export function plainTextDoc(text) {
  const lines = storable(text).split(/\r?\n/);
  const content = (lines.length === 1 && lines[0] === '' ? [''] : lines)
    .map((line) => (line === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: line }] }));
  return { type: 'doc', content };
}

/** A stored attachment ({ path }) or a placeholder ({ missing }) — /import's resolve-media nodeFor, same attrs. */
export function mediaNode({ mime, filename, md5 }, { path, missing }) {
  const type = String(mime ?? '').trim().toLowerCase();
  const p = path ?? `${PLACEHOLDER}${md5}`;
  const node = type.startsWith('image/')
    ? { type: 'noteImage', attrs: { src: null, path: p, alt: null } }
    : { type: 'noteAttachment', attrs: { src: null, path: p, mediaType: type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file',
      mimeType: type || null, filename: filename ? storable(filename) : null } };
  if (missing) node.attrs.missing = missing;
  return node;
}

/** fp1 for every note, in plan order (the order tells same-second notes apart, as /import's selection order does). */
export async function fingerprintsFor(notes) {
  const ids = await Promise.all(notes.map(async (n) => {
    const { identity } = await fingerprintNote({ created: formatEnexDate(n.created) });
    return { identity, version: identity }; // the version plays no part in the identity of a note that is alone
  }));
  return (await assignFingerprints(ids)).fingerprints;
}

export async function versionOf(note, tags, md5s) {
  const { version } = await fingerprintNote({ created: formatEnexDate(note.created), title: note.title ?? null,
    content: storable(note.plainText), tags, resources: md5s.map((md5) => ({ md5 })) });
  return version;
}

export function isoFromMs(ms) {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) && typeof ms === 'number' ? d.toISOString() : null;
}

export function buildRecord({ note, id, jobId, fingerprint, version, parentId, tags, doc }) {
  return {
    id, job_id: jobId, fingerprint, version_hash: version,
    external_id: EXTERNAL_ID_RE.test(String(note.id)) ? note.id : null,
    title: note.title ? storable(note.title) : null,
    created_at: isoFromMs(note.created), updated_at: isoFromMs(note.updated),
    parent_id: parentId, tags, content: doc
  };
}
