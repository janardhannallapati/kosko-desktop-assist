// 467 rules 6-9 — the notes, a batch at a time: ask their ids (fp1 + GUID), decide and upload their attachments,
// send them, and settle every one exactly once. The desktop twin of /import's batch loop (Kosko run-import.js).
import { randomUUID } from 'node:crypto';
import { SendStopped } from '../errors.mjs';
import { plainTextDoc, mediaNode, buildRecord } from './note-record.mjs';
import { readCachedBytes } from './attachments.mjs';
import { AttachmentMissing } from '../../mcp/evernote.mjs';
import { placeMedia } from './formatted-body.mjs';

const MINT_MAX = 100; // attachments/batch (432)
const UPLOAD_LANES = 4;
const MEDIA_RESENDS = 10;
const GUID_RE = /^[A-Za-z0-9_-]{1,64}$/; // Kosko 463's external_id check
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A note's own refusal → the receipt reason (Kosko run-import.js NOTE_REASON).
const NOTE_REASON = { invalid: 'parse_error', note_too_large: 'note_too_large', batch_too_large: 'note_too_large', quota_exceeded: 'quota_exceeded' };
const OUTCOMES = new Set(['created', 'updated', 'skipped']); // 511: `updated`, a matched note upgraded in place
// 504 known issue, fixed in 512: note-ids must answer every note asked about with one of these states, or the run stops.
const ID_STATES = new Set(['new', 'here', 'trash', 'deleted', 'clash']);
// A formatted body Kosko refused: since 511 r8b the batch names 511 rule 5's refusal `would_drop_media` (Kosko 512);
// `invalid` stays in the set for a Kosko from before that. A new note is sent again as plain text; a note already there
// keeps its plain text and is settled `skipped`/`formatted_refused` (review T8; Kosko's receipt hears changed_in_evernote).
const FORMATTED_REFUSALS = new Set(['invalid', 'would_drop_media', 'note_too_large', 'batch_too_large']);
const badAnswer = () => new SendStopped('bad_answer', 'Kosko answered note-ids in a way this tool does not understand, so the '
  + 'import stopped. Nothing already sent is lost; run the assist again to continue.');
const REASON_RE = /^[a-z_]{1,40}$/;
const MINT_REFUSAL = { over_size_cap: ['over_size_cap', 'over_cap'], type_not_stored: ['type_not_stored', 'type_not_stored'] };

/** Distinct attachments of a note, first row of each md5, in plan order. */
const distinct = (x) => x.atts.filter(({ a }, i, all) => all.findIndex((o) => o.a.dataHash === a.dataHash) === i);

/**
 * `bodies` (512, the --evernote route) is null or { prepare(x, st) }: called once per note after its note-ids answer,
 * it may give the note a formatted body (x.converted, x.version, x.bodyState) and, for a note Kosko holds, the update.
 */
