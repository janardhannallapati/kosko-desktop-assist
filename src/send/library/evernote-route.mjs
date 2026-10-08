// 512 — `send --evernote`: what the formatted route adds to the send (run-send.mjs).
//
// 1. Before anything reaches Kosko: sign in to Evernote, list every note, and hold the listing against the plan. A
//    planned note Evernote does not list, and a listed note the plan does not hold, are counted and named — by GUID, in
//    kosko-evernote-listing.json beside the plan, never on the console (467 rule 12: counts only). Neither stops the run.
// 2. Per note, after its note-ids answer: a listed note that is new to Kosko, or one Kosko holds (`here`), gets its ENML
//    from get_note, converted, with its version computed over that ENML. A note Kosko holds is sent as an update
//    (Kosko 511) under its own id. A note in Kosko's trash, deleted there, or clashing is not fetched: Kosko answers it
//    the same whatever the body. A body Evernote cannot give or the converter refuses keeps W2's plain text.
// 3. (513) Per formatted note: each file W2 found missing from this computer's cache is decided again by W2's own rules
//    as if it were there (type, size cap), and one Kosko stores is fetched from Evernote (get_attachment's signed URL,
//    MD5-checked) at PUT time, only when Kosko's mint asks for its bytes. So a file already stored by an earlier run is
//    never asked for again, and a file Evernote cannot give keeps its placeholder and stays out of the note's version,
//    so the next run tries it again.
// 4. (review T3) One note's trouble is that note's: a transient failure of its get_note or get_attachment (network,
//    timeout, 5xx, a rate limit the pacer gave up on) is tried again NOTE_RETRIES times with backoff, then the note
//    keeps W2's plain text (`plain:unreachable`) or the file its placeholder, counted, and the run goes on. A sign-in
//    that stops working would fail every note, so it stops the run (resumable). Ctrl-C stops it at once (exit 130).
import { dirname, join } from 'node:path';
import { openEvernote, fetchNoteBody, fetchAttachment, BodyMissing, AttachmentMissing, isAuthFailure, isTransient } from '../../mcp/evernote.mjs';
import { SendStopped } from '../errors.mjs';
import { STOPPED } from '../sender.mjs';
import { createConverter, formattedVersionOf } from './formatted-body.mjs';
import { decideAttachment } from './attachments.mjs';
import { withLeftLinks } from './note-links.mjs';
import { writeLocalFile } from './local-file.mjs';

export const LISTING_NAME = 'kosko-evernote-listing.json';
export const FREE_PLAN_SENTENCE = 'Evernote does not give formatted notes to this account\'s plan (its MCP server needs a paid '
  + 'plan), so your notes are sent as plain text; dropping an Evernote export on Kosko\'s Import page later brings the formatting.';
const num = (n) => Number(n).toLocaleString('en-US');
export const NOTE_RETRIES = 3; // review T3: after the first try, three more, 5 s, 10 s and 20 s apart
const RETRY_BASE_MS = 5000;
// Review follow-up: this many notes (or files) in a row given up as unreachable means Evernote is down, not one note in
// trouble. The run stops (resumable) instead of sending the rest of the library as plain text. A success resets it.
export const OUTAGE_STREAK = 5;
export const outageStop = (n) => `Evernote has not answered for ${n} notes in a row, so the import stopped. Run the same command `
  + 'again to continue — nothing is sent twice.';
export const AUTH_STOP = 'The Evernote sign-in stopped working, so the import stopped. Run the same command again to sign in '
  + 'again and continue — nothing is sent twice.';

/**
 * { freePlan: true } or { call, listed, planNotListed, listedNotInPlan, stats }; throws when sign-in fails, and
 * SendStopped('aborted') at Ctrl-C.
 */
