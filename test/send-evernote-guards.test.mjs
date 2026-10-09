// 512 — the --evernote route's guards: note-ids must answer every note (504's known issue), the console says counts only,
// and the fake MCP server answers as the recorded one does (real HTTP, event streams, signed attachment URLs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ID, HASH } from './fixtures/synthetic-db.mjs';
import { checkpointPath } from '../src/send/checkpoint.mjs';
import { LISTING_NAME } from '../src/send/library/evernote-route.mjs';
import { createFakeMcp, autoAuthorize } from './fake-mcp/server.mjs';
import { setup, send, clock, BODIES, TOKEN, SECRET_WORD } from './fixtures/evernote-setup.mjs';

test('note-ids silence or a malformed answer stops the run before the batch is sent (504 known issue)', async () => {
  const shapes = [
    (ids) => { delete ids[Object.keys(ids)[0]]; return { ids }; },
    () => ({ ids: [] }),
    () => ({}),
    (ids) => { const k = Object.keys(ids)[0]; ids[k] = { state: 'here', id: 'not-a-uuid' }; return { ids }; },
    (ids) => { const k = Object.keys(ids)[0]; ids[k] = { state: 'maybe', id: null }; return { ids }; },
    (ids) => { const k = Object.keys(ids)[0]; ids[k] = null; return { ids }; }
  ];
  for (const [i, shape] of shapes.entries()) {
    const s = await setup();
    const real = s.kosko.fetch;
    const lying = async (url, init) => {
      const res = await real(url, init);
      if (!String(url).endsWith('/api/import/note-ids')) return res;
      const body = await res.json();
      return new Response(JSON.stringify(shape(body.ids)), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const r = await send(s, { evernote: false, fetch: lying });
    assert.equal(r.exitCode, 1, `shape ${i}`);
    assert.match(r.out, /note-ids/, `shape ${i}`);
    assert.ok(!s.kosko.state.requests.includes('POST /api/import/notes/batch'), `shape ${i}: nothing sent`);
  }
});

test('the console says counts only: no title, no body, no Kosko token, no Evernote token or code', async () => {
  const s = await setup();
  await send(s, { evernote: false });
  const r = await send(s);
  const secrets = ['Active note', 'In a Space', 'hello world', SECRET_WORD, TOKEN.slice(5), ...s.mcp.state.access.keys(), ...s.mcp.state.refresh];
  for (const secret of secrets) assert.ok(!r.out.includes(secret), `console holds ${secret.slice(0, 12)}`);
  assert.match(r.out, /Formatted: 3 of 4 notes/);
  assert.match(r.out, /0 created, 3 updated, 1 already in Kosko/);
  const listing = readFileSync(join(s.planPath, '..', LISTING_NAME), 'utf8');
  for (const secret of ['Active note', SECRET_WORD, 'T0']) assert.ok(!listing.includes(secret));
  const cp = readFileSync(checkpointPath(s.planPath), 'utf8');
  for (const secret of secrets) assert.ok(!cp.includes(secret));
  assert.ok(existsSync(join(s.planPath, '..', LISTING_NAME)));
});

test('fake fidelity: real HTTP and event-stream answers — sign-in, tools/list as recorded, a whole --evernote run', async () => {
  const s = await setup({ mcp: { sse: true } });
  const close = await s.mcp.listen();
  try {
    const r = await send(s, { mcpFetch: fetch });
    assert.equal(r.exitCode, 0, r.out);
    assert.equal(s.kosko.job(r.jobId).summary.bodies.formatted, 3);
    assert.ok(s.mcp.state.rpc.includes('tools/list'));
    assert.equal(s.mcp.state.sessions.size, 1);
  } finally { await close(); }
});

test('fake fidelity: get_attachment hands out a signed URL that downloads the file, and refuses it once expired', async () => {
  const time = clock();
  const bytes = new Uint8Array([1, 2, 3]);
  const mcp = createFakeMcp({ now: time.now, files: new Map([[HASH.present, bytes]]),
    notes: [{ guid: ID.nActive, title: 't', enml: BODIES[ID.nActive], created: 0, updated: 0, resources: [{ hash: HASH.present, mime: 'image/png', name: 'r.png', sizeBytes: 3 }] }] });
  const { openEvernote } = await import('../src/mcp/evernote.mjs');
  const ev = await openEvernote({ origin: mcp.origin, fetchImpl: mcp.fetch, authorize: autoAuthorize(mcp.fetch), sleep: time.sleep, now: time.now });
  const a = await ev.call('get_attachment', { noteId: ID.nActive, hash: HASH.present });
  assert.deepEqual(new Uint8Array(await (await mcp.fetch(a.url)).arrayBuffer()), bytes);
  time.c.t += 301_000;
  assert.equal((await mcp.fetch(a.url)).status, 403);
  const note = await ev.call('get_note', { noteId: ID.nActive });
  assert.deepEqual(Object.keys(note).sort(), ['active', 'attributes', 'content', 'created', 'deleted', 'id', 'notebookId', 'resources', 'tags', 'tasks', 'title', 'updateSequenceNumber', 'updated', 'version']);
  assert.equal(note.created.length, 24);
});

test('search_notes is paged 100 at a time by startIndex until the last page: every note is listed', async () => {
  const extra = Array.from({ length: 150 }, (_, i) => `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`);
  const s = await setup({ mcp: { extra } });
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.job(r.jobId).summary.evernote.listed, 153);
  assert.equal(s.kosko.job(r.jobId).summary.evernote.listedNotInPlan, 150);
  assert.equal(s.mcp.state.calls.filter((c) => c.tool === 'search_notes').length, 2);
});

test('a new version with the body Kosko already holds is skipped `unchanged`, counted, and never named', async () => {
  const s = await setup();
  await send(s);
  for (const e of s.kosko.state.ledgerByFp.values()) e.version = 'f'.repeat(64); // as 510's v1 → v2 change does
  const versions = s.kosko.state.versions.length;
  const r = await send(s);
  const job = s.kosko.job(r.jobId);
  assert.equal(job.summary.skip_reasons.unchanged, 3);
  // The note Evernote does not list is sent as plain text without the update flag: Kosko answers as before 511.
  assert.equal(job.summary.skip_reasons.changed_in_evernote, 1);
  assert.equal(s.kosko.state.versions.length, versions, 'nothing written');
  assert.ok(!job.receipt.notes.some((n) => n.reason === 'unchanged'));
});

test('a listing that repeats itself instead of moving on stops the run before anything is sent', async () => {
  const s = await setup({ mcp: { extra: Array.from({ length: 150 }, (_, i) => `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`) } });
  const real = s.mcp.fetch;
  const stuck = (url, init) => real(url, init && typeof init.body === 'string' ? { ...init, body: init.body.replace(/"startIndex":\d+/, '"startIndex":0') } : init);
  const r = await send(s, { mcpFetch: stuck });
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /repeated itself/);
  assert.deepEqual(s.kosko.state.requests, []);
});

test('a note in Kosko\'s trash (or deleted there) is not fetched from Evernote: Kosko answers it whatever the body', async () => {
  const s = await setup();
  await send(s, { evernote: false });
  const active = [...s.kosko.state.notes.values()].find((n) => n.external_id === ID.nActive);
  s.kosko.state.trashed.add(active.id);
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.ok(!s.mcp.state.calls.some((c) => c.tool === 'get_note' && c.noteId === ID.nActive));
  assert.equal(s.kosko.job(r.jobId).summary.skip_reasons.in_kosko_trash, 1);
});
