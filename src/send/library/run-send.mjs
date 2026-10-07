// 467 — `kosko-assist send`: the dry run's plan, sent to Kosko in seven steps (doc 467's diagram): the count check,
// the job, notebooks, tags, then the notes a batch at a time (send-notes.mjs), then the receipt. Every request goes
// through 466's sender (one in flight, busy and transient handled there); a stop closes the job with what was done and
// keeps the checkpoint, so the next run continues where this one stopped.
import { pickAccount } from '../../plan/dry-run.mjs';
import { openAccount } from '../../reader/reader.mjs';
import { createImportApi } from '../api.mjs';
import { createSender } from '../sender.mjs';
import { startThroughGate } from '../gate.mjs';
import { SendStopped } from '../errors.mjs';
import { redact } from '../token.mjs';
import { planFingerprint, emptyCheckpoint, loadCheckpoint, saveCheckpoint, OldCheckpointError } from '../checkpoint.mjs';
import { loadPlan, countDifferences, expectedOf } from './plan-file.mjs';
import { notebookPlan, tagPaths, noteTagNames } from './structure.mjs';
import { fingerprintsFor, versionOf } from './note-record.mjs';
import { decideAttachment } from './attachments.mjs';
import { createTally, emptyAttachmentCounts } from './tally.mjs';
import { createNoteSender } from './send-notes.mjs';
import { createOcrSender, ocrCounts } from './send-ocr.mjs';

const BATCH_NOTES = 25; // Kosko 434 r1: 25 notes or 3.5 MB of JSON per batch
const BATCH_BYTES = 3.5 * 1024 * 1024;
const TAG_CALL = 1000; // 464
const UPLOAD_LANES = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (n) => Number(n).toLocaleString('en-US');

async function countCheck({ plan, dataDir, accountId, open, tmpRoot }) {
  const { account } = pickAccount(dataDir, accountId ?? plan.source?.userId);
  const reader = await open(account, { tmpRoot });
  try {
    return { differences: countDifferences(plan.counts, reader.counts()), resourceCacheDir: account.resourceCacheDir };
  } finally { reader.close(); }
}

