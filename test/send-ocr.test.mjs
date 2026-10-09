// 504 — Evernote's image text sent after each notes batch: batching by count and bytes, which notes' records are sent,
// unreadable records never, a second run storing nothing new, a stopped run resuming mid-OCR, a version-1 checkpoint
// refused, and the receipt's five counts adding up to the plan's tally.ocr. Against the in-memory Kosko.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticAccount, ID, HASH, TELUGU_WORDS, LARGE_WORDS } from './fixtures/synthetic-db.mjs';
import { runDryRun } from '../src/plan/dry-run.mjs';
import { runSend } from '../src/send/library/run-send.mjs';
import { createOcrSender, ocrCounts } from '../src/send/library/send-ocr.mjs';
import { checkpointPath, emptyCheckpoint } from '../src/send/checkpoint.mjs';
import { createFakeKosko } from './fixtures/fake-kosko.mjs';

const TOKEN = `cvit_${'e5'.repeat(32)}`;
const APP = 'https://kosko.test';
const JOB = '11111111-2222-4333-8444-555555555555';
const NOTE = '22222222-2222-4333-8444-555555555555';
const sumOf = (d) => d.ocrWords + d.ocrEmpty + d.ocrUnreadable + d.ocrNotSent + d.ocrRefused;

async function setup() {
  const acct = buildSyntheticAccount();
  const outDir = mkdtempSync(join(tmpdir(), 'kda-ocr-'));
  await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const kosko = createFakeKosko();
  kosko.token = TOKEN;
  const bodies = []; // every ocr/batch body as sent
  const fetch = async (url, init) => {
    if (String(url).endsWith('/api/import/ocr/batch')) bodies.push(JSON.parse(init.body));
    return kosko.fetch(url, init);
  };
  return { acct, planPath: join(outDir, 'kosko-plan.json'), kosko, bodies, fetch };
}
async function send(s, extra = {}) {
  const lines = [];
  const r = await runSend({ planPath: s.planPath, app: APP, token: TOKEN, dataDir: s.acct.dataDir, fetch: s.fetch,
    tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: (l) => lines.push(l), sleep: async () => {}, random: () => 0, ...extra });
  return { ...r, out: lines.join('\n') };
}
const sentItems = (s) => s.bodies.flatMap((b) => b.items);

test('one run: words and empty scans are stored under the note\'s Kosko id; the five counts add up to the plan', async () => {
  const s = await setup();
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  const d = job.receipt.desktop;
  assert.equal(job.summary.expected.ocr, 6);
  assert.equal(sumOf(d), job.summary.expected.ocr, 'every OCR record of the plan is in exactly one count');
  assert.deepEqual([d.ocrWords, d.ocrEmpty, d.ocrUnreadable, d.ocrNotSent, d.ocrRefused], [3, 2, 1, 0, 0]);
  const space = [...s.kosko.state.notes.values()].find((n) => n.title === 'In a Space');
  assert.deepEqual(s.kosko.state.ocr.get(`${space.id}|${HASH.telugu}`), { status: 'words', text: TELUGU_WORDS });
  assert.deepEqual(s.kosko.state.ocr.get(`${space.id}|${HASH.largeScan}`), { status: 'words', text: LARGE_WORDS });
  assert.ok(LARGE_WORDS.length > 8500);
  assert.deepEqual(s.kosko.state.ocr.get(`${space.id}|${HASH.noWords}`), { status: 'empty', text: '' });
  for (const b of s.bodies) {
    assert.deepEqual(Object.keys(b).sort(), ['items', 'job_id']);
    assert.equal(b.job_id, r.jobId);
  }
  assert.ok(!r.out.includes(TELUGU_WORDS) && !r.out.includes('scan0001'), 'image text is never logged');
});

test('unreadable records are never sent; records of a note not imported are counted not sent', async () => {
  const s = await setup();
  s.kosko.state.noteErrors.set(ID.nActive, ['quota_exceeded']);
  const r = await send(s);
  const d = s.kosko.job(r.jobId).receipt.desktop;
  const md5s = sentItems(s).map((i) => i.md5);
  assert.ok(!md5s.includes(HASH.wrongSize), 'the bad-hex record is never sent');
  assert.ok(!md5s.includes(HASH.present) && !md5s.includes(HASH.missing), 'the refused note\'s records are not sent');
  assert.deepEqual([d.ocrWords, d.ocrEmpty, d.ocrUnreadable, d.ocrNotSent, d.ocrRefused], [2, 1, 1, 2, 0]);
  assert.equal(sumOf(d), 6);
});