export async function prepareEvernote({ plan, planPath, evernote, log, signal }) {
  let opened;
  try {
    opened = await openEvernote({ origin: evernote.origin, fetchImpl: evernote.fetch ?? fetch, port: evernote.port,
      authorize: evernote.authorize, log, sleep: evernote.sleep, now: evernote.now, signal, callTimeoutMs: evernote.callTimeoutMs });
  } catch (e) {
    if (signal?.aborted) throw new SendStopped('aborted', STOPPED);
    throw e;
  }
  if (opened.freePlan) return opened;
  const listedSet = new Set(opened.listed);
  const planned = new Set(plan.notes.map((n) => String(n.id).toLowerCase()));
  const planNotListed = plan.notes.map((n) => String(n.id)).filter((id) => !listedSet.has(id.toLowerCase()));
  const listedNotInPlan = opened.listed.filter((id) => !planned.has(id));
  log(`Signed in to Evernote: ${num(opened.listed.length)} notes listed.`);
  Object.assign(opened, { fetchImpl: evernote.fetch ?? fetch, now: evernote.now ?? Date.now, signal,
    signedUrlOk: evernote.signedUrlOk, downloadFloorMs: evernote.downloadFloorMs, outageAfter: evernote.outageAfter ?? OUTAGE_STREAK });
  const file = join(dirname(planPath), LISTING_NAME);
  const saved = writeLocalFile(file, { format: 'kosko-evernote-listing', version: 1, listed: opened.listed.length, planNotListed, listedNotInPlan },
    log, 'notes Evernote and the plan disagree about');
  if (planNotListed.length || listedNotInPlan.length) {
    log(`${num(planNotListed.length)} planned notes are not listed by Evernote and keep their plain text; `
      + `${num(listedNotInPlan.length)} listed notes are not in the plan.${saved ? ` Their ids are in ${file}.` : ''}`);
  }
  return { ...opened, listedSet, planNotListed, listedNotInPlan };
}

/** Thrown when a call's transient failures outlast NOTE_RETRIES: the note or file is given up, the run goes on. */
class Unreachable extends Error {}

/**
 * fn() with review T3's rules: the run's abort → SendStopped('aborted'); a sign-in failure → SendStopped (resumable);
 * a transient failure → tried again with backoff (through the pacer's abortable wait), then Unreachable.
 */
async function resilient(mcp, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (mcp.signal?.aborted) throw new SendStopped('aborted', STOPPED);
      if (e instanceof SendStopped) throw e;
      if (isAuthFailure(e)) throw new SendStopped('evernote_auth', AUTH_STOP);
      if (!isTransient(e)) throw e;
      if (attempt >= NOTE_RETRIES) throw new Unreachable();
      try { await mcp.wait(RETRY_BASE_MS * 2 ** attempt); } catch { throw new SendStopped('aborted', STOPPED); }
    }
  }
}

/**
 * bodies.prepare(x, st), bodies.fetchFile(x, a) and bodies.finalize(x) for send-notes.mjs. `allowance` is Kosko's (W2's
 * decisions read its maxFileBytes).
 */
