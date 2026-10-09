// 512 — `send --evernote` against the fake MCP server (test/fake-mcp/) and the in-memory Kosko (fixtures/fake-kosko.mjs,
// which mirrors 511's update path): the upgrade, the free plan, the listing check, pacing, refresh and resume. The
// guards (note-ids, the console, the fake's own fidelity) are in send-evernote-guards.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID, HASH } from './fixtures/synthetic-db.mjs';
import { checkpointPath } from '../src/send/checkpoint.mjs';
import { FREE_PLAN_SENTENCE, LISTING_NAME } from '../src/send/library/evernote-route.mjs';
import { setup, send, byGuid, types, paths, LISTED } from './fixtures/evernote-setup.mjs';

test('run 1 plain, run 2 --evernote: every listed note is upgraded IN PLACE — same id, same files, formatted, nothing uploaded again', async () => {
  const s = await setup();
  const r1 = await send(s, { evernote: false });
  assert.equal(r1.exitCode, 0, r1.out);
  const before = new Map(LISTED.map((g) => [g, { id: byGuid(s, g).id, paths: paths(byGuid(s, g).content) }]));
  const uploads = s.kosko.state.uploads.length;
  const notes = s.kosko.state.notes.size;
  const r2 = await send(s);
  assert.equal(r2.exitCode, 0, r2.out);
  const job = s.kosko.job(r2.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 3, skipped: 1, not_imported: 0 });
  assert.equal(s.kosko.state.notes.size, notes, 'no duplicate');
  assert.equal(s.kosko.state.uploads.length, uploads, 'nothing uploaded again');
  assert.equal(s.kosko.state.dropRefusals, 0, 'no body dropped a file the note held (511 rule 5)');
  assert.equal(s.kosko.state.versions.length, 3, 'the plain text of each is kept as a version');
  for (const g of LISTED) {
    const n = byGuid(s, g);
    assert.equal(n.id, before.get(g).id, 'same Kosko note');
    for (const p of before.get(g).paths) assert.ok(paths(n.content).has(p), `still references ${p}`);
  }
  const active = byGuid(s, ID.nActive);
  assert.ok(types(active.content).includes('table'), 'the table arrives');
  assert.ok(types(active.content).includes('taskItem'), 'the checklist arrives');
  assert.ok(types(active.content).includes('bold') === false && JSON.stringify(active.content).includes('"bold"'), 'formatting arrives');
  // The picture sits where the ENML puts it (after the table), and the two files no <en-media> places are appended.
  const top = active.content.content.map((n) => n.type);
  assert.ok(top.indexOf('noteImage') > top.indexOf('table'));
  assert.match(active.content.content[top.indexOf('noteImage')].attrs.path, new RegExp(`^notes/${active.id}/images/${HASH.present}\\.png$`));
  assert.deepEqual(job.summary.bodies, { formatted: 3, plain: 0, notListed: 1, missing: 0, unconvertible: 0, koskoRefused: 0, unreachable: 0 });
  assert.deepEqual({ ...job.summary.evernote }, { listed: 3, planNotListed: 1, listedNotInPlan: 0, limits: 0, refreshes: 0, formattedRefused: 0 });
  // 504's image text still adds up on the upgraded notes: their scans keep their md5 keys.
  const d = job.receipt.desktop;
  assert.deepEqual([d.ocrWords, d.ocrEmpty, d.ocrUnreadable, d.ocrNotSent, d.ocrRefused], [3, 2, 1, 0, 0]);
});

test('run 3 changes nothing: every note skipped as the same version, no note_versions row, nothing written', async () => {
  const s = await setup();
  await send(s, { evernote: false });
  await send(s);
  const versions = s.kosko.state.versions.length;
  const updates = s.kosko.state.updates.length;
  const r3 = await send(s);
  assert.equal(r3.exitCode, 0, r3.out);
  assert.deepEqual(s.kosko.job(r3.jobId).summary.notes, { created: 0, updated: 0, skipped: 4, not_imported: 0 });
  assert.deepEqual(s.kosko.job(r3.jobId).summary.skip_reasons, {});
  assert.equal(s.kosko.state.versions.length, versions);
  assert.equal(s.kosko.state.updates.length, updates);
});

test('a note edited in Kosko between the runs keeps the edit and is named edited_in_kosko; the others are upgraded', async () => {
  const s = await setup();
  await send(s, { evernote: false });
  const active = byGuid(s, ID.nActive);
  const edited = structuredClone(active.content);
  edited.content.unshift({ type: 'paragraph', content: [{ type: 'text', text: 'my own line' }] });
  s.kosko.editNote(active.id, { content: edited });
  const r = await send(s);
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 2, skipped: 2, not_imported: 0 });
  assert.equal(job.summary.skip_reasons.edited_in_kosko, 1);
  assert.deepEqual(byGuid(s, ID.nActive).content, edited, 'the Kosko edit stays');
  assert.ok(job.receipt.notes.some((n) => n.title === 'Active note' && n.reason === 'edited_in_kosko'));
});