test('a W2-era import is backfilled: skipped notes get their image text under their existing ids', async () => {
  const s = await setup();
  await send(s);
  const ids = new Map([...s.kosko.state.notes.values()].map((n) => [n.title, n.id]));
  s.kosko.state.ocr.clear(); // as if the first run had been a W2 run, which sent no OCR
  rmSync(checkpointPath(s.planPath));
  s.bodies.length = 0;
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 0, skipped: 4, not_imported: 0 });
  assert.equal(job.receipt.desktop.ocrWords, 3);
  assert.equal(s.kosko.state.ocr.get(`${ids.get('In a Space')}|${HASH.telugu}`)?.text, TELUGU_WORDS);
  assert.ok(sentItems(s).every((i) => [...ids.values()].includes(i.note_id)), 'only the notes Kosko already holds');
  assert.equal(s.kosko.state.ocrCalls.at(-1).answer.created, 5, 'all five readable records stored, none refused');
});

test('a second run stores nothing new: every record comes back unchanged and the counts are the same', async () => {
  const s = await setup();
  const first = await send(s);
  const rows = s.kosko.state.ocr.size;
  const calls = s.kosko.state.ocrCalls.length;
  const second = await send(s);
  assert.equal(second.exitCode, 0, second.out);
  assert.equal(s.kosko.state.ocr.size, rows);
  const answers = s.kosko.state.ocrCalls.slice(calls).map((c) => c.answer);
  assert.ok(answers.length > 0);
  assert.equal(answers.reduce((t, a) => t + a.created + a.updated, 0), 0, 'nothing created or updated');
  assert.deepEqual(s.kosko.job(second.jobId).receipt.desktop.ocrWords, s.kosko.job(first.jobId).receipt.desktop.ocrWords);
});

test('a run stopped mid-OCR resumes: records already stored are not sent again, the rest are, totals equal one run', async () => {
  const s = await setup();
  let ocrCalls = 0;
  let expired = false;
  const flaky = async (url, init) => {
    if (String(url).endsWith('/api/import/ocr/batch') && ++ocrCalls === 2) expired = true;
    if (expired && !String(url).startsWith('https://store.test')) return new Response(JSON.stringify({ error: 'x' }), { status: 401 });
    return s.fetch(url, init);
  };
  const first = await send(s, { fetch: flaky, batchNotes: 1 });
  assert.equal(first.exitCode, 1);
  const storedFirst = new Set(sentItems(s).map((i) => i.md5));
  assert.ok(storedFirst.size > 0 && s.kosko.state.ocr.size < 5, 'stopped part way through the image text');
  const space = [...s.kosko.state.notes.values()].find((n) => n.title === 'In a Space');
  assert.ok(space, 'the Space note itself settled before its image text was sent');
  s.bodies.length = 0;
  const second = await send(s, { batchNotes: 1 });
  assert.equal(second.exitCode, 0, second.out);
  assert.equal(second.jobId, first.jobId);
  for (const i of sentItems(s)) assert.ok(!storedFirst.has(i.md5), `${i.md5} was sent twice`);
  const d = s.kosko.job(second.jobId).receipt.desktop;
  assert.deepEqual([d.ocrWords, d.ocrEmpty, d.ocrUnreadable, d.ocrNotSent, d.ocrRefused], [3, 2, 1, 0, 0]);
  assert.equal(s.kosko.state.ocr.size, 5, 'every readable record, once');
  assert.equal(s.kosko.state.ocr.get(`${space.id}|${HASH.telugu}`)?.text, TELUGU_WORDS, 'a resumed note\'s id is asked for again');
});

test('a version-1 checkpoint is refused before any request, telling the person to start a new run', async () => {
  const s = await setup();
  const { ocr, ...v1 } = emptyCheckpoint({ plan: { sha256: '0'.repeat(64), bytes: 1 }, app: APP, jobId: JOB });
  writeFileSync(checkpointPath(s.planPath), JSON.stringify({ ...v1, version: 1 }));
  const r = await send(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /earlier version of this tool/);
  assert.match(r.out, /start a new run/);
  assert.deepEqual(s.kosko.state.requests, [], 'nothing was sent');
});

