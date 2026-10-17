// Kosko 537 — `kosko-assist shapes` against the fake MCP server W4 was proved on. Every drift case is a real change to
// what the fake answers (its `alter`, `omitTools`, `extra`, `files`, `refuseRefresh` and `freePlan` options), so each
// one proves the check goes red on exactly the change it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runShapes, pickAttachments, MAX_DOWNLOAD_BYTES, SHAPES_FILE } from '../src/mcp/shapes.mjs';
import { ID } from './fixtures/synthetic-db.mjs';
import { SECRET_WORD } from './fixtures/evernote-setup.mjs';
import { PROOF_HASH, FETCHED } from './fake-mcp/proof-account.mjs';
import { shapesSetup, evernoteOpts, servedFiles } from './fake-mcp/shapes-fixture.mjs';

const BIN = fileURLToPath(new URL('../bin/kosko-assist.mjs', import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), 'kda-shapes-out-'));

async function check(s, { fetchImpl, signal, notes, outDir = scratch() } = {}) {
  const lines = [];
  const exitCode = await runShapes({ planPath: s.planPath, outDir, notes, dataDirs: [s.acct.dataDir], signal,
    evernote: evernoteOpts(s, fetchImpl), log: (l) => lines.push(l) });
  const file = join(outDir, SHAPES_FILE);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  return { exitCode, out: lines.join('\n'), text, report: text ? JSON.parse(text) : null, outDir };
}
const red = (r) => r.report.checks.filter((c) => !c.ok).map((c) => c.id).sort();

test('a matching fake over real HTTP is green on every check and exits 0', async () => {
  const s = await shapesSetup();
  const close = await s.fake.listen();
  try {
    const r = await check(s, { fetchImpl: fetch });
    assert.equal(r.exitCode, 0, r.out);
    assert.deepEqual(red(r), []);
    assert.equal(r.report.verdict, 'match');
    assert.deepEqual(r.report.checks.map((c) => c.id), ['tools', 'arguments', 'results', 'coverage', 'hosts', 'downloads', 'refresh']);
    assert.deepEqual({ listed: r.report.coverage.listed, planned: r.report.coverage.planned }, { listed: 8, planned: 8 });
    assert.ok(r.report.downloads.length >= 1 && r.report.downloads.every((d) => d.ok));
    assert.match(r.out, /Every check is green/);
  } finally { await close(); }
});

test('only read tools and the two MCP methods are called, and nothing but the fake is contacted', async () => {
  const s = await shapesSetup();
  const origins = new Set();
  const spy = async (url, init) => { origins.add(new URL(String(url)).origin); return s.fake.fetch(url, init); };
  const r = await check(s, { fetchImpl: spy });
  assert.equal(r.exitCode, 0, r.out);
  assert.deepEqual([...origins], [s.fake.origin]);
  assert.deepEqual([...new Set(s.fake.state.rpc)].sort(), ['initialize', 'tools/call', 'tools/list']);
  assert.deepEqual([...new Set(s.fake.state.calls.map((c) => c.tool))].sort(), ['get_attachment', 'get_note', 'search_notes']);
});

test('a planted title, body, file name and token appear nowhere in the written file', async () => {
  const s = await shapesSetup({ titles: ['Quillfeather minutes'] });
  const r = await check(s);
  assert.equal(r.exitCode, 0, r.out);
  for (const word of ['Quillfeather', SECRET_WORD, 'first.png', 'scan.png', 'Quarterly figures']) assert.ok(!r.text.includes(word), word);
  for (const t of [...s.fake.state.access.keys(), ...s.fake.state.refresh]) assert.ok(!r.text.includes(t), 'a token');
  assert.ok(!/[?&]sig=/.test(r.text), 'no signed URL query');
  assert.ok(!r.text.includes('/files/'), 'no signed URL path');
});

test('a renamed input property is red and names the argument the run sends', async () => {
  const rename = (tools) => tools.map((t) => (t.name !== 'get_note' ? t : { ...t, inputSchema: { ...t.inputSchema,
    properties: Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, v]) => [k === 'noteId' ? 'id' : k, v])),
    required: (t.inputSchema.required ?? []).map((k) => (k === 'noteId' ? 'id' : k)) } }));
  const s = await shapesSetup({ mcp: { alter: { tools: rename } } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(red(r), ['arguments']);
  assert.match(r.out, /get_note sends noteId/);
});

test('a property the server newly requires is red', async () => {
  const require = (tools) => tools.map((t) => (t.name !== 'search_notes' ? t : { ...t, inputSchema: { ...t.inputSchema,
    properties: { ...t.inputSchema.properties, notebookId: { type: 'string' } }, required: [...(t.inputSchema.required ?? []), 'notebookId'] } }));
  const s = await shapesSetup({ mcp: { alter: { tools: require } } });
  const r = await check(s);
  assert.deepEqual(red(r), ['arguments']);
  assert.match(r.out, /search_notes requires notebookId/);
});

