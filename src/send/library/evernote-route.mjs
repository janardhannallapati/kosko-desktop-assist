// 512 — `send --evernote`: what the formatted route adds to the send (run-send.mjs).
//
// 1. Before anything reaches Kosko: sign in to Evernote, list every note, and hold the listing against the plan. A
//    planned note Evernote does not list, and a listed note the plan does not hold, are counted and named — by GUID, in
//    kosko-evernote-listing.json beside the plan, never on the console (467 rule 12: counts only). Neither stops the run.
// 2. Per note, after its note-ids answer: a listed note that is new to Kosko, or one Kosko holds (`here`), gets its ENML
//    from get_note, converted, with its version computed over that ENML. A note Kosko holds is sent as an update
//    (Kosko 511) under its own id. A note in Kosko's trash, deleted there, or clashing is not fetched: Kosko answers it
//    the same whatever the body. A body Evernote cannot give or the converter refuses keeps W2's plain text.
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openEvernote, fetchNoteBody, BodyMissing } from '../../mcp/evernote.mjs';
import { createConverter, formattedVersionOf } from './formatted-body.mjs';

export const LISTING_NAME = 'kosko-evernote-listing.json';
export const FREE_PLAN_SENTENCE = 'Evernote does not give formatted notes to this account\'s plan (its MCP server needs a paid '
  + 'plan), so your notes are sent as plain text; dropping an Evernote export on Kosko\'s Import page later brings the formatting.';
const num = (n) => Number(n).toLocaleString('en-US');

/** { freePlan: true } or { call, listed, planNotListed, listedNotInPlan, stats }; throws when sign-in fails. */
export async function prepareEvernote({ plan, planPath, evernote, log }) {
  const opened = await openEvernote({ origin: evernote.origin, fetchImpl: evernote.fetch ?? fetch, port: evernote.port,
    authorize: evernote.authorize, log, sleep: evernote.sleep, now: evernote.now });
  if (opened.freePlan) return opened;
  const listedSet = new Set(opened.listed);
  const planned = new Set(plan.notes.map((n) => String(n.id).toLowerCase()));
  const planNotListed = plan.notes.map((n) => String(n.id)).filter((id) => !listedSet.has(id.toLowerCase()));
  const listedNotInPlan = opened.listed.filter((id) => !planned.has(id));
  const file = join(dirname(planPath), LISTING_NAME);
  writeFileSync(`${file}.partial`, `${JSON.stringify({ format: 'kosko-evernote-listing', version: 1, listed: opened.listed.length,
    planNotListed, listedNotInPlan }, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.partial`, file);
  log(`Signed in to Evernote: ${num(opened.listed.length)} notes listed.`);
  if (planNotListed.length || listedNotInPlan.length) {
    log(`${num(planNotListed.length)} planned notes are not listed by Evernote and keep their plain text; `
      + `${num(listedNotInPlan.length)} listed notes are not in the plan. Their ids are in ${file}.`);
  }
  return { ...opened, listedSet, planNotListed, listedNotInPlan };
}

/** bodies.prepare(x, st) for send-notes.mjs. */
export async function createBodyPreparer({ mcp }) {
  const convert = await createConverter();
  return {
    async prepare(x, st) {
      x.bodyState = 'plain';
      if (st.state !== 'new' && st.state !== 'here') return;
      const guid = String(x.note.id).toLowerCase();
      if (!mcp.listedSet.has(guid)) { x.bodyState = 'plain:not_listed'; return; }
      let body;
      try {
        body = await fetchNoteBody(mcp.call, guid);
      } catch (e) {
        if (e instanceof BodyMissing) { x.bodyState = 'plain:missing'; return; }
        throw e;
      }
      const converted = convert(body.enml);
      if (!converted.ok) { x.bodyState = 'plain:unconvertible'; return; }
      const md5s = [...new Set(x.atts.map(({ a }) => a.dataHash))];
      Object.assign(x, { converted, bodyState: 'formatted', version: await formattedVersionOf(x.note, x.tags, md5s, body.enml) });
      // 511: a note Kosko holds is upgraded in place, under its own id, so its media keys and OCR rows still hold.
      if (st.state === 'here') Object.assign(x, { update: true, id: x.hereId, skipBound: false });
    }
  };
}

/** The receipt summary's body counts, from the checkpoint (so a resumed run counts what the stopped run sent). */
export function bodyCounts(bodies, notes) {
  const c = { formatted: 0, plain: 0, notListed: 0, missing: 0, unconvertible: 0, koskoRefused: 0 };
  const key = { formatted: 'formatted', plain: 'plain', 'plain:not_listed': 'notListed', 'plain:missing': 'missing',
    'plain:unconvertible': 'unconvertible', 'plain:kosko_refused': 'koskoRefused' };
  for (const n of notes) { const b = bodies[n.id]; if (b && key[b]) c[key[b]] += 1; }
  return c;
}
