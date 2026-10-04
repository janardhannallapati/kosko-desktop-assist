import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProbe, fillTemplate, noteFingerprint, normaliseEnml } from '../src/mcp/probe.mjs';
import { assertNoSecrets, shape } from '../src/mcp/report.mjs';

const ACCESS = 'ACCESS-SECRET-1234567';
const REFRESH = 'REFRESH-SECRET-7654321';
const TITLE = 'Secret Title Of A Note';
const BODY = 'secret body text';
const guid = (i) => `0000000${i}-aaaa-bbbb-cccc-dddddddddddd`;

function evernoteFake() {
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/.well-known/oauth-protected-resource')) return json({ resource: 'https://mcp.test', authorization_servers: ['https://accounts.test'] });
    if (u.endsWith('/.well-known/oauth-authorization-server')) return json({ issuer: 'https://accounts.test', authorization_endpoint: 'https://accounts.test/auth/authorize', token_endpoint: 'https://accounts.test/auth/token', registration_endpoint: 'https://accounts.test/auth/register', code_challenge_methods_supported: ['S256'] });
    if (u.endsWith('/auth/register')) return json({ client_id: 'cid' });
    if (u.endsWith('/auth/token')) return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    if (u === 'https://dl.test/file') return new Response(new Uint8Array(1234));
    if (u.endsWith('/mcp')) {
      const b = JSON.parse(init.body);
      if (b.id == null) return new Response('', { status: 202 });
      const res = (result) => json({ jsonrpc: '2.0', id: b.id, result });
      if (b.method === 'initialize') return res({ serverInfo: { name: 'fake', version: '1' } });
      if (b.method === 'tools/list') return res({ tools: ['search_notes', 'get_note', 'get_attachment'].map((name) => ({ name, inputSchema: {} })) });
      const { name, arguments: a } = b.params;
      if (name === 'search_notes') return res({ structuredContent: { notes: [1, 2, 3, 4, 5].map((i) => ({ guid: guid(i), title: TITLE })) } });
      if (name === 'get_note') return res({ structuredContent: { guid: a.noteGuid, title: TITLE, content: BODY, resources: [{ hash: 'ab'.repeat(16), name: 'scan.png' }] } });
      if (name === 'get_attachment') return res({ structuredContent: { url: 'https://dl.test/file' } });
    }
    return new Response('not found', { status: 404 });
  };
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { try { return await fn(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 20)); } }
}

async function probeRun(maxNotes, extra = {}) {
  const outDir = await mkdtemp(path.join(tmpdir(), 'probe-'));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const logs = [];
  const done = runProbe({ outDir, port, maxNotes, planWaitMinutes: 1, origin: 'https://mcp.test', fetchImpl: evernoteFake(), log: (l) => logs.push(l) });
  const signIn = await until(() => readFile(path.join(outDir, 'sign-in-url.txt'), 'utf8'));
  const state = new URL(signIn.trim()).searchParams.get('state');
  await until(() => fetch(`http://127.0.0.1:${port}/callback?code=CODE-SECRET-99&state=${state}`));
  await until(() => access(path.join(outDir, 'tools.json')));
  await writeFile(path.join(outDir, 'plan.json'), JSON.stringify({ run: {
    list: { tool: 'search_notes', args: { query: '' }, idKey: 'guid' },
    note: { tool: 'get_note', idArg: 'noteGuid' },
    attachment: { tool: 'get_attachment', every: 2, resourcesKey: 'resources', args: { noteGuid: '$note', hash: '$r.hash' } },
    ...extra
  } }));
  const report = await done;
  return { report, outDir, logs };
}

test('stops at max-notes and still writes the report', async () => {
  const { report, outDir } = await probeRun(3);
  assert.equal(report.notes.listed, 3);
  assert.equal(report.notes.fetched, 3);
  assert.equal(report.attachments.downloads, 2);
  assert.equal(report.attachments.bytes, 2468);
  assert.equal(report.token.refreshOk, true);
  assert.match(await readFile(path.join(outDir, 'report.md'), 'utf8'), /Notes fetched: 3 \(3 listed, 1 pass\(es\)\)/);
});

test('report and log never contain the token', async () => {
  const { outDir, logs } = await probeRun(2);
  for (const f of ['report.json', 'report.md', 'tools.json']) {
    const text = await readFile(path.join(outDir, f), 'utf8');
    for (const s of [ACCESS, REFRESH, 'CODE-SECRET-99']) assert.ok(!text.includes(s), `${f} contains a secret`);
  }
  for (const s of [ACCESS, REFRESH, 'CODE-SECRET-99']) assert.ok(!logs.join('\n').includes(s));
});

test('report has no title or body fields', async () => {
  const { outDir } = await probeRun(5);
  const text = await readFile(path.join(outDir, 'report.json'), 'utf8');
  assert.ok(!text.includes(TITLE) && !text.includes(BODY));
});

test('assertNoSecrets refuses text holding a secret', () => {
  assert.throws(() => assertNoSecrets(`x ${ACCESS} y`, [ACCESS]), /contains a secret/);
  assert.equal(assertNoSecrets('clean', [ACCESS]), 'clean');
});

test('shape keeps ids and structure, drops content', () => {
  const s = shape({ guid: guid(1), title: TITLE, n: 3, url: 'https://x', list: [{ a: 'bb' }, {}, {}] });
  assert.deepEqual(s, { guid: guid(1), title: `<string ${TITLE.length}>`, n: 3, url: '<url>', list: { '<array>': 3, items: [{ a: '<string 2>' }, {}] } });
});

test('fillTemplate substitutes the note id and resource fields', () => {
  assert.deepEqual(fillTemplate({ n: '$note', h: '$r.hash', k: 1 }, { note: 'N', resource: { hash: 'H' } }), { n: 'N', h: 'H', k: 1 });
});

test('burst mode repeats the notes, fetches attachments on the first pass only, and applies the pacer settings', async () => {
  const { report } = await probeRun(3, { repeat: 3, pacer: { rps: 50, maxRps: 50 } });
  assert.equal(report.notes.fetched, 9);
  assert.equal(report.attachments.downloads, 2);
  assert.equal(report.repeat, 3);
  assert.equal(report.pacerFinalRps, 50);
});

test('fingerprint mode writes hashes and no title or body', async () => {
  const { outDir } = await probeRun(3, { fingerprint: true });
  const text = await readFile(path.join(outDir, 'fingerprints.json'), 'utf8');
  const fps = JSON.parse(text);
  assert.equal(fps.length, 3);
  assert.match(fps[0].contentSha, /^[0-9a-f]{64}$/);
  assert.ok(!text.includes(TITLE) && !text.includes(BODY));
});

test('normaliseEnml strips the XML declaration and DOCTYPE only', () => {
  const enml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">\n<en-note><div>x</div></en-note>\n';
  assert.equal(normaliseEnml(enml), '<en-note><div>x</div></en-note>');
  assert.equal(noteFingerprint({ content: enml }).normSha, noteFingerprint({ content: '<en-note><div>x</div></en-note>' }).normSha);
});
