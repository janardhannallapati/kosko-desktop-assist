// 466 rule 9 — a stopped run resumes from kosko-send-checkpoint.json beside the plan. It can be lost, never wrong:
// Kosko's ledger is what makes a resend safe (a note already there is answered `skipped`), so the checkpoint only saves
// time. It is read back only when it is for THIS plan (sha-256 and size) and THIS Kosko, and every key is one this file
// names; anything else is ignored with a reason, and the run starts over. It holds ids and GUIDs only — never the
// token, a title or note text. Written to a temp file and renamed, so a crash mid-write leaves the previous one whole.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CHECKPOINT_NAME = 'kosko-send-checkpoint.json';
const FORMAT = 'kosko-send-checkpoint';
// Version 2 (504) adds `ocr`: Evernote attachment id → the bucket its image-text record settled in.
// Version 3 (512) adds `route` (plain | evernote: the run fetched formatted bodies from Evernote's MCP server) and
// `bodies`: Evernote note GUID → the body its settled note was sent with (BODY_RE), so a resumed run counts it as the
// run that settled it did and never fetches a settled note's body again. It also holds `links` (514, review T6): note
// GUID → that written note's link outcomes { rewritten, left: { reason: n }, pending: [[target GUID, Kosko id]] }, so a
// resumed run counts the links the stopped run wrote. Counts, GUIDs and ids only — never a link's text.
const VERSION = 3;
const KEYS = ['format', 'version', 'plan', 'app', 'route', 'jobId', 'notebooks', 'tags', 'notes', 'attachments', 'ocr', 'bodies', 'links', 'updatedAt'];
export const ROUTES = Object.freeze(['plain', 'evernote']);
// formatted: the ENML from get_note, converted. plain: the plain text (W2's body), with why when the run wanted a
// formatted one — the note was not listed by Evernote, get_note had no body for it, the converter refused it, or Kosko
// refused the formatted body.
// unreachable (review T3): get_note failed transiently past its retries, so the note kept W2's plain text.
const BODY_RE = /^(formatted|plain(:(not_listed|missing|unconvertible|kosko_refused|unreachable))?)$/;
const LINK_REASONS = new Set(['not_in_plan', 'in_kosko_trash', 'deleted_in_kosko', 'clash', 'no_stable_id', 'target_not_written']);
const MAX_PENDING = 10_000;
// A settled note: its outcome, and (467) the reason a resumed run's receipt must still name — `skipped:changed_in_evernote`,
// `not_imported:id_clash`. The reason is a Kosko reason code (lib/enex/receipt-reasons.js shape).
const OUTCOME_RE = /^(created|updated|skipped|not_imported)(:[a-z_]{1,40})?$/; // 511/512: `updated`
// 467 review H2: an attachment's receipt bucket, so a resumed run counts it as the run that settled it did.
const BUCKETS = new Set(['stored', 'placeholder', 'over_cap', 'type_not_stored', 'unreadable', 'not_imported_with_note']);
// 504: an OCR record's bucket (send-ocr.mjs); the refusal reason is a Kosko reason code.
const OCR_BUCKET_RE = /^(words|empty|not_sent|unreadable|refused:[a-z_]{1,40})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An Evernote id or GUID, or "stack:<name>" — a name is the person's own text in any script (466 review H2), so any
// characters but control characters, up to 400; never "__proto__", which JSON.parse makes an own key.
const KEY_RE = /^[^\p{Cc}]{1,400}$/u;
const isKey = (k) => KEY_RE.test(k) && k !== '__proto__';

export const checkpointPath = (planPath) => join(dirname(planPath), CHECKPOINT_NAME);

export function planFingerprint(planPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(planPath).on('data', (c) => { hash.update(c); bytes += c.length; })
      .on('error', reject).on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

export const emptyCheckpoint = ({ plan, app, jobId = null, route = 'plain' }) =>
  ({ format: FORMAT, version: VERSION, plan, app, route, jobId, notebooks: {}, tags: { done: false }, notes: {}, attachments: {}, ocr: {}, bodies: {}, links: {}, updatedAt: null });

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const mapOf = (o, valueOk) => isPlain(o) && Object.entries(o).every(([k, v]) => isKey(k) && valueOk(v));
const isCount = (n) => Number.isInteger(n) && n >= 0;
const isLinkRecord = (v) => isPlain(v) && sameKeys(v, ['rewritten', 'left', 'pending']) && isCount(v.rewritten)
  && isPlain(v.left) && Object.entries(v.left).every(([k, n]) => LINK_REASONS.has(k) && isCount(n))
  && Array.isArray(v.pending) && v.pending.length <= MAX_PENDING
  && v.pending.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && isKey(p[0]) && typeof p[1] === 'string' && UUID_RE.test(p[1]));