test('benign: a first run with --evernote creates the listed notes formatted, the unlisted one as plain text', async () => {
  const s = await setup();
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
  assert.ok(types(byGuid(s, ID.nActive).content).includes('table'));
  assert.equal(byGuid(s, ID.nActive).update, undefined, 'a new note does not ask for the update path');
  assert.equal(job.summary.bodies.formatted, 3);
});

for (const freePlan of ['http403', 'rpc', 'tool']) {
  test(`free plan (${freePlan}): said in one sentence, the run carries on as plain text and exits 0`, async () => {
    const s = await setup({ mcp: { freePlan } });
    const r = await send(s);
    assert.equal(r.exitCode, 0, r.out);
    assert.equal(r.out.split(FREE_PLAN_SENTENCE).length - 1, 1, 'said once');
    const job = s.kosko.job(r.jobId);
    assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
    assert.deepEqual(job.summary.evernote, { freePlan: 1 });
    assert.equal(job.summary.bodies, undefined);
    assert.deepEqual(byGuid(s, ID.nActive).content.content[0], { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] });
    assert.equal(s.mcp.state.getNoteCalls, 0);
  });
}

test('benign: a refusal that names no plan is not a free plan — the run stops before anything reaches Kosko', async () => {
  const s = await setup();
  const real = s.mcp.fetch;
  const broken = async (url, init) => (String(url).endsWith('/mcp') ? new Response('{"error":"server"}', { status: 500 }) : real(url, init));
  const r = await send(s, { mcpFetch: broken });
  assert.equal(r.exitCode, 1);
  assert.ok(!r.out.includes(FREE_PLAN_SENTENCE));
  assert.deepEqual(s.kosko.state.requests, []);
});

test('a server without get_note is refused before anything is sent', async () => {
  const s = await setup({ mcp: { omitTools: ['get_note'] } });
  const r = await send(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /does not offer get_note/);
  assert.deepEqual(s.kosko.state.requests, []);
});

test('the listing check: planned-but-unlisted and listed-but-unplanned notes are counted, named by GUID in a file, and the run goes on', async () => {
  const extra = ['11111111-2222-4333-8444-555555555555', '66666666-2222-4333-8444-555555555555'];
  const s = await setup({ notes: [ID.nActive, ID.nEmptyText, ID.nSpace], mcp: { extra, missing: [ID.nEmptyText] } });
  // nSpace is dropped from the listing: a planned note Evernote does not list.
  s.mcp.state.notes.get(ID.nSpace).active = false;
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.equal(job.summary.evernote.planNotListed, 2); // nSpace + the Odd id note
  assert.equal(job.summary.evernote.listedNotInPlan, 2);
  assert.deepEqual(job.summary.bodies, { formatted: 1, plain: 0, notListed: 2, missing: 1, unconvertible: 0, koskoRefused: 0, unreachable: 0 });
  const listing = JSON.parse(readFileSync(join(s.planPath, '..', LISTING_NAME), 'utf8'));
  assert.deepEqual(listing.listedNotInPlan.sort(), extra);
  assert.ok(listing.planNotListed.includes(ID.nSpace));
  for (const g of extra) assert.ok(!r.out.includes(g), 'GUIDs are not printed');
  assert.match(r.out, /2 planned notes are not listed by Evernote/);
  assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 }, 'neither stops the run');
});

test('pacing: get_note at most 1.1 calls a second, never climbing; a rate-limit isError waits its 60 s and halves the rate', async () => {
  const s = await setup({ mcp: { limitOn: [1] } }); // the first get_note: two calls follow the retry
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const at = s.mcp.state.calls.map((c) => c.at);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.ok(gaps.every((g) => g >= Math.floor(1000 / 1.1)), `every call ≥ 909 ms after the last: ${gaps}`);
  const limited = s.mcp.state.calls.findIndex((c) => c.tool === 'get_note');
  assert.ok(Math.round(gaps[limited]) >= 60_000, 'waited the 60 s the server named');
  assert.ok(gaps.slice(limited + 1).length >= 2);
  assert.ok(gaps.slice(limited + 1).every((g) => g >= Math.floor(1000 / 0.55)), 'halved, and it stays halved');
  assert.equal(s.kosko.job(r.jobId).summary.evernote.limits, 1);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.formatted, 3, 'the limited note is fetched again, not dropped');
});

test('an expired access token is renewed with the refresh token, never a second browser sign-in', async () => {
  const s = await setup();
  const real = s.mcp.fetch;
  let gets = 0;
  const expiring = async (url, init) => {
    if (String(url).endsWith('/mcp') && String(init?.body).includes('"get_note"') && ++gets === 2) s.mcp.expireAccess();
    return real(url, init);
  };
  const r = await send(s, { mcpFetch: expiring });
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.signIns.count, 1);
  assert.equal(s.mcp.state.tokenGrants.authorization_code, 1);
  assert.equal(s.mcp.state.tokenGrants.refresh_token, 1);
  assert.equal(s.kosko.job(r.jobId).summary.evernote.refreshes, 1);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.formatted, 3);
});