export function createNoteSender({ api, sender, lanes, jobId, resourceCacheDir, cp, settle, bodies = null }) {
  const refuse = async (x, reason, { record = true } = {}) => {
    if (record) await sender.call(() => api.refusal({ job_id: jobId, fingerprint: x.fp, version_hash: x.version, reason }));
    settle(x, 'not_imported', reason);
  };

  async function mintAndUpload(queue) {
    const items = [];
    for (const x of queue) {
      if (x.paths) continue;
      x.paths = new Map();
      x.failed = new Map(); // md5 -> [missing reason, count bucket]
      if (x.skipBound) continue; // the ledger holds this note: nothing of it is uploaded (Kosko W5 review C1)
      for (const { a, d } of distinct(x)) {
        if (d.upload && !x.refusedTypes.has(a.dataHash)) items.push({ x, a, d, body: { note_id: x.id, md5: a.dataHash, size: a.size, content_type: d.type, folder: d.folder } });
      }
    }
    const uploads = [];
    for (let i = 0; i < items.length; i += MINT_MAX) {
      const chunk = items.slice(i, i + MINT_MAX);
      const res = await sender.call(() => api.attachmentsBatch({ job_id: jobId, items: chunk.map((c) => c.body) }));
      for (const r of res.results) {
        const c = chunk[r.index];
        if (r.error?.code === 'quota_exceeded') { c.x.quota = true; continue; }
        if (r.error) { c.x.failed.set(c.a.dataHash, MINT_REFUSAL[r.error.code] ?? ['unreadable', 'unreadable']); continue; }
        c.x.paths.set(c.a.dataHash, r.path);
        if (r.upload) uploads.push({ ...c, upload: r.upload });
      }
    }
    // PUT from the resource cache, four at a time; an expired link is minted again once. The first failure stops every
    // lane before it takes another file (467 review H4), and the batch waits for all of them before throwing.
    let next = 0;
    let stopped = false;
    const results = await Promise.allSettled(lanes.map(async (lane) => {
      while (!stopped && next < uploads.length) {
        const u = uploads[next++];
        let bytes;
        if (u.d.source === 'evernote') {
          // 513: a file this computer never had, fetched from Evernote only now that Kosko asked for its bytes.
          try { bytes = await bodies.fetchFile(u.x, u.a); } catch (e) {
            if (!(e instanceof AttachmentMissing)) { stopped = true; throw e; }
            u.x.paths.delete(u.a.dataHash); u.x.failed.set(u.a.dataHash, ['missing_from_cache', 'placeholder']);
            continue;
          }
        } else {
          try { bytes = readCachedBytes(resourceCacheDir, u.a); } catch { bytes = null; }
        }
        // Unreadable now, or not the size the plan recorded (the file changed since the dry run): never PUT (review M3).
        if (!bytes || bytes.length !== u.a.size) { u.x.paths.delete(u.a.dataHash); u.x.failed.set(u.a.dataHash, ['unreadable', 'unreadable']); continue; }
        try {
          await lane.call(() => api.upload(u.upload, bytes));
        } catch (e) {
          if (!(e instanceof SendStopped) || e.code !== 'upload_expired') { stopped = true; throw e; }
          // Minted again once; whatever the answer, the note's node says what is true (467 review H3).
          const res = await sender.call(() => api.attachmentsBatch({ job_id: jobId, items: [u.body] }));
          const r = res.results?.[0];
          if (r?.path && !r.error) u.x.paths.set(u.a.dataHash, r.path);
          if (r?.error || !r?.path) { u.x.paths.delete(u.a.dataHash); u.x.failed.set(u.a.dataHash, MINT_REFUSAL[r?.error?.code] ?? ['unreadable', 'unreadable']); continue; }
          if (r.upload) {
            try { await lane.call(() => api.upload(r.upload, bytes)); } catch (e2) {
              if (!(e2 instanceof SendStopped) || e2.code !== 'upload_expired') { stopped = true; throw e2; }
              u.x.paths.delete(u.a.dataHash); u.x.failed.set(u.a.dataHash, ['unreadable', 'unreadable']);
            }
          }
        }
      }
    }));
    const failure = results.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /** One attachment, as the note's body references it: its stored path, or a placeholder with why. */
  const resolveFor = (x) => (a, d) => {
    const failed = x.failed.get(a.dataHash) ?? (x.refusedTypes.has(a.dataHash) ? ['type_not_stored'] : null);
    if (!d.upload) return { missing: d.missing };
    if (failed) return { missing: failed[0] };
    return { path: x.paths.get(a.dataHash) }; // a skipped note: undefined, so the placeholder
  };

  function recordOf(x) {
    let doc;
    if (x.converted) doc = placeMedia(x.converted.doc, distinct(x), resolveFor(x));
    else {
      doc = plainTextDoc(x.note.plainText);
      for (const { a, d } of distinct(x)) {
        if (!d.node && !d.upload) continue; // no hash to name a placeholder by
        doc.content.push(mediaNode({ mime: a.mime, filename: a.filename, md5: a.dataHash }, resolveFor(x)(a, d)));
      }
    }
    const record = buildRecord({ note: x.note, id: x.id, jobId, fingerprint: x.fp, version: x.version,
      parentId: cp.notebooks[x.parentKey] ?? null, tags: x.tags, doc });
    return x.update ? { ...record, update: true } : record; // 511: opt in to the update path
  }

  /**
   * note-ids for [{ fp, guid }], checked. 504's known issue (512): silence about a note, or an answer that is not one,
   * stops the run. It is never "new": a note Kosko holds, read as new, would be sent again under a fresh id. Also asked
   * by 514 for the notes a batch's links name.
   */
  async function askIds(entries) {
    const ask = await sender.call(() => api.noteIds({ fingerprints: entries.map((e) => e.fp),
      external_ids: entries.map((e) => (GUID_RE.test(String(e.guid)) ? e.guid : null)) }));
    const ids = ask?.ids;
    if (!ids || typeof ids !== 'object' || Array.isArray(ids)) throw badAnswer();
    for (const { fp } of entries) {
      const st = Object.hasOwn(ids, fp) ? ids[fp] : null;
      if (!ID_STATES.has(st?.state) || (st.state === 'here' && !UUID_RE.test(String(st.id)))
        || (st.state === 'new' && st.id != null && !UUID_RE.test(String(st.id)))) throw badAnswer();
    }
    return ids;
  }

  /** Every note of the batch is settled when this returns, or a SendStopped is thrown. */
  return async function sendBatch(batch) {
    const ids = await askIds(batch.map((x) => ({ fp: x.fp, guid: x.note.id })));
    let queue = [];
    for (const x of batch) {
      const st = ids[x.fp];
      // Kosko holds this note's creation second for a DIFFERENT Evernote note: sending it would be refused (463 rule 3).
      if (st?.state === 'clash') { settle(x, 'not_imported', 'id_clash'); continue; }
      Object.assign(x, { id: st?.state === 'new' && st.id ? st.id : randomUUID(), skipBound: Boolean(st && st.state !== 'new'),
        // 504: the live Kosko note a `skipped` answer means (note-ids `here`); trash, deleted or new have none.
        hereId: st?.state === 'here' && UUID_RE.test(String(st.id)) ? String(st.id) : null,
        paths: null, refusedTypes: new Set(), idRetried: false, mediaResends: 0, retries: 0, quota: false });
      if (bodies) await bodies.prepare(x, st);
      queue.push(x);
    }
    // 514: every formatted body's links, resolved before any note of the batch is written.
    if (bodies?.resolveLinks) await bodies.resolveLinks(queue, ids, askIds);
    while (queue.length) {
      await mintAndUpload(queue);
      for (const x of queue.filter((q) => q.quota)) await refuse(x, 'quota_exceeded');
      queue = queue.filter((q) => !q.quota);
      if (!queue.length) break;
      if (bodies?.finalize) for (const x of queue) await bodies.finalize(x);
      const res = await sender.call(() => api.notesBatch({ job_id: jobId, notes: queue.map(recordOf) }));
      const again = [];
      const answered = new Map((res.results ?? []).filter((r) => Number.isInteger(r?.index) && queue[r.index]).map((r) => [r.index, r]));
      for (const [index, x] of queue.entries()) {
        // A note with no answer, or an answer that is not one, is sent again (467 review M1/M2), never settled blind.
        const r = answered.get(index) ?? { error: { code: 'retry' } };
        if (!r.error && OUTCOMES.has(r.outcome)) {
          x.koskoId = r.outcome === 'created' ? x.id : x.hereId; // 504: the note its image text is sent to (updated: here)
          settle(x, r.outcome, REASON_RE.test(String(r.reason)) ? r.reason : null);
          continue;
        }
        const code = r.error?.code ?? 'retry';
        if (x.converted && FORMATTED_REFUSALS.has(code)) {
          if (x.update) { x.bodyState = 'plain:kosko_refused'; settle(x, 'skipped', 'formatted_refused'); continue; }
          Object.assign(x, { converted: null, links: null, version: x.plainVersion, bodyState: 'plain:kosko_refused' });
          again.push(x);
          continue;
        }
        if (code === 'id_taken' && !x.idRetried) { Object.assign(x, { idRetried: true, id: randomUUID(), paths: null }); again.push(x); continue; }
        // Twice: a race and a permanent clash look the same (463 review M3); report it, do not loop.
        if (code === 'id_taken') { await refuse(x, 'id_clash'); continue; }
        if (code === 'media_type_refused' && r.error.path && x.mediaResends < MEDIA_RESENDS) {
          const md5 = [...x.paths].find(([, p]) => p === r.error.path)?.[0];
          if (md5) { x.refusedTypes.add(md5); x.paths.delete(md5); x.mediaResends += 1; again.push(x); continue; }
        }
        if ((code === 'retry' || code === 'unavailable') && ++x.retries <= 2) { again.push(x); continue; }
        await refuse(x, NOTE_REASON[code] ?? 'write_failed');
      }
      queue = again;
    }
  };
}
