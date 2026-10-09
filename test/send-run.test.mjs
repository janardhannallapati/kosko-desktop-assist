// 467 end to end against the in-memory Kosko (test/fixtures/fake-kosko.mjs): the synthetic account's plan is sent,
// the receipt equals the plan, a second run creates nothing, a stopped run resumes, and every rule that refuses has a
// case. The real local Kosko is 468's proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticAccount, ID, HASH } from './fixtures/synthetic-db.mjs';
import { runDryRun } from '../src/plan/dry-run.mjs';
import { runSend } from '../src/send/library/run-send.mjs';
import { createFakeKosko } from './fixtures/fake-kosko.mjs';

const TOKEN = `cvit_${'e5'.repeat(32)}`;
const APP = 'https://kosko.test';

async function setup({ mutate } = {}) {
  const acct = buildSyntheticAccount({ mutate });
  const outDir = mkdtempSync(join(tmpdir(), 'kda-send-'));
  await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const kosko = createFakeKosko();
  kosko.token = TOKEN;
  return { acct, planPath: join(outDir, 'kosko-plan.json'), kosko };
}
async function send(s, extra = {}) {
  const lines = [];
  const r = await runSend({ planPath: s.planPath, app: APP, token: TOKEN, dataDir: s.acct.dataDir, fetch: s.kosko.fetch,
    tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: (l) => lines.push(l), sleep: async () => {}, random: () => 0, ...extra });
  return { ...r, out: lines.join('\n') };
}

test('one run: every structure count equals the plan, and the receipt says so', async () => {
  const s = await setup();
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.equal(job.source, 'desktop');
  assert.equal(job.status, 'complete');
  assert.deepEqual(job.summary.expected, { notes: 4, attachments: 8, notebooks: 4, stacks: 2, tags: 2, noteTags: 2, trashedNotes: 1, missingFiles: 1, ocr: 6 });
  assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
  const a = job.summary.attachments;
  assert.equal(Object.values(a).reduce((t, n) => t + n, 0), 8, 'every attachment accounted for');
  assert.deepEqual(a, { stored: 4, placeholder: 1, over_cap: 0, type_not_stored: 0, unreadable: 3, not_imported_with_note: 0 });
  const d = job.receipt.desktop;
  assert.deepEqual({ ...d, missing: undefined }, { notebooks: 4, stacks: 2, spaceNotebooks: 1, tags: 2, tagsDropped: 0, noteTags: 2,
    trashedNotes: 1, missingFiles: 1, missing: undefined, missingMore: 0,
    // 504: present + Telugu + large have words; no-words is empty, and so is the missing file's scan, stored on its placeholder
    // (Kosko 500 rule 5); the bad-hex record is unreadable
    ocrWords: 3, ocrEmpty: 2, ocrUnreadable: 1, ocrNotSent: 0, ocrRefused: 0 });
  assert.deepEqual(d.missing, [{ note: 'Active note', name: 'lost.pdf' }]);
});

test('the notes carry GUID, dates, notebook, tags and their plain text; the Space note sits in its Space\'s notebook', async () => {
  const s = await setup();
  await send(s);
  const notes = [...s.kosko.state.notes.values()];
  const active = notes.find((n) => n.external_id === ID.nActive);
  assert.equal(active.title, 'Active note');
  assert.equal(active.created_at, '2014-03-04T10:30:15.000Z');
  assert.deepEqual(active.tags.sort(), ['alpha', 'alpha/beta']);
  assert.deepEqual(active.content.content[0], { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] });
  const media = active.content.content.slice(1);
  assert.equal(media.length, 3, 'present, missing and wrong-size each keep a node');
  assert.match(media[0].attrs.path, new RegExp(`^notes/${active.id}/images/${HASH.present}\\.png$`));
  assert.equal(media[1].attrs.missing, 'missing_from_cache');
  assert.equal(media[2].attrs.missing, 'unreadable');
  const odd = notes.find((n) => n.title === 'Odd id');
  assert.equal(odd.external_id, null, 'a GUID Kosko would refuse is sent as none');
  const spaceNote = notes.find((n) => n.title === 'In a Space');
  const spaceNb = [...s.kosko.state.notebooks.entries()].find(([, id]) => id === spaceNote.parent_id)[0];
  assert.equal(spaceNb, 'null|personal');
  assert.deepEqual(s.kosko.state.uploads.map((u) => u.bytes).sort((x, y) => x - y), [5, 6, 8, 10]);
  assert.ok(!s.kosko.state.uploads.some((u) => u.headers.authorization));
});

