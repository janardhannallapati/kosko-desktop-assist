// 504 — Evernote's image text (plan.ocr[]), sent after each notes batch settles: every record whose note was created
// or skipped (a W2-era run imported it without OCR — this is the backfill) goes to POST /api/import/ocr/batch keyed
// by the Kosko note id that batch used and the attachment's md5. Every planned record ends in exactly one checkpoint
// bucket, and the receipt's five OCR counts are read from those buckets, so they add up to the plan's tally.ocr:
//   words | empty       stored by Kosko (created, updated or unchanged all count)
//   refused:<reason>    Kosko refused the item, or it could never pass Kosko's shape check (too_long)
//   not_sent            its note was not imported, is in Kosko's trash or was deleted there, or is not in the plan
//   unreadable          Evernote's record could not be read (the dry run's problems.ocrErrors), or its md5 is not one
// The text is the person's; it is sent, never logged, never written to the checkpoint.
//
// A reply that is not what Kosko promises (counts that do not add up to the items, a refusal naming no item, a note
// the note-ids answer is silent about) stops the run and buckets nothing for that call, so the next run sends it again.
import { SendStopped } from '../errors.mjs';

const MAX_ITEMS = 500; // Kosko 501: 1–500 items per call
const MAX_BYTES = 3.5 * 1024 * 1024; // Kosko answers 413 over 4 MB; the tool keeps under 3.5 MB (504)
const MAX_CHARS = 32768; // Kosko 501's text cap, per item
const ENVELOPE = 128; // {"job_id":…,"items":[]} around the items
const NOTE_IDS_CALL = 900;
const MD5_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_RE = /^[A-Za-z0-9_-]{1,64}$/; // Kosko 463's external_id check (as send-notes.mjs)
const REASON_RE = /^[a-z_]{1,40}$/;
const SENT = new Set(['created', 'skipped']);
const NOT_LIVE = new Set(['trash', 'deleted', 'new', 'clash']); // note-ids states with no live Kosko note (Kosko 424/463)
const isCount = (n) => Number.isInteger(n) && n >= 0;

// The person's text is never in the message: it names the route only.
const badAnswer = (route) => new SendStopped('bad_answer', `Kosko answered ${route} in a way this tool does not `
  + 'understand, so the import stopped. Nothing already sent is lost; run the assist again to continue.');

export const emptyOcrCounts = () => ({ ocrWords: 0, ocrEmpty: 0, ocrUnreadable: 0, ocrNotSent: 0, ocrRefused: 0 });

/** The receipt's OCR group from the checkpoint's buckets. */
export function ocrCounts(buckets) {
  const c = emptyOcrCounts();
  for (const b of Object.values(buckets)) {
    if (b === 'words') c.ocrWords += 1;
    else if (b === 'empty') c.ocrEmpty += 1;
    else if (b === 'unreadable') c.ocrUnreadable += 1;
    else if (b === 'not_sent') c.ocrNotSent += 1;
    else c.ocrRefused += 1;
  }
  return c;
}

/**
 * `cp.ocr` is written in place. `send(xs)`: xs are settled notes (x.key = Evernote GUID, x.outcome, x.koskoId when
 * this run learnt it); a created/skipped note with no id (settled by the run that stopped) is asked for by note-ids.
 */