// The batcher alone, with an api that records each call.
function harness({ records, maxItems, maxBytes }) {
  const calls = [];
  const api = { ocrBatch: async (body) => { calls.push(body); return { created: body.items.length, updated: 0, unchanged: 0, refused: [] }; },
    noteIds: async () => { throw new Error('not asked'); } };
  const plan = { notes: [{ id: 'g1' }], attachments: records.map((_, i) => ({ id: `a${i}`, noteId: 'g1', dataHash: String(i).padStart(32, '0') })),
    ocr: records.map((text, i) => ({ attachmentId: `a${i}`, text, wordCount: text ? 1 : 0 })), problems: { ocrErrors: [] } };
  const cp = { ...emptyCheckpoint({ plan: { sha256: '0'.repeat(64), bytes: 1 }, app: APP, jobId: JOB }) };
  const send = createOcrSender({ api, sender: { call: (f) => f() }, jobId: JOB, cp, plan, maxItems, maxBytes });
  return { calls, cp, run: () => send([{ key: 'g1', fp: 'fp', outcome: 'created', koskoId: NOTE }]) };
}

test('batches: at most 500 items a call', async () => {
  const h = harness({ records: Array.from({ length: 1201 }, (_, i) => `w${i}`) });
  await h.run();
  assert.deepEqual(h.calls.map((c) => c.items.length), [500, 500, 201]);
  assert.equal(ocrCounts(h.cp.ocr).ocrWords, 1201);
});

test('batches: at most 3.5 MB of JSON a call, by the bytes of the whole body', async () => {
  const big = 'ఆ'.repeat(30000); // 90 KB of UTF-8 each, under the 32,768-character cap
  const h = harness({ records: Array.from({ length: 100 }, () => big) });
  await h.run();
  assert.ok(h.calls.length >= 3, `${h.calls.length} calls`);
  for (const c of h.calls) assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 3.5 * 1024 * 1024, 'over 3.5 MB');
  assert.equal(h.calls.reduce((t, c) => t + c.items.length, 0), 100);
});

test('an empty scan is sent as status empty with "" text; a blank text is empty too; over 32,768 characters is refused locally', async () => {
  const h = harness({ records: ['', '   ', 'x'.repeat(32769), 'words here'] });
  await h.run();
  assert.deepEqual(h.calls[0].items.map((i) => [i.status, i.text.length]), [['empty', 0], ['empty', 0], ['words', 10]]);
  assert.deepEqual(h.calls[0].items.map((i) => i.note_id), [NOTE, NOTE, NOTE]);
  assert.equal(h.cp.ocr.a2, 'refused:too_long');
});

test('benign: a refusal names its item; the others are stored', async () => {
  const calls = [];
  const api = { ocrBatch: async (body) => { calls.push(body); return { created: 1, updated: 0, unchanged: 0, refused: [{ i: 0, reason: 'not_an_attachment' }] }; } };
  const plan = { notes: [{ id: 'g1' }], attachments: [{ id: 'a0', noteId: 'g1', dataHash: 'A'.repeat(32) }, { id: 'a1', noteId: 'g1', dataHash: 'b'.repeat(32) }],
    ocr: [{ attachmentId: 'a0', text: 'x', wordCount: 1 }, { attachmentId: 'a1', text: 'y', wordCount: 1 }], problems: { ocrErrors: [] } };
  const cp = emptyCheckpoint({ plan: { sha256: '0'.repeat(64), bytes: 1 }, app: APP, jobId: JOB });
  await createOcrSender({ api, sender: { call: (f) => f() }, jobId: JOB, cp, plan })([{ key: 'g1', outcome: 'skipped', koskoId: NOTE }]);
  assert.equal(calls[0].items[0].md5, 'a'.repeat(32), 'md5 lowercased');
  assert.deepEqual(cp.ocr, { a0: 'refused:not_an_attachment', a1: 'words' });
});