test('a result field the run reads, renamed, is red and named by its path', async () => {
  const s = await shapesSetup({ mcp: { alter: { get_note: ({ content, ...d }) => ({ ...d, body: content }) } } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.ok(red(r).includes('results'));
  assert.match(r.out, /get_note\.content: string → missing/);
  assert.match(r.text, /get_note\.body: new \(string\)/, 'the new name is noted');
});

test('a field the run does not read, missing live, is only noted (review A1)', async () => {
  const s = await shapesSetup({ mcp: { alter: {
    search_notes: (d) => ({ ...d, hits: d.hits.map(({ snippet, ...h }) => h) }),
    get_note: ({ attributes, ...d }) => d } } });
  const r = await check(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.ok(r.report.noted.includes('search_notes.hits[].snippet: string → missing (not read by the run)'));
  assert.ok(r.report.noted.includes('get_note.attributes: object → missing (not read by the run)'));
});

test('a refused call still has its arguments checked, and names the one the schema dropped (review A2)', async () => {
  const rename = (tools) => tools.map((t) => (t.name !== 'get_attachment' ? t : { ...t, inputSchema: { ...t.inputSchema,
    properties: Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, v]) => [k === 'hash' ? 'resourceHash' : k, v])),
    required: (t.inputSchema.required ?? []).map((k) => (k === 'hash' ? 'resourceHash' : k)) } }));
  const s = await shapesSetup({ mcp: { alter: { tools: rename }, refuseTools: ['get_attachment'] } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /get_attachment sends hash, which the server's schema does not name/);
});

test('a 503 on one call is tried again and the check stays green (review A3)', async () => {
  const s = await shapesSetup();
  let failed = 0;
  const flaky = async (url, init) => {
    if (failed === 0 && new URL(String(url)).pathname === '/mcp' && String(init?.body ?? '').includes('"get_note"')) {
      failed += 1;
      return new Response('busy', { status: 503 });
    }
    return s.fake.fetch(url, init);
  };
  const r = await check(s, { fetchImpl: flaky });
  assert.equal(failed, 1);
  assert.equal(r.exitCode, 0, r.out);
});

test('a server without get_note stops before any check and writes nothing, naming the tool (review A4)', async () => {
  const s = await shapesSetup({ mcp: { omitTools: ['get_note'] } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /does not offer get_note/);
  assert.equal(r.text, null);
});

test('a renewed token the server rejects makes the refresh red: one renewal must be enough (review A5)', async () => {
  const s = await shapesSetup();
  let refreshes = 0;
  const rejectFirstRenewal = async (url, init) => {
    const res = await s.fake.fetch(url, init);
    if (new URL(String(url)).pathname === '/auth/token' && String(init?.body ?? '').includes('grant_type=refresh_token') && ++refreshes === 1) s.fake.expireAccess();
    return res;
  };
  const r = await check(s, { fetchImpl: rejectFirstRenewal });
  assert.deepEqual(red(r), ['refresh']);
  assert.match(r.out, /needed 2 renewals instead of one/);
});

test('--out through a symlink into Evernote\'s data folder is refused, and an unwritable --out fails before sign-in (review A7)', async () => {
  const s = await shapesSetup();
  const link = join(scratch(), 'innocent');
  symlinkSync(s.acct.dataDir, link);
  assert.equal((await check(s, { outDir: join(link, 'shapes') })).exitCode, 2);
  const blocker = join(scratch(), 'a-file');
  writeFileSync(blocker, 'x');
  assert.equal((await check(s, { outDir: join(blocker, 'shapes') })).exitCode, 2);
  assert.equal(s.fake.state.authorizations, 0, 'never signed in');
});

test('a missing get_attachment is red, and so is the result it could not give', async () => {
  const s = await shapesSetup({ mcp: { omitTools: ['get_attachment'] } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(red(r), ['downloads', 'hosts', 'results', 'tools']);
  assert.match(r.out, /does not offer get_attachment/);
});

test('a planned note Evernote does not list, and a listed note the plan lacks, are red and named by GUID', async () => {
  const extra = 'eeeeeeee-1111-4222-8333-444444444444';
  const s = await shapesSetup({ keepOddNote: true, mcp: { extra: [extra] } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(red(r), ['coverage']);
  assert.deepEqual(r.report.coverage.planNotListed, [ID.nBadId]);
  assert.deepEqual(r.report.coverage.listedNotInPlan, [extra]);
  assert.match(r.out, /1 planned note is not listed by Evernote; 1 listed note is not in the plan/);
});

test('a listed note the plan lacks is red on its own', async () => {
  const s = await shapesSetup({ mcp: { extra: ['eeeeeeee-1111-4222-8333-555555555555'] } });
  const r = await check(s);
  assert.deepEqual(red(r), ['coverage']);
  assert.match(r.out, /0 planned notes are not listed by Evernote; 1 listed note is not in the plan/);
});

test('a planned note Evernote does not list is red on its own', async () => {
  const s = await shapesSetup({ keepOddNote: true });
  const r = await check(s);
  assert.deepEqual(red(r), ['coverage']);
});

test('a signed URL on another host is red and names the host', async () => {
  const cdn = (d) => ({ ...d, url: d.url.replace(/^https?:\/\/[^/]+/, 'https://files.cdn-example.net') });
  const s = await shapesSetup({ mcp: { alter: { get_attachment: cdn } } });
  const r = await check(s);
  assert.deepEqual(red(r), ['downloads', 'hosts']);
  assert.match(r.out, /files\.cdn-example\.net/);
});

test('a file whose bytes are not the file is red', async () => {
  const wrong = Buffer.alloc(FETCHED.length, 99);
  const s = await shapesSetup({ mcp: { files: servedFiles({ [PROOF_HASH.fetched]: wrong }) } });
  const r = await check(s);
  assert.deepEqual(red(r), ['downloads']);
  assert.ok(r.report.downloads.some((d) => !d.ok && d.reason === 'not_the_file'));
});

test('expires_in and the refresh are recorded, and the refresh needs no second sign-in', async () => {
  const s = await shapesSetup();
  const r = await check(s);
  assert.deepEqual(r.report.token, { expiresIn: 3600, refreshIssued: true });
  assert.equal(r.report.refresh.ok, true);
  assert.equal(s.fake.state.tokenGrants.refresh_token, 1);
  assert.equal(s.signIns.count, 1);
});

test('a forced refresh that fails is red', async () => {
  const s = await shapesSetup({ mcp: { refuseRefresh: true } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(red(r), ['refresh']);
  assert.match(r.out, /could not be renewed/);
});

test('a rate-limit answer is waited out and counted, and the check stays green', async () => {
  const s = await shapesSetup({ mcp: { limitOn: [2] } });
  const t0 = s.time.now();
  const r = await check(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(r.report.limits, 1);
  assert.ok(s.time.now() - t0 >= 60_000, 'the 60 s were waited');
});

test('a free plan is said in one sentence and exits 1', async () => {
  const s = await shapesSetup({ mcp: { freePlan: 'tool' } });
  const r = await check(s);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /free plan/i);
});

test('Ctrl-C stops the check and leaves no file and no partial file', async () => {
  const s = await shapesSetup();
  const ac = new AbortController();
  let mcpCalls = 0;
  const abortSoon = async (url, init) => {
    if (new URL(String(url)).pathname === '/mcp' && ++mcpCalls === 4) ac.abort();
    return s.fake.fetch(url, init);
  };
  const r = await check(s, { fetchImpl: abortSoon, signal: ac.signal });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(readdirSync(r.outDir), []);
  assert.match(r.out, /Stopped/);
});

test('--out inside Evernote\'s data folder is refused with exit 2', async () => {
  const s = await shapesSetup();
  const r = await check(s, { outDir: join(s.acct.dataDir, 'shapes') });
  assert.equal(r.exitCode, 2);
});

test('an attachment over the byte bound is never picked, and the smallest come first', () => {
  const plan = { attachments: [
    { noteId: 'a', dataHash: 'h-big', size: MAX_DOWNLOAD_BYTES + 1 },
    { noteId: 'a', dataHash: 'h-3', size: 30 }, { noteId: 'a', dataHash: 'h-1', size: 10 },
    { noteId: 'b', dataHash: 'h-2', size: 20 }, { noteId: 'c', dataHash: 'h-other', size: 1 }] };
  const offered = new Map([['a', new Set(['h-big', 'h-3', 'h-1'])], ['b', new Set(['h-2'])]]);
  assert.deepEqual(pickAttachments(plan, offered, 3).map((a) => a.md5), ['h-1', 'h-2', 'h-3']);
  assert.deepEqual(pickAttachments(plan, offered, 1).map((a) => a.md5), ['h-1']);
  assert.ok(!pickAttachments(plan, offered, 10).some((a) => a.md5 === 'h-big'), 'room for it, still never picked');
});

test('the CLI refuses --notes 0, --notes 51 and a missing --plan with exit 2, before signing in', () => {
  const cases = [[['--plan', 'p', '--out', 'o', '--notes', '0'], /--notes must be a whole number from 1 to 50/],
    [['--plan', 'p', '--out', 'o', '--notes', '51'], /--notes must be a whole number from 1 to 50/],
    [['--out', 'o'], /shapes needs --plan/]];
  for (const [args, message] of cases) {
    const r = spawnSync(process.execPath, [BIN, 'shapes', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message, 'the shapes command\'s own refusal, not the unknown-command usage');
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  }
});
