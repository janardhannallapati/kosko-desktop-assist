// 512 review fixes (2026-10-08) — the --evernote route under trouble: every request has a deadline (T1), Ctrl-C reaches
// every wait (T2), one note's transient failure is that note's (T3), a bare 403 is not a free plan (T4), the local
// files are best effort (T5), the signed URL is pinned (T10) and the console says counts only on every line (T12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID, HASH } from './fixtures/synthetic-db.mjs';
import { checkpointPath } from '../src/send/checkpoint.mjs';
import { FREE_PLAN_SENTENCE, LISTING_NAME, AUTH_STOP, NOTE_RETRIES, OUTAGE_STREAK, outageStop } from '../src/send/library/evernote-route.mjs';
import { LINKS_NAME } from '../src/send/library/note-links.mjs';
import { fetchAttachment, isSignedUrl, isTransient, downloadTimeoutMs, browserAuthorize, AttachmentMissing } from '../src/mcp/evernote.mjs';
import { waitForCallback } from '../src/mcp/oauth.mjs';
import { setup, send, byGuid, types, SECRET_WORD, TOKEN } from './fixtures/evernote-setup.mjs';

const T = { timeout: Number(process.env.KDA_HANG_TIMEOUT_MS ?? 120_000) }; // a missing deadline or abort hangs: the test times out red
const isTool = (init, tool, noteId) => typeof init?.body === 'string' && init.body.includes(`"name":"${tool}"`) && (!noteId || init.body.includes(noteId));
/**
 * A request that never answers, until its signal aborts (a deadline or Ctrl-C). Without a signal it hangs for ever. The
 * interval stands in for the open socket a real hung request holds (AbortSignal.timeout's timer alone keeps no process up).
 */
const hang = (init) => new Promise((_, reject) => {
  if (init?.signal?.aborted) { reject(init.signal.reason); return; }
  const socket = setInterval(() => {}, 1000);
  init?.signal?.addEventListener('abort', () => { clearInterval(socket); reject(init.signal.reason); }, { once: true });
});
const getNotes = (s, guid) => s.mcp.state.calls.filter((c) => c.tool === 'get_note' && c.noteId === guid).length;

// ---- T1: deadlines ------------------------------------------------------------------------------------------------

test('T1: a get_note that never answers meets its deadline, is tried again, then keeps its plain text; the run goes on', T, async () => {
  const s = await setup();
  const real = s.mcp.fetch;
  let tries = 0;
  const stuck = (url, init) => (isTool(init, 'get_note', ID.nActive) ? (tries++, hang(init)) : real(url, init));
  const r = await send(s, { mcpFetch: stuck, evernoteExtra: { callTimeoutMs: 40 } });
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(tries, 1 + NOTE_RETRIES, 'tried, then NOTE_RETRIES more');
  const job = s.kosko.job(r.jobId);
  assert.equal(job.summary.bodies.unreachable, 1);
  assert.equal(job.summary.bodies.formatted, 2, 'the other notes are fetched as usual');
  assert.deepEqual(byGuid(s, ID.nActive).content.content[0], { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] });
  assert.equal(JSON.parse(readFileSync(checkpointPath(s.planPath), 'utf8')).bodies[ID.nActive], 'plain:unreachable');
});

test('T1: the download streams with a running count and stops the moment it passes the planned size', T, async () => {
  let pulls = 0;
  const endless = new ReadableStream({ pull(c) { pulls += 1; c.enqueue(new Uint8Array(1024)); } });
  let seen;
  const fetchImpl = async (url, init) => { seen = init; return new Response(endless, { status: 200 }); };
  const call = async () => ({ url: 'https://files.evernote.com/res/x', expiresAt: new Date(Date.now() + 300_000).toISOString() });
  await assert.rejects(fetchAttachment({ call, fetchImpl }, { guid: ID.nActive, md5: HASH.present, size: 4096 }),
    (e) => e instanceof AttachmentMissing && e.message === 'wrong_size');
  assert.ok(pulls <= 8, `stopped after ${pulls} chunks of an endless body`);
  assert.equal(seen.redirect, 'error');
  assert.ok(seen.signal instanceof AbortSignal, 'the download carries a deadline');
  assert.equal(seen.headers, undefined, 'no Authorization header (461)');
});

