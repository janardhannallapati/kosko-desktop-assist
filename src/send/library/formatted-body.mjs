// 512 — one note's formatted body: Evernote's ENML (get_note), converted by enex-core's convertEnml exactly as /import
// converts an ENEX note, then every attachment placed as W2 placed it.
//
// The attachments are W2's, decided by MD5 from the plan (attachments.mjs) and stored under the note's own key, so
// nothing is uploaded again (Kosko's attachments/batch answers a stored key `upload: null`). Each `<en-media hash>` the
// converter left as `enex-resource:<md5>` becomes that attachment's stored path, or its placeholder with W2's reason; an
// attachment no `<en-media>` places is appended at the end, as /import does (resolve-media.js). So the body references
// every media key the W2 body did, which Kosko 511 rule 5 (`would_drop_media`) requires of an update.
//
// The DOM is jsdom, pinned exact: the DOM Kosko's own converter tests and its Node import CLI run on (Kosko doc 512).
// It is loaded only by the --evernote route, so the plain-text route stays as light as W2's.
import { formatEnexDate, fingerprintNote } from '@kosko-app/enex-core/enex';
import { mediaNode } from './note-record.mjs';

const PLACEHOLDER = /^enex-resource:([0-9a-f]{32})$/;
const storable = (s) => String(s ?? '').replaceAll('\u0000', '').toWellFormed();

/** convert(enml) -> enex-core's { ok, doc, media, report } | { ok: false, reason }. One jsdom window per run. */
export async function createConverter() {
  const [{ JSDOM }, { convertEnml, noteSchema }] = await Promise.all([import('jsdom'), import('@kosko-app/enex-core')]);
  const { window } = new JSDOM('');
  const schema = noteSchema();
  return (enml) => {
    try {
      return convertEnml(enml, { schema, window });
    } catch {
      return { ok: false, reason: 'threw' };
    }
  };
}

/** The version of a formatted note: fingerprintNote over its ENML (enex-core 0.3.0 hashes it canonical, Kosko 510). */
export async function formattedVersionOf(note, tags, md5s, enml) {
  const { version } = await fingerprintNote({ created: formatEnexDate(note.created), title: note.title ?? null,
    content: enml, tags, resources: md5s.map((md5) => ({ md5 })) });
  return version;
}

/**
 * The converted doc with every attachment resolved. `atts` are the note's distinct attachments with W2's decisions
 * ({ a, d }); `resolve(a, d)` answers { path } or { missing } exactly as the plain-text body would.
 */
export function placeMedia(doc, atts, resolve) {
  const out = structuredClone(doc);
  const byMd5 = new Map(atts.filter(({ d }) => d.node || d.upload).map((e) => [e.a.dataHash, e]));
  const placed = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const m = PLACEHOLDER.exec(node.attrs?.path ?? '');
    if (m) {
      const e = byMd5.get(m[1]);
      if (!e) {
        node.attrs.missing = 'missing_from_cache'; // the ENML names a file Evernote's local data does not hold
      } else {
        placed.add(m[1]);
        const r = resolve(e.a, e.d);
        if (r.path) node.attrs.path = r.path;
        else node.attrs.missing = r.missing;
        if (node.type === 'noteAttachment' && !node.attrs.filename && e.a.filename) node.attrs.filename = storable(e.a.filename);
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  })(out);
  for (const [md5, { a, d }] of byMd5) {
    if (placed.has(md5)) continue;
    (out.content ||= []).push(mediaNode({ mime: a.mime, filename: a.filename, md5 }, resolve(a, d)));
  }
  return out;
}