export function createOcrSender({ api, sender, jobId, cp, plan, maxItems = MAX_ITEMS, maxBytes = MAX_BYTES }) {
  const attById = new Map(plan.attachments.map((a) => [a.id, a]));
  const planned = new Set(plan.notes.map((n) => n.id));
  const byNote = new Map(); // Evernote note GUID -> [{ id, md5, status, text }]
  for (const o of plan.problems?.ocrErrors ?? []) if (!cp.ocr[o.attachmentId]) cp.ocr[o.attachmentId] = 'unreadable';
  for (const o of plan.ocr ?? []) {
    if (cp.ocr[o.attachmentId]) continue; // settled by the run that stopped
    const a = attById.get(o.attachmentId);
    if (!a || !planned.has(a.noteId)) { cp.ocr[o.attachmentId] = 'not_sent'; continue; }
    const md5 = String(a.dataHash ?? '').toLowerCase();
    if (!MD5_RE.test(md5)) { cp.ocr[o.attachmentId] = 'unreadable'; continue; }
    const text = typeof o.text === 'string' && o.text.trim() && o.wordCount > 0 ? o.text : '';
    if (text.length > MAX_CHARS) { cp.ocr[o.attachmentId] = 'refused:too_long'; continue; }
    if (!byNote.has(a.noteId)) byNote.set(a.noteId, []);
    byNote.get(a.noteId).push({ id: o.attachmentId, md5, status: text ? 'words' : 'empty', text });
  }

  // Notes settled by an earlier run carry no Kosko id: note-ids answers `here` with it for a live imported note.
  async function resolve(xs) {
    for (let i = 0; i < xs.length; i += NOTE_IDS_CALL) {
      const chunk = xs.slice(i, i + NOTE_IDS_CALL);
      const ask = await sender.call(() => api.noteIds({ fingerprints: chunk.map((x) => x.fp),
        external_ids: chunk.map((x) => (GUID_RE.test(String(x.key)) ? x.key : null)) }));
      const ids = ask?.ids;
      if (!ids || typeof ids !== 'object' || Array.isArray(ids)) throw badAnswer('note-ids');
      for (const x of chunk) {
        // Silence about a note is not "not imported": only an explicit state does that (absent is not zero).
        const st = Object.hasOwn(ids, x.fp) ? ids[x.fp] : null;
        if (st?.state === 'here' && UUID_RE.test(String(st.id))) x.koskoId = String(st.id);
        else if (NOT_LIVE.has(st?.state)) x.koskoId = null;
        else throw badAnswer('note-ids');
      }
    }
  }

  async function post(items) {
    const res = await sender.call(() => api.ocrBatch({ job_id: jobId,
      items: items.map(({ noteId, r }) => ({ note_id: noteId, md5: r.md5, status: r.status, text: r.text })) }));
    // Kosko 501: created + updated + unchanged + refused = items, each refusal naming one item once.
    if (!res || !Array.isArray(res.refused) || ![res.created, res.updated, res.unchanged].every(isCount)
      || res.created + res.updated + res.unchanged + res.refused.length !== items.length) throw badAnswer('ocr/batch');
    const refused = new Map();
    for (const f of res.refused) {
      if (!Number.isInteger(f?.i) || f.i < 0 || f.i >= items.length || refused.has(f.i)) throw badAnswer('ocr/batch');
      refused.set(f.i, REASON_RE.test(String(f.reason)) ? f.reason : 'refused');
    }
    items.forEach(({ r }, i) => { cp.ocr[r.id] = refused.has(i) ? `refused:${refused.get(i)}` : r.status; });
  }

  return async function send(xs) {
    const due = xs.filter((x) => (byNote.get(x.key) ?? []).some((r) => !cp.ocr[r.id]));
    await resolve(due.filter((x) => SENT.has(x.outcome) && x.koskoId === undefined));
    let items = [];
    let bytes = ENVELOPE;
    for (const x of due) {
      for (const r of byNote.get(x.key)) {
        if (!SENT.has(x.outcome) || !x.koskoId) { cp.ocr[r.id] = 'not_sent'; continue; }
        const noteId = x.koskoId.toLowerCase();
        const size = Buffer.byteLength(JSON.stringify({ note_id: noteId, md5: r.md5, status: r.status, text: r.text })) + 1;
        if (items.length && (items.length >= maxItems || bytes + size > maxBytes)) { await post(items); items = []; bytes = ENVELOPE; }
        items.push({ noteId, r });
        bytes += size;
      }
    }
    if (items.length) await post(items);
  };
}