test('T1: a download that never answers meets its deadline (scaled to its size, with a floor)', T, async () => {
  const call = async () => ({ url: 'https://files.evernote.com/res/x', expiresAt: new Date(Date.now() + 300_000).toISOString() });
  await assert.rejects(fetchAttachment({ call, fetchImpl: (u, init) => hang(init), downloadFloorMs: 30 }, { guid: ID.nActive, md5: HASH.present, size: 10 }),
    (e) => e instanceof AttachmentMissing && e.message === 'download_failed');
  assert.equal(downloadTimeoutMs(10), 61_000);
  assert.equal(downloadTimeoutMs(200 * 1024 * 1024), 60_000 + 3200 * 1000);
});

test('T2: Ctrl-C during a download rejects with the abort itself — never AttachmentMissing (a missing file)', T, async () => {
  const ac = new AbortController();
  const call = async () => ({ url: 'https://files.evernote.com/res/x', expiresAt: new Date(Date.now() + 300_000).toISOString() });
  const fetchImpl = (u, init) => { setTimeout(() => ac.abort(), 5); return hang(init); };
  await assert.rejects(fetchAttachment({ call, fetchImpl, signal: ac.signal }, { guid: ID.nActive, md5: HASH.present, size: 10 }),
    (e) => !(e instanceof AttachmentMissing) && e.name === 'AbortError');
});

// ---- T2: Ctrl-C ---------------------------------------------------------------------------------------------------

test('T2: Ctrl-C during the sign-in stops the run with exit 130: the browser step gets the run\'s signal', T, async () => {
  {
    const s = await setup();
    const ac = new AbortController();
    const authorize = ({ signal }) => { setTimeout(() => ac.abort(), 5); return new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))); };
    const r = await send(s, { signal: ac.signal, evernoteExtra: { authorize } });
    assert.equal(r.exitCode, 130, `sign-in: ${r.out}`);
    assert.match(r.out, /^Stopped\./m);
    assert.deepEqual(s.kosko.state.requests, [], 'nothing sent');
  }
});

test('T2: Ctrl-C during the listing stops the run with exit 130, nothing sent', T, async () => {
  {
    const s = await setup();
    const ac = new AbortController();
    const real = s.mcp.fetch;
    const f = (url, init) => (isTool(init, 'search_notes') ? (ac.abort(), hang(init)) : real(url, init));
    const r = await send(s, { signal: ac.signal, mcpFetch: f });
    assert.equal(r.exitCode, 130, `listing: ${r.out}`);
    assert.ok(!r.out.includes('could not be reached'));
    assert.deepEqual(s.kosko.state.requests, []);
  }
});

test('T2: Ctrl-C during a get_note stops the run with exit 130; the job stays running and the next run continues it', T, async () => {
  {
    const s = await setup();
    const ac = new AbortController();
    const real = s.mcp.fetch;
    const f = (url, init) => (isTool(init, 'get_note') ? (ac.abort(), hang(init)) : real(url, init));
    const r = await send(s, { signal: ac.signal, mcpFetch: f });
    assert.equal(r.exitCode, 130, `get_note: ${r.out}`);
    assert.equal(s.kosko.job(r.jobId).status, 'running');
    assert.ok(existsSync(checkpointPath(s.planPath)));
    const again = await send(s);
    assert.equal(again.exitCode, 0, again.out);
    assert.equal(again.jobId, r.jobId);
  }
});

test('T2: Ctrl-C during a pacer wait (a rate limit\'s 60 s) stops the run with exit 130; no call is made after it', T, async () => {
  {
    const s = await setup({ mcp: { limitOn: [1] } });
    const ac = new AbortController();
    const sleep = async (ms) => { if (ms >= 60_000) ac.abort(); s.time.c.t += ms; };
    const r = await send(s, { signal: ac.signal, evernoteExtra: { sleep } });
    assert.equal(r.exitCode, 130, `pacer: ${r.out}`);
    assert.equal(s.mcp.state.getNoteCalls, 1, 'the limited get_note is not asked again');
  }
});