test('a second run creates nothing: all skipped, nothing uploaded, notebooks and tags reused', async () => {
  const s = await setup();
  await send(s);
  const uploads = s.kosko.state.uploads.length;
  const notesBefore = s.kosko.state.notes.size;
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 0, skipped: 4, not_imported: 0 });
  assert.equal(s.kosko.state.notes.size, notesBefore);
  assert.equal(s.kosko.state.uploads.length, uploads, 'nothing uploaded again');
  assert.equal(job.receipt.desktop.notebooks, 4);
  assert.equal(job.receipt.desktop.tags, 2);
  assert.equal(job.receipt.desktop.noteTags, 2, 'links on skipped notes are accounted for too (465 contract)');
  assert.equal(Object.values(job.summary.attachments).reduce((t, n) => t + n, 0), 8);
});

test('the count check runs first: a changed database stops the run before any request', async () => {
  const s = await setup();
  const plan = JSON.parse(readFileSync(s.planPath, 'utf8'));
  plan.counts.notes = 99;
  writeFileSync(s.planPath, JSON.stringify(plan));
  const r = await send(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /changed since the dry run/);
  assert.deepEqual(s.kosko.state.requests, []);
});

test('a clash is not sent and is named; ≤ 900 note-ids per call', async () => {
  const s = await setup();
  await send(s);
  // The same fp1 now held by a different GUID: rebuild the ledger so the Active note's fingerprint belongs to another.
  for (const [fp, e] of s.kosko.state.ledgerByFp) if (e.guid === ID.nActive) { s.kosko.state.ledgerByGuid.delete(ID.nActive); e.guid = 'someone-else'; }
  const r = await send(s);
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 0, skipped: 3, not_imported: 1 });
  assert.ok(job.receipt.notes.some((n) => n.title === 'Active note' && n.reason === 'id_clash'));
  assert.ok(s.kosko.state.noteIdCalls.every((n) => n <= 900));
});

test('id_taken is resent once under a new id; twice becomes id_clash with a refusal recorded', async () => {
  const s = await setup();
  s.kosko.state.noteErrors.set(ID.nActive, ['id_taken']);
  let r = await send(s);
  assert.equal(s.kosko.job(r.jobId).summary.notes.created, 4);
  const s2 = await setup();
  s2.kosko.state.noteErrors.set(ID.nActive, ['id_taken', 'id_taken']);
  r = await send(s2);
  const job = s2.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 3, updated: 0, skipped: 0, not_imported: 1 });
  assert.equal(job.summary.reasons.id_clash, 1);
  assert.equal(s2.kosko.state.refusals.length, 1);
  assert.equal(s2.kosko.state.refusals[0].reason, 'id_clash');
});

test('quota_exceeded is recorded as a refusal and named; the job still closes with everything accounted for', async () => {
  const s = await setup();
  s.kosko.state.noteErrors.set(ID.nActive, ['quota_exceeded']);
  const r = await send(s);
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 3, updated: 0, skipped: 0, not_imported: 1 });
  assert.equal(s.kosko.state.refusals[0].reason, 'quota_exceeded');
  assert.equal(Object.values(job.summary.attachments).reduce((t, n) => t + n, 0), 8);
  assert.equal(job.summary.attachments.not_imported_with_note, 3);
  assert.equal(job.receipt.desktop.missingFiles, 1, 'a missing file of a refused note is still named');
});

test('a stopped run resumes the same job and finishes it; the totals equal a single run\'s', async () => {
  const s = await setup();
  // The token expires after the first notes batch: every later request is refused, so the run stops and cannot even
  // close its job — which stays running, as after a crash. The next run, with a working token, continues it.
  const real = s.kosko.fetch;
  let batches = 0;
  let expired = false;
  const flaky = async (url, init) => {
    if (String(url).endsWith('/api/import/notes/batch') && ++batches === 2) expired = true;
    if (expired && !String(url).startsWith('https://store.test')) return new Response(JSON.stringify({ error: 'x' }), { status: 401 });
    return real(url, init);
  };
  const first = await send(s, { fetch: flaky, batchNotes: 2 });
  assert.equal(first.exitCode, 1);
  assert.match(first.out, /not valid any more/);
  const sentFirst = s.kosko.state.notes.size;
  assert.ok(sentFirst > 0 && sentFirst < 4);
  const second = await send(s, { batchNotes: 2 });
  assert.equal(second.exitCode, 0, second.out);
  const job = s.kosko.job(second.jobId);
  assert.equal(second.jobId, first.jobId, 'the running job is continued');
  assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
  assert.equal(s.kosko.state.notes.size, 4);
});