export async function runSend({ planPath, app, token, dataDir, accountId, fetch, signal, tmpRoot, sleep, random, now,
  log = (line) => process.stdout.write(`${line}\n`), open = openAccount, batchNotes = BATCH_NOTES }) {
  let plan;
  let resourceCacheDir;
  try {
    plan = loadPlan(planPath);
    const checked = await countCheck({ plan, dataDir, accountId, open, tmpRoot });
    if (checked.differences.length) {
      log(`Evernote changed since the dry run, so nothing was sent:\n  - ${checked.differences.join('\n  - ')}\nRun dry-run again, then send.`);
      return { exitCode: 1 };
    }
    resourceCacheDir = checked.resourceCacheDir;
  } catch (e) {
    log(redact(e.message));
    return { exitCode: 1 };
  }

  const timing = { signal, sleep, random, now };
  const api = createImportApi({ app, token, fetch, signal });
  const sender = createSender({ ...timing, onWait: ({ kind, ms }) => { if (ms >= 3000) log(`Kosko is ${kind === 'busy' ? 'busy' : 'not answering'}; waiting ${Math.round(ms / 1000)} s…`); } });
  const lanes = Array.from({ length: UPLOAD_LANES }, () => createSender(timing));
  const expected = expectedOf(plan);
  const tally = createTally();
  const structure = { notebooks: 0, stacks: 0, spaceNotebooks: 0, tags: 0, tagsDropped: 0 };
  const fp = await planFingerprint(planPath);
  let cp = null;
  let jobId = null;
  let loaded;
  try {
    loaded = loadCheckpoint(planPath, { plan: fp, app: api.origin });
  } catch (e) {
    if (!(e instanceof OldCheckpointError)) throw e;
    log(e.message); // before any request: a W2 checkpoint is never continued as if it had sent image text
    return { exitCode: 1 };
  }

  try {
    const allowance = await sender.call(() => api.allowance());
    if (loaded.reason) log(loaded.reason);
    if (loaded.checkpoint?.jobId) {
      const newest = await sender.call(() => api.newestJob());
      if (newest?.job?.id === loaded.checkpoint.jobId && newest.job.status === 'running') { cp = loaded.checkpoint; jobId = cp.jobId; log('Continuing the import that stopped.'); }
    }
    if (!jobId) {
      // A new job starts the notes over: the ledger answers `skipped` for any already there, so nothing is duplicated.
      const job = await sender.call(() => startThroughGate(api, { source: 'desktop', expected }, { ...timing,
        onWaiting: ({ position, etaMinutes }) => log(`Imports are busy; you are ${position === 1 ? 'next' : `number ${position ?? '?'}`} in line${etaMinutes ? `, about ${etaMinutes} min` : ''}. Waiting…`) }));
      jobId = job.id;
      cp = { ...emptyCheckpoint({ plan: fp, app: api.origin }), jobId };
      saveCheckpoint(planPath, cp);
    }

    // Notebooks: one call, stacks as parents, Space notebooks (467 rules 3-4). The route reuses what already exists.
    const { entries, parentKeyOf } = notebookPlan(plan);
    const nb = await sender.call(() => api.notebooks({ job_id: jobId, notebooks: entries }));
    const ids = Object.fromEntries(Object.entries(nb.ids ?? {}).filter(([, v]) => UUID_RE.test(String(v))));
    for (const e of entries) {
      if (!ids[e.key]) continue;
      const kind = e.key.split(':')[0];
      structure[kind === 'nb' ? 'notebooks' : kind === 'stack' ? 'stacks' : 'spaceNotebooks'] += 1;
    }
    cp.notebooks = ids;

    // Every tag, the unused ones too, by its full path (rule 5): one name per plan row, so the counts add up.
    const paths = tagPaths(plan.tags);
    const names = plan.tags.map((t) => paths.get(t.id));
    for (let i = 0; i < names.length; i += TAG_CALL) {
      const r = await sender.call(() => api.tags({ job_id: jobId, names: names.slice(i, i + TAG_CALL) }));
      structure.tags += r.created + r.reused;
      structure.tagsDropped += r.dropped;
    }
    cp.tags = { done: true };
    saveCheckpoint(planPath, cp);

    // The notes, each with what it needs to be settled from any path.
    const tagsOf = noteTagNames(plan.noteTags, paths);
    const fps = await fingerprintsFor(plan.notes);
    const attsOf = new Map();
    for (const a of plan.attachments) { if (!attsOf.has(a.noteId)) attsOf.set(a.noteId, []); attsOf.get(a.noteId).push(a); }
    const nbName = new Map(entries.map((e) => [e.key, e.name]));
    const info = await Promise.all(plan.notes.map(async (note, i) => {
      const atts = (attsOf.get(note.id) ?? []).map((a) => ({ a, d: decideAttachment(a, allowance) }));
      const tags = tagsOf.get(note.id) ?? [];
      return { note, key: note.id, fp: fps[i], parentKey: parentKeyOf(note), tags, atts,
        version: await versionOf(note, tags, [...new Set(atts.map(({ a }) => a.dataHash))]) };
    }));
    const settle = (x, outcome, reason) => {
      x.outcome = outcome;
      const counts = emptyAttachmentCounts();
      for (const { a, d } of x.atts) {
        // Settled in this run: its own verdict. Settled by the run that stopped: what that run recorded (review H2).
        const bucket = x.resumed && typeof cp.attachments[a.id] === 'string' ? cp.attachments[a.id]
          : d.upload ? (x.failed?.get(a.dataHash)?.[1] ?? (x.refusedTypes?.has(a.dataHash) ? 'type_not_stored' : 'stored')) : d.count;
        counts[bucket] += 1;
        cp.attachments[a.id] = outcome === 'not_imported' ? 'not_imported_with_note' : bucket;
      }
      tally.settle(x.key, { outcome, reason, title: x.note.title, notebook: nbName.get(x.parentKey) ?? '', tagCount: x.tags.length,
        attachmentRows: x.atts.length, counts, missingFiles: x.atts.filter(({ d }) => d.missing === 'missing_from_cache').map(({ a }) => a.filename) });
      cp.notes[x.key] = reason ? `${outcome}:${reason}` : outcome;
    };
    const resumed = [];
    for (const x of info) {
      if (!Object.hasOwn(cp.notes, x.key)) continue;
      const [o, r] = cp.notes[x.key].split(':');
      const y = { ...x, resumed: true };
      settle(y, o, r ?? null);
      resumed.push(y);
    }
    const sendBatch = createNoteSender({ api, sender, lanes, jobId, resourceCacheDir, cp, settle });
    // 504: image text goes after its notes settle. Notes the stopped run settled get theirs first (their ids are asked
    // for again); records already in the checkpoint are never sent twice.
    const sendOcr = createOcrSender({ api, sender, jobId, cp, plan });
    await sendOcr(resumed);
    saveCheckpoint(planPath, cp);
    const pending = info.filter((x) => !tally.settledKeys.has(x.key));
    for (let i = 0; i < pending.length;) {
      const batch = [];
      let bytes = 0;
      while (i < pending.length && batch.length < batchNotes) {
        const est = Buffer.byteLength(pending[i].note.plainText ?? '') + Buffer.byteLength(pending[i].note.title ?? '') + 4096;
        if (batch.length && bytes + est > BATCH_BYTES) break;
        batch.push(pending[i++]);
        bytes += est;
      }
      await sendBatch(batch);
      saveCheckpoint(planPath, cp); // the notes are settled even if their image text is not yet
      await sendOcr(batch);
      saveCheckpoint(planPath, cp);
      log(`Sent ${num(tally.counts().settled)} of ${num(plan.notes.length)} notes.`);
    }

    const { notes, settled } = tally.counts();
    const allSettled = settled === plan.notes.length;
    const { summary, receipt } = tally.build({ expected, structure, trashedNotes: plan.counts.trashedNotes, ocr: ocrCounts(cp.ocr) });
    await sender.call(() => api.finishJob(jobId, { status: allSettled ? 'complete' : 'failed', summary, receipt }));
    log(`Done: ${num(notes.created)} created, ${num(notes.skipped)} already in Kosko, ${num(notes.not_imported)} not imported — `
      + `${num(settled)} of ${num(plan.notes.length)} notes accounted for.\nReceipt: ${api.origin}/import/receipt/${jobId}`);
    return { exitCode: allSettled ? 0 : 1, jobId, summary, receipt };
  } catch (e) {
    if (!(e instanceof SendStopped)) { log(redact(`The import stopped: ${e.message}`)); }
    else log(redact(e.message));
    if (cp) { try { saveCheckpoint(planPath, cp); } catch { /* the checkpoint is a convenience; the ledger is the truth */ } }
    // The job is left RUNNING (467 review H1): the next run finds it the newest and running and continues it from the
    // checkpoint, keeping every settled note's outcome and reason. Kosko's receipt page says "Not finished … run the
    // desktop assist again", which is true. Only a job Kosko itself closed (job_closed) is gone; the next run starts anew.
    if (jobId) log(`Run the same command again to continue. The import so far: ${api.origin}/import/receipt/${jobId}`);
    return { exitCode: e instanceof SendStopped && e.code === 'aborted' ? 130 : 1, jobId };
  }
}