test('T2: the loopback sign-in stops listening at Ctrl-C', T, async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const ac = new AbortController();
  const p = waitForCallback({ port, state: 's', signal: ac.signal });
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/callback?code=x&state=s`), 'the port is closed');
});

// ---- T3: one note's trouble ---------------------------------------------------------------------------------------

test('T3: a 5xx on one note\'s get_note is tried again with backoff; if it clears, the note is formatted', T, async () => {
  const s = await setup();
  const real = s.mcp.fetch;
  let fails = 2;
  const f = (url, init) => (isTool(init, 'get_note', ID.nActive) && fails-- > 0 ? new Response('{}', { status: 502 }) : real(url, init));
  const t0 = s.time.now();
  const r = await send(s, { mcpFetch: f });
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.formatted, 3);
  assert.ok(types(byGuid(s, ID.nActive).content).includes('table'));
  assert.ok(s.time.now() - t0 >= 5000 + 10_000, 'waited 5 s, then 10 s');
});

test('T3: a 5xx that never clears: the note keeps its plain text, counted; the run goes on and exits 0', T, async () => {
  const s = await setup();
  const real = s.mcp.fetch;
  const f = (url, init) => (isTool(init, 'get_note', ID.nSpace) ? new Response('{}', { status: 503 }) : real(url, init));
  const r = await send(s, { mcpFetch: f });
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.bodies, { formatted: 2, plain: 0, notListed: 1, missing: 0, unconvertible: 0, koskoRefused: 0, unreachable: 1 });
  assert.deepEqual(job.summary.notes, { created: 4, updated: 0, skipped: 0, not_imported: 0 });
});

test('T3: a sign-in that stops working (the refresh is refused, or 401 after it) stops the run, resumably', T, async () => {
  for (const mode of ['refresh_refused', 'still_401']) {
    const s = await setup();
    const real = s.mcp.fetch;
    let gets = 0;
    let broken = false;
    const f = async (url, init) => {
      if (isTool(init, 'get_note') && ++gets === 2) { s.mcp.expireAccess(); broken = true; }
      if (broken && mode === 'refresh_refused' && String(url).endsWith('/auth/token') && String(init?.body).includes('refresh_token')) return new Response('{"error":"invalid_grant"}', { status: 400 });
      if (broken && mode === 'still_401' && String(url).endsWith('/mcp')) return new Response('{"error":"invalid_token"}', { status: 401 });
      return real(url, init);
    };
    const r = await send(s, { mcpFetch: f, batchNotes: 1 });
    assert.equal(r.exitCode, 1, `${mode}: ${r.out}`);
    assert.ok(r.out.includes(AUTH_STOP), mode);
    assert.match(r.out, /Run the same command again to continue/);
    assert.equal(s.kosko.job(r.jobId).status, 'running', `${mode}: the job is left to continue`);
    const asked = new Set(s.mcp.state.calls.filter((c) => c.tool === 'get_note').map((c) => c.noteId));
    assert.ok(asked.size <= 2, `${mode}: no further note is tried (${asked.size})`);
    const again = await send(s);
    assert.equal(again.exitCode, 0, again.out);
    assert.equal(again.jobId, r.jobId, `${mode}: continued`);
  }
});

// ---- T4: a bare 403 -----------------------------------------------------------------------------------------------

test('T4: a bare 403 (no plan named) is not a free plan — the run stops, says why, and sends nothing', T, async () => {
  const s = await setup({ mcp: { freePlan: 'http403bare' } });
  const r = await send(s);
  assert.equal(r.exitCode, 1);
  assert.ok(!r.out.includes(FREE_PLAN_SENTENCE), 'never silently plain');
  assert.match(r.out, /Evernote refused the sign-in \(HTTP 403\)/);
  assert.deepEqual(s.kosko.state.requests, []);
});

// ---- T5: local files, best effort ---------------------------------------------------------------------------------

test('T5: the listing or links file that cannot be written is one warning line; the job still completes', T, async () => {
  for (const name of [LISTING_NAME, LINKS_NAME]) {
    const s = await setup();
    mkdirSync(join(s.planPath, '..', `${name}.partial`)); // writeFileSync onto a directory fails (EISDIR)
    const r = await send(s);
    assert.equal(r.exitCode, 0, `${name}: ${r.out}`);
    assert.equal(s.kosko.job(r.jobId).status, 'complete', name);
    assert.match(r.out, /could not be saved beside the plan; the counts above still hold, and the import goes on\./);
    assert.ok(!r.out.includes('could not be reached'), name);
    if (name === LISTING_NAME) assert.ok(!r.out.includes('Their ids are in'), 'a file that was not written is not pointed to');
    assert.ok(!existsSync(join(s.planPath, '..', name)), name);
  }
});

// ---- T10: the signed URL ------------------------------------------------------------------------------------------

test('T10: the signed URL must be https on evernote.com: http, other hosts and look-alikes are refused', () => {
  assert.equal(isSignedUrl('https://www.evernote.com/shard/s1/res/abc?sig=x'), true);
  assert.equal(isSignedUrl('https://evernote.com/res/abc'), true);
  for (const bad of ['http://www.evernote.com/res/abc', 'https://evernote.com.evil.test/res', 'https://evil.test/res', 'https://notevernote.com/r',
    'https://user:pw@www.evernote.com/r', 'http://127.0.0.1:8080/files/x', 'ftp://www.evernote.com/r', 'not a url']) assert.equal(isSignedUrl(bad), false, bad);
});

test('T10: by default the fake\'s own URL (not evernote.com) is refused — never downloaded, the placeholder kept', T, async () => {
  const s = await setup({ mcp: { files: new Map([[HASH.present, new Uint8Array([1])]]) } });
  const call = async () => ({ url: `${s.mcp.origin}/files/${HASH.present}`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  await assert.rejects(fetchAttachment({ call, fetchImpl: s.mcp.fetch }, { guid: ID.nActive, md5: HASH.present, size: 1 }), (e) => e.message === 'no_url');
  assert.equal(s.mcp.state.downloads.length, 0);
});

test('T10: a redirect is refused — the hop is never followed, even to the same host', T, async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/signed') { res.writeHead(302, { location: '/elsewhere' }).end(); return; }
    res.writeHead(200).end('x');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/signed`;
  try {
    const call = async () => ({ url, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    await assert.rejects(fetchAttachment({ call, fetchImpl: fetch, signedUrlOk: (u) => u === url }, { guid: ID.nActive, md5: HASH.present, size: 1 }),
      (e) => e instanceof AttachmentMissing && e.message === 'download_failed');
    assert.deepEqual(hits, ['/signed'], 'the redirect target is never asked for');
  } finally { await new Promise((r) => server.close(r)); }
});

// ---- T12: the console, every line ---------------------------------------------------------------------------------

/** The real browser step: browserAuthorize prints the address; a "browser" follows it to the loopback. */
const realBrowser = (fakeFetch, codes) => async (a) => {
  const p = browserAuthorize(a);
  const loc = new URL((await fakeFetch(a.url, { redirect: 'manual' })).headers.get('location'));
  codes.push(loc.searchParams.get('code'));
  for (let i = 0; ; i++) {
    try { await fetch(loc); break; } catch (e) { if (i > 50) throw e; await new Promise((r) => setTimeout(r, 20)); }
  }
  return p;
};
const freePort = () => new Promise((resolve) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });

test('T12: the console never shows a planned note\'s GUID, a title, a body or a token — sign-in URL, rate-limit and stop lines included', T, async () => {
  const s = await setup({ mcp: { limitOn: [1] } });
  const codes = [];
  const real = s.mcp.fetch;
  let gets = 0;
  const f = async (url, init) => {
    if (isTool(init, 'get_note') && ++gets === 3) s.mcp.expireAccess();
    if (gets >= 3 && String(url).endsWith('/auth/token') && String(init?.body).includes('refresh_token')) return new Response('{}', { status: 400 });
    return real(url, init);
  };
  const r = await send(s, { mcpFetch: f, evernoteExtra: { authorize: realBrowser(real, codes), port: await freePort() } });
  assert.equal(r.exitCode, 1, r.out);
  assert.match(r.out, /Open this address in your browser and sign in to Evernote \(read only\):\n/, 'the sign-in URL line');
  assert.match(r.out, /Evernote asked the tool to slow down; waiting 60 s\./, 'the rate-limit line');
  assert.ok(r.out.includes(AUTH_STOP), 'the stop line');
  // Decided (512 rule 12, 467 rule 12): GUIDs live in local files only — never on the console.
  const secrets = [...Object.values(ID).filter((v) => /^[0-9a-f-]{36}$/.test(v)), 'Active note', 'In a Space', 'hello world', SECRET_WORD,
    TOKEN.slice(5), ...codes, ...s.mcp.state.access.keys(), ...s.mcp.state.refresh];
  for (const secret of secrets) assert.ok(!r.out.includes(secret), `console holds ${secret.slice(0, 12)}`);
});