test('Ctrl-C leaves the job running; the next run continues it, keeping every outcome and attachment bucket', async () => {
  // Kosko refuses the Active note's picture at mint (type_not_stored): a verdict only that run knows, which the
  // resumed run must count as that run did, not as `stored` (review H2).
  const s = await setup();
  s.kosko.state.mintErrors.push('type_not_stored');
  const ac = new AbortController();
  const real = s.kosko.fetch;
  let batches = 0;
  const stopping = async (url, init) => {
    const res = await real(url, init);
    if (String(url).endsWith('/api/import/notes/batch') && ++batches === 1) ac.abort(); // after the first batch landed
    return res;
  };
  const first = await send(s, { fetch: stopping, signal: ac.signal, batchNotes: 2 });
  assert.equal(first.exitCode, 130);
  assert.equal(s.kosko.job(first.jobId).status, 'running', 'left running, so it can be continued');
  assert.match(first.out, /Run the same command again/);
  const second = await send(s, { batchNotes: 2 });
  assert.equal(second.exitCode, 0, second.out);
  assert.equal(second.jobId, first.jobId);
  const job = s.kosko.job(second.jobId);
  assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
  assert.deepEqual(job.summary.attachments, { stored: 3, placeholder: 1, over_cap: 0, type_not_stored: 1, unreadable: 3, not_imported_with_note: 0 });
});

test('an expired upload link is minted again once; a re-mint refused leaves an honest placeholder, never a dead path', async () => {
  const s = await setup();
  s.kosko.state.expireUploads = 1;
  let r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.job(r.jobId).summary.attachments.stored, 4);
  const s2 = await setup();
  s2.kosko.state.expireUploads = 1;
  const real = s2.kosko.fetch;
  let mints = 0;
  const refuseRemint = async (url, init) => {
    if (String(url).endsWith('/api/import/attachments/batch') && ++mints === 2) s2.kosko.state.mintErrors.push('type_not_stored');
    return real(url, init);
  };
  r = await send(s2, { fetch: refuseRemint });
  assert.equal(r.exitCode, 0, r.out);
  const active = [...s2.kosko.state.notes.values()].find((n) => n.external_id === ID.nActive);
  assert.equal(active.content.content[1].attrs.missing, 'type_not_stored');
  assert.equal(s2.kosko.job(r.jobId).summary.attachments.type_not_stored, 1);
});

test('the console says counts, never a title, the text or the token', async () => {
  const s = await setup();
  const r = await send(s);
  for (const secret of ['Active note', 'hello world', 'In a Space', TOKEN.slice(5)]) assert.ok(!r.out.includes(secret), secret);
  assert.match(r.out, /4 of 4 notes/);
  assert.match(r.out, new RegExp(`${APP}/import/receipt/${r.jobId}`));
});

test('every tag is sent, the unused ones too, at most 1,000 names per call', async () => {
  const s = await setup({ mutate: (db) => {
    const add = db.prepare('INSERT INTO Nodes_Tag (id, label, localChangeTimestamp, version) VALUES (?, ?, 0, 1)');
    for (let i = 0; i < 1500; i++) add.run(`extra-${i}`, `unused ${i}`);
  } });
  const r = await send(s);
  assert.deepEqual(s.kosko.state.tagCalls, [1000, 502]);
  assert.equal(s.kosko.job(r.jobId).receipt.desktop.tags, 1502);
});

test('a cached file that changed since the dry run is never uploaded; it is counted unreadable (review M3)', async () => {
  const s = await setup();
  writeFileSync(join(s.acct.resourceCacheDir, ID.nActive, HASH.present), Buffer.alloc(6, 2)); // was 5 bytes
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.ok(!s.kosko.state.uploads.some((u) => u.path.endsWith(`${HASH.present}.png`)), 'the changed file is never PUT');
  assert.equal(s.kosko.state.uploads.length, 3, 'only the Space note\'s three scans');
  assert.equal(s.kosko.job(r.jobId).summary.attachments.unreadable, 4);
});

test('an answer that is neither an outcome nor an error is sent again, never settled blind (review M1)', async () => {
  const s = await setup();
  s.kosko.state.badAnswers.add(ID.nActive);
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.deepEqual(s.kosko.job(r.jobId).summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
});