export async function createBodyPreparer({ mcp, allowance, links = null }) {
  const convert = await createConverter();
  const files = { downloaded: 0, unreachable: 0 };
  let streak = 0; // notes or files given up in a row (OUTAGE_STREAK)
  const gaveUp = () => { if (++streak >= mcp.outageAfter) throw new SendStopped('evernote_outage', outageStop(streak)); };
  let chain = Promise.resolve(); // one get_attachment and its download at a time, whatever the upload lanes do
  const fromEvernote = (x) => x.atts.filter(({ d }) => d.source === 'evernote');
  return {
    files,
    /** 514: the batch's links, resolved before it is written (note-links.mjs). */
    resolveLinks: links ? (queue, ids, ask) => links.resolve(queue, ids, ask) : null,
    /** 513: the bytes of a file W2 found missing, from Evernote; AttachmentMissing when they cannot be had. */
    fetchFile(x, a) {
      const run = chain.then(async () => {
        let bytes;
        try {
          bytes = await resilient(mcp, () => fetchAttachment(mcp, { guid: String(x.note.id).toLowerCase(), md5: a.dataHash, size: a.size }));
        } catch (e) {
          if (!(e instanceof Unreachable)) throw e;
          files.unreachable += 1;
          gaveUp();
          throw new AttachmentMissing('unreachable');
        }
        streak = 0;
        files.downloaded += 1;
        return bytes;
      });
      chain = run.catch(() => {});
      return run;
    },
    /**
     * The version, once the files and links are known. 513: a file still missing is left out, so the next run sees a
     * newer version once it arrives. 514 (review T9): the links left unresolved are put in, so the next run sees a
     * newer version once one of them can be resolved (a target taken out of Kosko's trash, say) and the note is sent
     * again. With every file fetched and every link resolved it is exactly prepare's version.
     */
    async finalize(x) {
      if (!x.converted) return;
      let version = x.formattedVersion;
      if (fromEvernote(x).length) {
        const missing = new Set(fromEvernote(x).filter(({ a }) => x.failed?.has(a.dataHash)).map(({ a }) => a.dataHash));
        const md5s = [...new Set(x.atts.map(({ a }) => a.dataHash))].filter((m) => !missing.has(m));
        version = await formattedVersionOf(x.note, x.tags, md5s, x.enml);
      }
      x.version = withLeftLinks(version, (x.links?.left ?? []).map((l) => l.target));
    },
    async prepare(x, st) {
      x.bodyState = 'plain';
      if (st.state !== 'new' && st.state !== 'here') return;
      const guid = String(x.note.id).toLowerCase();
      if (!mcp.listedSet.has(guid)) { x.bodyState = 'plain:not_listed'; return; }
      let body;
      try {
        body = await resilient(mcp, () => fetchNoteBody(mcp.call, guid));
      } catch (e) {
        if (e instanceof BodyMissing) { streak = 0; x.bodyState = 'plain:missing'; return; } // Evernote answered
        if (e instanceof Unreachable) { x.bodyState = 'plain:unreachable'; gaveUp(); return; } // W2's plain text stays
        throw e;
      }
      streak = 0;
      const converted = convert(body.enml);
      if (!converted.ok) { x.bodyState = 'plain:unconvertible'; return; }
      const md5s = [...new Set(x.atts.map(({ a }) => a.dataHash))];
      const formattedVersion = await formattedVersionOf(x.note, x.tags, md5s, body.enml);
      Object.assign(x, { converted, enml: body.enml, bodyState: 'formatted', formattedVersion, version: formattedVersion });
      // 513: W2's own decision, made again as if the file were on this computer; stored ones come from Evernote.
      x.atts = x.atts.map((e) => {
        if (e.d.missing !== 'missing_from_cache') return e;
        const d = decideAttachment({ ...e.a, cacheStatus: 'present' }, allowance);
        return { a: e.a, d: d.upload ? { ...d, source: 'evernote' } : d };
      });
      // 511: a note Kosko holds is upgraded in place, under its own id, so its media keys and OCR rows still hold.
      if (st.state === 'here') Object.assign(x, { update: true, id: x.hereId, skipBound: false });
    }
  };
}

/** The receipt summary's body counts, from the checkpoint (so a resumed run counts what the stopped run sent). */
export function bodyCounts(bodies, notes) {
  const c = { formatted: 0, plain: 0, notListed: 0, missing: 0, unconvertible: 0, koskoRefused: 0, unreachable: 0 };
  const key = { formatted: 'formatted', plain: 'plain', 'plain:not_listed': 'notListed', 'plain:missing': 'missing',
    'plain:unconvertible': 'unconvertible', 'plain:kosko_refused': 'koskoRefused', 'plain:unreachable': 'unreachable' };
  for (const n of notes) { const b = bodies[n.id]; if (b && key[b]) c[key[b]] += 1; }
  return c;
}

/**
 * 513: what became of the files W2 found missing from this computer, from the checkpoint (so a resumed run counts what
 * the stopped run settled): `fetched` are stored in Kosko now, `stillMissing` keep their placeholder. A file whose
 * type Kosko does not store, or over the size cap, is neither (it is counted in its own attachment bucket).
 */
export function fileCounts(attachmentsCp, attachments, { downloaded, unreachable }) {
  const c = { fetched: 0, stillMissing: 0, downloaded, unreachable };
  for (const a of attachments) {
    if (a.cacheStatus !== 'missing') continue;
    const b = attachmentsCp[a.id];
    if (b === 'stored') c.fetched += 1;
    else if (b === 'placeholder') c.stillMissing += 1;
  }
  return c;
}