test('a record already in the checkpoint is not sent again, even beside one of the same note that is not', async () => {
  const calls = [];
  const api = { ocrBatch: async (body) => { calls.push(body); return { created: body.items.length, updated: 0, unchanged: 0, refused: [] }; } };
  const plan = { notes: [{ id: 'g1' }], attachments: [{ id: 'a0', noteId: 'g1', dataHash: 'a'.repeat(32) }, { id: 'a1', noteId: 'g1', dataHash: 'b'.repeat(32) }],
    ocr: [{ attachmentId: 'a0', text: 'x', wordCount: 1 }, { attachmentId: 'a1', text: 'y', wordCount: 1 }], problems: { ocrErrors: [] } };
  const cp = { ...emptyCheckpoint({ plan: { sha256: '0'.repeat(64), bytes: 1 }, app: APP, jobId: JOB }), ocr: { a0: 'refused:locked' } };
  await createOcrSender({ api, sender: { call: (f) => f() }, jobId: JOB, cp, plan })([{ key: 'g1', outcome: 'created', koskoId: NOTE }]);
  assert.deepEqual(calls.map((c) => c.items.map((i) => i.md5)), [['b'.repeat(32)]]);
  assert.deepEqual(cp.ocr, { a0: 'refused:locked', a1: 'words' }, 'the earlier bucket is kept');
});

test('a scan of a file missing from this computer is stored as its status, through the note\'s placeholder (Kosko 500 rule 5)', async () => {
  const s = await setup();
  const r = await send(s);
  const active = [...s.kosko.state.notes.values()].find((n) => n.external_id === ID.nActive);
  assert.ok(JSON.stringify(active.content).includes(`enex-resource:${HASH.missing}`), 'the note keeps a placeholder for it');
  assert.deepEqual(s.kosko.state.ocr.get(`${active.id}|${HASH.missing}`), { status: 'empty', text: '' });
  assert.equal(s.kosko.job(r.jobId).receipt.desktop.ocrRefused, 0);
});

test('an md5 stored under ANOTHER note\'s folder is refused not_an_attachment; the item counts as refused', async () => {
  const s = await setup();
  await send(s);
  const notes = [...s.kosko.state.notes.values()];
  const active = notes.find((n) => n.external_id === ID.nActive);
  const space = notes.find((n) => n.title === 'In a Space');
  // The Active note's stored picture, claimed for the Space note: the md5 is real, but not under notes/<space id>/.
  const res = await s.kosko.fetch(`${APP}/api/import/jobs`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ source: 'desktop' }) });
  const { id: job } = await res.json();
  const ans = await s.kosko.fetch(`${APP}/api/import/ocr/batch`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ job_id: job, items: [
      { note_id: space.id, md5: HASH.present, status: 'words', text: 'x' },
      { note_id: active.id, md5: HASH.present, status: 'words', text: 'x' }] }) });
  const body = await ans.json();
  assert.deepEqual(body.refused, [{ i: 0, reason: 'not_an_attachment' }]);
  assert.equal(body.created + body.updated + body.unchanged, 1, 'the same md5 under its own note is accepted');
  // And through the tool: a refusal lands in the receipt's ocrRefused, never in stored.
  const calls = [];
  const api = { ocrBatch: async (b) => { calls.push(b); return (await s.kosko.fetch(`${APP}/api/import/ocr/batch`, { method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(b) })).json(); } };
  const plan = { notes: [{ id: 'g1' }], attachments: [{ id: 'a0', noteId: 'g1', dataHash: HASH.present }],
    ocr: [{ attachmentId: 'a0', text: 'x', wordCount: 1 }], problems: { ocrErrors: [] } };
  const cp = emptyCheckpoint({ plan: { sha256: '0'.repeat(64), bytes: 1 }, app: APP, jobId: job });
  await createOcrSender({ api, sender: { call: (f) => f() }, jobId: job, cp, plan })([{ key: 'g1', outcome: 'skipped', koskoId: space.id }]);
  assert.deepEqual(cp.ocr, { a0: 'refused:not_an_attachment' });
  assert.equal(ocrCounts(cp.ocr).ocrRefused, 1);
});