test('a v2 checkpoint is refused before any request, with what to do', async () => {
  const s = await setup();
  writeFileSync(checkpointPath(s.planPath), JSON.stringify({ format: 'kosko-send-checkpoint', version: 2 }));
  const r = await send(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /earlier version of this tool.*Delete that file/s);
  assert.deepEqual(s.kosko.state.requests, []);
});

test('benign: a plain-text checkpoint is not continued by an --evernote run; it starts over and says why', async () => {
  const s = await setup();
  const ac = new AbortController();
  const real = s.kosko.fetch;
  const stopping = async (url, init) => { const res = await real(url, init); if (String(url).endsWith('/notes/batch')) ac.abort(); return res; };
  await send(s, { evernote: false, fetch: stopping, signal: ac.signal, batchNotes: 2 });
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.match(r.out, /plain-text route; starting over/);
});

test('a stopped --evernote run resumes without fetching a settled note\'s body again; checkpoint v3 holds each body', async () => {
  const s = await setup();
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
  const cp = JSON.parse(readFileSync(checkpointPath(s.planPath), 'utf8'));
  assert.equal(cp.version, 3);
  assert.equal(cp.route, 'evernote');
  const settled = Object.keys(cp.notes);
  assert.ok(settled.length > 0 && settled.length < 4);
  for (const g of settled) assert.match(cp.bodies[g], /^(formatted|plain:not_listed)$/);
  const fetched = s.mcp.state.calls.length;
  const second = await send(s, { batchNotes: 2 });
  assert.equal(second.exitCode, 0, second.out);
  assert.equal(second.jobId, first.jobId);
  const later = s.mcp.state.calls.slice(fetched).filter((c) => c.tool === 'get_note');
  for (const c of later) assert.ok(!settled.includes(c.noteId), 'a settled note\'s body is never fetched again');
  const job = s.kosko.job(second.jobId);
  assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
  assert.equal(job.summary.bodies.formatted, 3, 'the stopped run\'s formatted notes are counted from the checkpoint');
  assert.ok(later.length <= 4 - settled.length, `only unsettled notes are fetched again (${later.length})`);
});

test('a formatted body Kosko refuses: a new note is sent again as plain text; a note Kosko holds keeps its plain text', async () => {
  const s = await setup();
  s.kosko.state.noteErrors.set(ID.nActive, ['invalid']);
  let r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.deepEqual(s.kosko.job(r.jobId).summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
  assert.deepEqual(byGuid(s, ID.nActive).content.content[0], { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] });
  assert.equal(s.kosko.job(r.jobId).summary.bodies.koskoRefused, 1);
  const s2 = await setup();
  await send(s2, { evernote: false });
  s2.kosko.state.noteErrors.set(ID.nActive, ['invalid']);
  r = await send(s2);
  const job = s2.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 2, skipped: 2, not_imported: 0 });
  assert.equal(job.summary.skip_reasons.changed_in_evernote, 1);
  assert.equal(job.summary.evernote.formattedRefused, 1, 'the tool-side reason (review T8)');
  assert.equal(s2.kosko.state.refusals.length, 0, 'no refusal is recorded over a note Kosko holds');
});

test('ENML the converter refuses (an entity declaration) keeps the plain text and is counted', async () => {
  const s = await setup();
  s.mcp.state.notes.get(ID.nEmptyText).enml = `<?xml version="1.0"?><!DOCTYPE en-note [<!ENTITY a "aa">]><en-note>&a;</en-note>`;
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.unconvertible, 1);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.formatted, 2);
});

test('review T8/T11: Kosko refuses a held note\'s upgrade as would_drop_media — settled formatted_refused (Kosko hears changed_in_evernote), the run goes on', async () => {
  const s = await setup();
  await send(s, { evernote: false });
  const active = byGuid(s, ID.nActive);
  // Kosko holds one more key under the note than the formatted body names: 511 rule 5 refuses the update.
  s.kosko.holdKey(active.id, `notes/${active.id}/images/${'e'.repeat(32)}.png`);
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.state.dropRefusals, 1, 'the fake refused it with the real per-note code');
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 2, skipped: 2, not_imported: 0 }, 'the other notes are upgraded');
  assert.equal(JSON.parse(readFileSync(checkpointPath(s.planPath), 'utf8')).notes[ID.nActive], 'skipped:formatted_refused');
  assert.equal(job.summary.evernote.formattedRefused, 1);
  assert.equal(job.summary.bodies.koskoRefused, 1);
  assert.deepEqual(job.summary.skip_reasons, { changed_in_evernote: 1 }, 'Kosko\'s closed reason set');
  assert.ok(job.receipt.notes.some((n) => n.title === 'Active note' && n.reason === 'changed_in_evernote'));
  assert.equal(s.kosko.state.refusals.length, 0, 'no refusal recorded over a note Kosko holds');
  assert.deepEqual(byGuid(s, ID.nActive).content.content[0], { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }, 'its plain text stays');
});