// ---- Follow-ups (2026-10-09) --------------------------------------------------------------------------------------

test('outage breaker: N notes in a row unreachable stop the run, resumably, with one counts-only sentence', T, async () => {
  assert.equal(OUTAGE_STREAK, 5);
  const s = await setup();
  const real = s.mcp.fetch;
  const down = (url, init) => (isTool(init, 'get_note') ? new Response('{}', { status: 503 }) : real(url, init));
  const r = await send(s, { mcpFetch: down, evernoteExtra: { outageAfter: 2 } });
  assert.equal(r.exitCode, 1, r.out);
  assert.ok(r.out.includes(outageStop(2)), r.out);
  assert.equal(s.kosko.job(r.jobId).status, 'running', 'left to continue');
  assert.ok(!r.out.includes(ID.nActive));
  const again = await send(s, { evernoteExtra: { outageAfter: 2 } });
  assert.equal(again.exitCode, 0, again.out);
  assert.equal(again.jobId, r.jobId);
});

test('outage breaker: N-1 unreachable, then a success, resets the count — the run goes on', T, async () => {
  const s = await setup();
  const real = s.mcp.fetch;
  // nActive fails, nEmptyText answers, nSpace fails: two given up, never two in a row.
  const f = (url, init) => (isTool(init, 'get_note', ID.nActive) || isTool(init, 'get_note', ID.nSpace) ? new Response('{}', { status: 503 }) : real(url, init));
  const r = await send(s, { mcpFetch: f, evernoteExtra: { outageAfter: 2 } });
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.unreachable, 2);
  assert.equal(s.kosko.job(r.jobId).summary.bodies.formatted, 1);
});

test('isTransient: undici network failures, deadlines, 5xx and 429 are retried; a TypeError of our own propagates', T, async () => {
  for (const e of [new TypeError('fetch failed'), new TypeError('terminated', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }),
    new TypeError('x', { cause: { code: 'UND_ERR_SOCKET' } }), new TypeError('x', { cause: { code: 'ENOTFOUND' } }),
    Object.assign(new Error('t'), { name: 'TimeoutError' }), { status: 502 }, { status: 429 }]) assert.equal(isTransient(e), true, String(e?.message ?? e?.status));
  for (const e of [new TypeError('x.foo is not a function'), new TypeError('y', { cause: { code: 'ERR_INVALID_ARG_TYPE' } }), new SyntaxError('bad'), { status: 404 }, { status: 401 }]) {
    assert.equal(isTransient(e), false, String(e?.message ?? e?.status));
  }
  // End to end: our own TypeError on one note stops the run as a failure, never a quiet plain-text note.
  const s = await setup();
  const real = s.mcp.fetch;
  const buggy = (url, init) => { if (isTool(init, 'get_note', ID.nActive)) throw new TypeError('cannot read properties of undefined'); return real(url, init); };
  const r = await send(s, { mcpFetch: buggy });
  assert.equal(r.exitCode, 1, r.out);
  assert.match(r.out, /The import stopped: cannot read properties of undefined/);
  const net = (url, init) => { if (isTool(init, 'get_note', ID.nActive)) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); return real(url, init); };
  const s2 = await setup();
  const r2 = await send(s2, { mcpFetch: (u, i) => (isTool(i, 'get_note', ID.nActive) ? net(u, i) : s2.mcp.fetch(u, i)) });
  assert.equal(r2.exitCode, 0, r2.out);
  assert.equal(s2.kosko.job(r2.jobId).summary.bodies.unreachable, 1);
});

test('T2: the real browserAuthorize (nothing injected) gets the run\'s signal: Ctrl-C while it waits exits 130 and frees the port', T, async () => {
  const s = await setup();
  const port = await freePort();
  const ac = new AbortController();
  const pending = send(s, { signal: ac.signal, evernoteExtra: { authorize: undefined, port } });
  // Wait until the loopback listener is up, then Ctrl-C.
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/favicon.ico`).then(() => true, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  ac.abort();
  const r = await pending;
  assert.equal(r.exitCode, 130, r.out);
  assert.match(r.out, /Open this address in your browser/);
  assert.deepEqual(s.kosko.state.requests, []);
  await new Promise((r2) => setTimeout(r2, 30));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/callback?code=x&state=y`), 'the port is closed');
});