function isCheckpoint(c) {
  return isPlain(c) && sameKeys(c, KEYS) && c.format === FORMAT && Number.isInteger(c.version)
    && isPlain(c.plan) && sameKeys(c.plan, ['sha256', 'bytes']) && /^[0-9a-f]{64}$/.test(c.plan.sha256) && Number.isInteger(c.plan.bytes)
    && typeof c.app === 'string' && ROUTES.includes(c.route) && (c.jobId === null || UUID_RE.test(c.jobId))
    && mapOf(c.notebooks, (v) => typeof v === 'string' && UUID_RE.test(v))
    && isPlain(c.tags) && sameKeys(c.tags, ['done']) && typeof c.tags.done === 'boolean'
    && mapOf(c.notes, (v) => typeof v === 'string' && OUTCOME_RE.test(v)) && mapOf(c.attachments, (v) => v === true || BUCKETS.has(v))
    && mapOf(c.ocr, (v) => typeof v === 'string' && OCR_BUCKET_RE.test(v))
    && mapOf(c.bodies, (v) => typeof v === 'string' && BODY_RE.test(v)) && mapOf(c.links, isLinkRecord)
    && (c.updatedAt === null || typeof c.updatedAt === 'string');
}

/**
 * A version-1 checkpoint (W2, before image text) or version-2 one (W3, before formatted bodies) is refused, never
 * upgraded: its notes settled with no OCR record (v1), or with no record of the body they were sent with (v2).
 */
export class OldCheckpointError extends Error {}

/**
 * { checkpoint, reason }: a usable checkpoint and reason null, or checkpoint null and why it was not used. Throws
 * OldCheckpointError for a version-1 checkpoint: the person must start a new run on purpose (504), and the read's own
 * error for a file that cannot be read (EACCES, EISDIR): only a file that is not JSON is "starting over".
 */
export function loadCheckpoint(planPath, { plan, app, route = 'plain' }) {
  const path = checkpointPath(planPath);
  if (!existsSync(path)) return { checkpoint: null, reason: null };
  const raw = readFileSync(path, 'utf8'); // a file that cannot be READ (EACCES, EISDIR) is an error, not "starting over"
  let c;
  try { c = JSON.parse(raw); } catch { return { checkpoint: null, reason: 'The saved progress is not a checkpoint this tool wrote; starting over.' }; }
  if (isPlain(c) && c.format === FORMAT && c.version === 1) {
    throw new OldCheckpointError(`The saved progress (${path}) is from an earlier version of this tool, which did not send `
      + 'image text, so it cannot be continued. Delete that file to start a new run; notes already in Kosko are not sent twice.');
  }
  if (isPlain(c) && c.format === FORMAT && c.version === 2) {
    throw new OldCheckpointError(`The saved progress (${path}) is from an earlier version of this tool, which did not record `
      + 'the body each note was sent with, so it cannot be continued. Delete that file to start a new run; notes already in '
      + 'Kosko are not sent twice.');
  }
  if (isPlain(c) && c.format === FORMAT && c.version !== VERSION) return { checkpoint: null, reason: `The saved progress is from another version (${c.version}); starting over.` };
  if (!isCheckpoint(c)) return { checkpoint: null, reason: 'The saved progress is not a checkpoint this tool wrote; starting over.' };
  if (c.plan.sha256 !== plan.sha256 || c.plan.bytes !== plan.bytes) return { checkpoint: null, reason: 'The saved progress is for another plan; starting over.' };
  if (c.app !== app) return { checkpoint: null, reason: `The saved progress is for another Kosko (${c.app}); starting over.` };
  // 512: a run with --evernote and one without send different bodies; one is never continued as the other.
  if (c.route !== route) return { checkpoint: null, reason: `The saved progress is for the ${c.route === 'evernote' ? 'formatted (--evernote)' : 'plain-text'} route; starting over.` };
  return { checkpoint: c, reason: null };
}

// renameSync over a file another program holds open fails on Windows (EPERM/EBUSY): an editor, or antivirus scanning
// it. Retried briefly, as the dry run does for the plan (src/plan/dry-run.mjs).
function renameWithRetry(rename, from, to, tries = 5) {
  for (let i = 1; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * i);
    }
  }
}

export function saveCheckpoint(planPath, checkpoint, { rename = renameSync, now = () => new Date() } = {}) {
  const c = { ...checkpoint, updatedAt: now().toISOString() };
  if (!isCheckpoint(c)) throw new Error('Refusing to save: that is not a checkpoint this tool can read back.');
  const path = checkpointPath(planPath);
  const partial = `${path}.partial`;
  try {
    writeFileSync(partial, JSON.stringify(c), { mode: 0o600 });
    renameWithRetry(rename, partial, path);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  return c;
}