// Review fixes: a reply that is not what Kosko promises stops the run, and that batch is left unbucketed so the next
// run sends it again.
const TEXT = 'secret words';
function strict({ answer, noteIds }) {
  const calls = [];
  const api = { ocrBatch: async (body) => { calls.push(body); return typeof answer === 'function' ? answer(body) : answer; },
    noteIds: async (body) => (typeof noteIds === 'function' ? noteIds(body) : noteIds) };
  const plan = { notes: [{ id: 'g1' }], attachments: [{ id: 'a0', noteId: 'g1', dataHash: 'a'.repeat(32) }, { id: 'a1', noteId: 'g1', dataHash: 'b'.repeat(32) }],
    ocr: [{ attachmentId: 'a0', text: TEXT, wordCount: 2 }, { attachmentId: 'a1', text: 'y', wordCount: 1 }], problems: { ocrErrors: [] } };
  const cp = emptyCheckpoint({ plan: { sha256: '0'.repeat(64), bytes: 1 }, app: APP, jobId: JOB });
  const send = createOcrSender({ api, sender: { call: (f) => f() }, jobId: JOB, cp, plan });
  return { calls, cp, send };
}
const stops = async (p) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.name, 'SendStopped');
    assert.ok(!e.message.includes(TEXT), 'image text never in an error');
    return true;
  });
};

for (const [name, answer] of [
  ['the counts do not add up to the items', { created: 1, updated: 0, unchanged: 0, refused: [] }],
  ['more counted than sent', { created: 2, updated: 0, unchanged: 0, refused: [{ i: 0, reason: 'locked' }] }],
  ['a refused index out of range', { created: 1, updated: 0, unchanged: 0, refused: [{ i: 2, reason: 'locked' }] }],
  ['a refused index that is not an integer', { created: 1, updated: 0, unchanged: 0, refused: [{ i: '0', reason: 'locked' }] }],
  ['a refused index named twice', { created: 0, updated: 0, unchanged: 0, refused: [{ i: 0, reason: 'locked' }, { i: 0, reason: 'locked' }] }],
  ['a negative count', { created: 3, updated: -1, unchanged: 0, refused: [] }],
  ['a fractional count', { created: 1.5, updated: 0.5, unchanged: 0, refused: [] }],
  ['no refused list', { created: 2, updated: 0, unchanged: 0 }],
  ['not an object', null]
]) {
  test(`an ocr/batch reply that does not reconcile stops the run and buckets nothing: ${name}`, async () => {
    const h = strict({ answer });
    await stops(h.send([{ key: 'g1', outcome: 'created', koskoId: NOTE }]));
    assert.deepEqual(h.cp.ocr, {}, 'the batch is not bucketed');
    // The next run sends the same records again.
    const again = strict({ answer: { created: 2, updated: 0, unchanged: 0, refused: [] } });
    Object.assign(again.cp.ocr, h.cp.ocr);
    await again.send([{ key: 'g1', outcome: 'created', koskoId: NOTE }]);
    assert.equal(again.calls[0].items.length, 2);
  });
}

test('a reconciled reply with a refusal still buckets each item', async () => {
  const h = strict({ answer: { created: 0, updated: 0, unchanged: 1, refused: [{ i: 1, reason: 'locked' }] } });
  await h.send([{ key: 'g1', outcome: 'created', koskoId: NOTE }]);
  assert.deepEqual(h.cp.ocr, { a0: 'words', a1: 'refused:locked' });
});

for (const [name, noteIds] of [
  ['no ids object', {}],
  ['ids is not an object', { ids: [] }],
  ['the fingerprint asked about is missing', { ids: { other: { id: null, state: 'trash' } } }],
  ['an unknown state', { ids: { fp1: { id: null, state: 'gone' } } }],
  ['here without a uuid', { ids: { fp1: { id: 'nope', state: 'here' } } }]
]) {
  test(`a note-ids reply that does not answer the note stops the run; not_sent is never guessed: ${name}`, async () => {
    const h = strict({ answer: { created: 2, updated: 0, unchanged: 0, refused: [] }, noteIds });
    await stops(h.send([{ key: 'g1', fp: 'fp1', outcome: 'skipped' }]));
    assert.deepEqual(h.cp.ocr, {}, 'nothing written to the checkpoint');
    assert.equal(h.calls.length, 0);
  });
}

for (const st of ['trash', 'deleted', 'new']) {
  test(`note-ids answering ${st} for a settled note buckets its image text not_sent and posts nothing`, async () => {
    const h = strict({ answer: { created: 2, updated: 0, unchanged: 0, refused: [] },
      noteIds: { ids: { fp1: { id: st === 'new' ? NOTE : null, state: st } } } });
    await h.send([{ key: 'g1', fp: 'fp1', outcome: 'skipped' }]);
    assert.deepEqual(h.cp.ocr, { a0: 'not_sent', a1: 'not_sent' });
    assert.equal(h.calls.length, 0);
  });
}

