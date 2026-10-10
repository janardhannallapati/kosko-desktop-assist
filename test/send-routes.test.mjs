// 528 rules 1 and 6 (Kosko doc 528): `send` names both routes before it sends anything, and the README opens with
// them. The tool cannot know the Evernote plan before a sign-in (R5), so it never claims to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routePreamble } from '../src/send/library/routes.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticAccount } from './fixtures/synthetic-db.mjs';
import { runDryRun } from '../src/plan/dry-run.mjs';
import { runSend } from '../src/send/library/run-send.mjs';
import { createFakeKosko } from './fixtures/fake-kosko.mjs';
import { setup as evernoteSetup, send as evernoteSend } from './fixtures/evernote-setup.mjs';

test('plain run: both routes, the reason, and which one this run is', () => {
  assert.equal(routePreamble({ evernote: false, origin: 'https://kosko.app' }), [
    'Two ways in, depending on your Evernote plan:',
    '  Paid plan: add --evernote. You sign in to Evernote once and every note arrives formatted.',
    '  Free plan: this run sends every note as plain text. Then export from Evernote and drop',
    '  the files on https://kosko.app/import: those notes are formatted in place, without copies.',
    'This run: plain text (no --evernote).'
  ].join('\n'));
});

test('--evernote run: says what happens on a free plan, never which plan this is', () => {
  const text = routePreamble({ evernote: true, origin: 'http://127.0.0.1:3013' });
  assert.match(text, /drop\n {2}the files on http:\/\/127\.0\.0\.1:3013\/import:/);
  assert.match(text, /\nThis run: formatted notes from Evernote \(--evernote\)\. On a free plan it says so and sends plain text\.$/);
  assert.doesNotMatch(text, /your (paid|free) plan/i);
});

test('the README opens with the two routes, before the status section', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const routes = readme.indexOf('## Which route fits your Evernote plan');
  assert.ok(routes > 0, 'the routes section exists');
  assert.ok(routes < readme.indexOf('**Status: early development.**'), 'and comes before the status section');
  assert.match(readme, /Evernote gives formatted notes only on paid plans/);
});

// Review (2026-10-10): the ordering and the clear-before-log wiring, proved through runSend itself.

test('--evernote: the routes are named before the first request to Evernote (the sign-in)', async () => {
  const s = await evernoteSetup();
  const lines = [];
  let atFirstMcp = null;
  const mcpFetch = (...a) => { atFirstMcp ??= lines.length; return s.mcp.fetch(...a); };
  const r = await evernoteSend(s, { mcpFetch, log: (l) => lines.push(l) });
  assert.equal(r.exitCode, 0, lines.join('\n'));
  const preamble = lines.findIndex((l) => l.startsWith('Two ways in'));
  assert.ok(preamble >= 0 && atFirstMcp !== null && preamble < atFirstMcp, `preamble ${preamble}, first MCP request after line ${atFirstMcp}`);
  assert.match(lines[preamble], /This run: formatted notes from Evernote \(--evernote\)\./);
});

test('on a terminal, a line printed mid-run first erases the drawn progress lines', async () => {
  const acct = buildSyntheticAccount();
  const outDir = mkdtempSync(join(tmpdir(), 'kda-send-'));
  await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const kosko = createFakeKosko();
  kosko.token = `cvit_${'e5'.repeat(32)}`;
  let batches = 0;
  const fetch = async (url, init) => {
    if (String(url).endsWith('/api/import/notes/batch') && ++batches >= 2 && batches <= 3) {
      return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return kosko.fetch(url, init);
  };
  const transcript = [];
  const progressOut = { isTTY: true, columns: 200, write: (w) => { transcript.push({ w }); return true; } };
  const r = await runSend({ planPath: join(outDir, 'kosko-plan.json'), app: 'https://kosko.test', token: kosko.token, dataDir: acct.dataDir,
    fetch, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: (l) => transcript.push({ l }), sleep: async () => {}, random: () => 0,
    batchNotes: 1, progressOut });
  assert.equal(r.exitCode, 0, JSON.stringify(transcript));
  const waitAt = transcript.findIndex((e) => /not answering; waiting/.test(e.l ?? ''));
  assert.ok(waitAt > 0, 'the run printed a wait line mid-run');
  assert.ok(transcript.slice(0, waitAt).some((e) => /^Sent /.test(e.w ?? '')), 'the progress lines were drawn before it');
  assert.match(transcript[waitAt - 1].w ?? '', /\x1b\[1A/, 'and erased immediately before it');
});