test('note-ids answering here gives the resumed note its id', async () => {
  const h = strict({ answer: { created: 2, updated: 0, unchanged: 0, refused: [] }, noteIds: { ids: { fp1: { id: NOTE, state: 'here' } } } });
  await h.send([{ key: 'g1', fp: 'fp1', outcome: 'skipped' }]);
  assert.deepEqual(h.calls[0].items.map((i) => i.note_id), [NOTE, NOTE]);
});

test('fake fidelity: note-ids answers trash and deleted with id null, as the real route does', async () => {
  const s = await setup();
  await send(s);
  const notes = [...s.kosko.state.notes.values()];
  const space = notes.find((n) => n.title === 'In a Space');
  const active = notes.find((n) => n.external_id === ID.nActive);
  const fpOf = (nodeId) => [...s.kosko.state.ledgerByFp].find(([, e]) => e.nodeId === nodeId)[0];
  s.kosko.state.trashed.add(space.id);
  s.kosko.state.notes.delete(active.id); // deleted in Kosko; the ledger keeps its entry
  const ask = async (body) => (await s.kosko.fetch(`${APP}/api/import/note-ids`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })).json();
  const byFp = await ask({ fingerprints: [fpOf(space.id), fpOf(active.id)] });
  assert.deepEqual(byFp.ids[fpOf(space.id)], { id: null, state: 'trash' });
  assert.deepEqual(byFp.ids[fpOf(active.id)], { id: null, state: 'deleted' });
  const byGuid = await ask({ fingerprints: [fpOf(space.id), fpOf(active.id)], external_ids: [space.external_id ?? null, active.external_id] });
  assert.deepEqual(byGuid.ids[fpOf(space.id)], { id: null, state: 'trash' });
  assert.deepEqual(byGuid.ids[fpOf(active.id)], { id: null, state: 'deleted' });
});

test('fake fidelity: ocr/batch refuses a trashed note note_not_found and a locked note locked (import_ocr)', async () => {
  const s = await setup();
  await send(s);
  const notes = [...s.kosko.state.notes.values()];
  const space = notes.find((n) => n.title === 'In a Space');
  const active = notes.find((n) => n.external_id === ID.nActive);
  s.kosko.state.trashed.add(space.id);
  s.kosko.state.locked.add(active.id);
  const res = await s.kosko.fetch(`${APP}/api/import/jobs`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ source: 'desktop' }) });
  const { id: job } = await res.json();
  const ans = await (await s.kosko.fetch(`${APP}/api/import/ocr/batch`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ job_id: job, items: [
      { note_id: space.id, md5: HASH.telugu, status: 'words', text: 'x' },
      { note_id: active.id, md5: HASH.present, status: 'words', text: 'x' }] }) })).json();
  assert.deepEqual(ans, { created: 0, updated: 0, unchanged: 0, refused: [{ i: 0, reason: 'note_not_found' }, { i: 1, reason: 'locked' }] });
});

test('a backfill where one imported note is now in Kosko\'s trash: its image text is not_sent, nothing posted for it, the counts add up', async () => {
  const s = await setup();
  await send(s);
  const space = [...s.kosko.state.notes.values()].find((n) => n.title === 'In a Space');
  s.kosko.state.ocr.clear(); // as if the first run had been a W2 run
  s.kosko.state.trashed.add(space.id);
  rmSync(checkpointPath(s.planPath));
  s.bodies.length = 0;
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  const d = job.receipt.desktop;
  assert.ok(!sentItems(s).some((i) => i.note_id === space.id), 'nothing posted for the trashed note');
  assert.ok(sentItems(s).length > 0, 'the other notes\' image text was sent');
  assert.equal(d.ocrNotSent, 3, 'the trashed note\'s three records');
  assert.equal(d.ocrRefused, 0);
  assert.equal(sumOf(d), job.summary.expected.ocr);
});

test('a checkpoint that cannot be read (a directory: EISDIR) is logged and exits 1, never a raw rejection', async () => {
  const s = await setup();
  mkdirSync(checkpointPath(s.planPath));
  const r = await send(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /The import stopped: .*EISDIR/);
  assert.deepEqual(s.kosko.state.requests, [], 'nothing was sent');
});
