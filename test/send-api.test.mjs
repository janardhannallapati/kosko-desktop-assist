// 466 rules 2-5 and 8: the client calls only the import token's routes, on one checked origin, never follows a
// redirect, types every refusal, and uploads with exactly the signed headers and no Authorization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImportApi, appOrigin, IMPORT_ROUTES } from '../src/send/api.mjs';
import { ImportApiError } from '../src/send/errors.mjs';

const TOKEN = `cvit_${'b2'.repeat(32)}`;
const JOB = '11111111-2222-4333-8444-555555555555';

function fake(handler) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    const r = (await handler(String(url), init)) ?? {};
    if (r.throw) throw r.throw;
    const body = r.raw !== undefined ? r.raw : r.json === undefined ? '' : JSON.stringify(r.json);
    return new Response(r.status === 204 ? null : body,
      { status: r.status ?? 200, headers: { 'content-type': r.raw !== undefined ? 'text/html' : 'application/json', ...(r.headers ?? {}) } });
  };
  return { fetchImpl, seen };
}
const api = (fetchImpl, app = 'https://kosko.app') => createImportApi({ app, token: TOKEN, fetch: fetchImpl });

test('the route list is exactly the import token allowlist (lib/bearer-scope.js IMPORT_BEARER_ROUTES, 13)', () => {
  assert.deepEqual(IMPORT_ROUTES.map((r) => `${r.method} ${r.route}`), [
    'GET /api/import/jobs', 'POST /api/import/jobs', 'DELETE /api/import/jobs', 'PATCH /api/import/jobs/[id]',
    'GET /api/import/jobs/[id]/receipt', 'GET /api/import/allowance', 'POST /api/import/notebooks',
    'POST /api/import/note-ids', 'POST /api/import/notes/batch', 'POST /api/import/attachments/batch',
    'POST /api/import/refusals', 'POST /api/import/tags', 'POST /api/import/ocr/batch'
  ]);
  assert.ok(Object.isFrozen(IMPORT_ROUTES));
});

test('every method calls a listed route, with Bearer, no-store, redirect error and a timeout signal', async () => {
  const { fetchImpl, seen } = fake(() => ({ json: { ok: true } }));
  const a = api(fetchImpl);
  await a.startJob({ source: 'desktop' });
  await a.leaveLine();
  await a.newestJob();
  await a.finishJob(JOB, { status: 'complete', summary: {} });
  await a.receipt(JOB);
  await a.allowance();
  await a.notebooks({ job_id: JOB, notebooks: [] });
  await a.noteIds({ fingerprints: [] });
  await a.notesBatch({ job_id: JOB, notes: [] });
  await a.attachmentsBatch({ job_id: JOB, items: [] });
  await a.refusal({ job_id: JOB });
  await a.tags({ job_id: JOB, names: ['a'] });
  assert.equal(seen.length, 12);
  const listed = IMPORT_ROUTES.map((r) => `${r.method} ${r.route}`);
  for (const { url, init } of seen) {
    const path = new URL(url).pathname.replace(JOB, '[id]');
    assert.ok(listed.includes(`${init.method} ${path}`), `${init.method} ${path}`);
    assert.equal(new URL(url).origin, 'https://kosko.app');
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.deepEqual(JSON.parse(seen[0].init.body), { source: 'desktop' });
});

test('a job id that is not a UUID is refused before any request', async () => {
  const { fetchImpl, seen } = fake(() => ({ json: {} }));
  await assert.rejects(api(fetchImpl).finishJob('../../other', {}), (e) => e instanceof ImportApiError && e.kind === 'invalid');
  assert.equal(seen.length, 0);
});

test('the app origin: https only, http only for 127.0.0.1, no localhost, no credentials, origin kept', () => {
  for (const bad of ['http://example.com', 'http://localhost:3003', 'https://u:p@kosko.app', 'ftp://kosko.app', 'kosko.app', '']) {
    assert.throws(() => appOrigin(bad), bad);
  }
  assert.throws(() => appOrigin('http://localhost:3003'), /127\.0\.0\.1/);
  assert.throws(() => appOrigin('https://localhost:3003'), /not localhost/, 'https does not make localhost safe from WSL');
  assert.equal(appOrigin('https://kosko.app/import?x=1'), 'https://kosko.app');
  assert.equal(appOrigin('http://127.0.0.1:3003'), 'http://127.0.0.1:3003');
  assert.equal(appOrigin(undefined), 'https://kosko.app');
});

test('every refusal is typed: busy, gate, limit, closed, auth, invalid, transient', async () => {
  const cases = [
    [{ status: 429, json: { code: 'import_busy', retryAfterSeconds: 9 } }, 'busy', 'import_busy'],
    [{ status: 429, json: { code: 'imports_busy', position: 3, etaMinutes: 12, retryAfterSeconds: 30 } }, 'gate', 'imports_busy'],
    [{ status: 429, json: { code: 'too_many_imports', retryAfterSeconds: 3600 } }, 'limit', 'too_many_imports'],
    [{ status: 409, json: { code: 'job_closed' } }, 'closed', 'job_closed'],
    [{ status: 409, json: { code: 'notebook_name_taken' } }, 'invalid', 'notebook_name_taken'],
    [{ status: 401, json: { error: 'x' } }, 'auth', 'http_401'],
    [{ status: 403, json: { code: 'forbidden' } }, 'auth', 'forbidden'],
    [{ status: 400, json: { code: 'invalid' } }, 'invalid', 'invalid'],
    [{ status: 413, json: { code: 'batch_too_large' } }, 'invalid', 'batch_too_large'],
    [{ status: 503, json: { code: 'unavailable' } }, 'transient', 'unavailable'],
    [{ status: 502, raw: '<html>bad gateway</html>' }, 'transient', 'http_502'],
    [{ throw: new TypeError('fetch failed') }, 'transient', 'network'],
    [{ throw: Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 'transient', 'timeout']
  ];
  for (const [answer, kind, code] of cases) {
    const { fetchImpl } = fake(() => answer);
    await assert.rejects(api(fetchImpl).notesBatch({ job_id: JOB, notes: [] }), (e) => {
      assert.ok(e instanceof ImportApiError, String(e));
      assert.equal(e.kind, kind, JSON.stringify(answer));
      assert.equal(e.code, code);
      return true;
    });
  }
});

test('Retry-After: the header wins over the body; the gate carries its place and estimate', async () => {
  const { fetchImpl } = fake(() => ({ status: 429, json: { code: 'import_busy', retryAfterSeconds: 9 }, headers: { 'retry-after': '4' } }));
  await assert.rejects(api(fetchImpl).tags({ job_id: JOB, names: ['a'] }), (e) => e.retryAfterSeconds === 4);
  const g = fake(() => ({ status: 429, json: { code: 'imports_busy', position: 3, etaMinutes: 12, retryAfterSeconds: 30 } }));
  await assert.rejects(api(g.fetchImpl).startJob({}), (e) => e.position === 3 && e.etaMinutes === 12 && e.retryAfterSeconds === 30);
});

test('a 2xx that is not JSON is never read as success', async () => {
  const { fetchImpl } = fake(() => ({ status: 200, raw: '<html>sign in</html>' }));
  await assert.rejects(api(fetchImpl).allowance(), (e) => e instanceof ImportApiError && e.kind === 'invalid' && e.code === 'not_json');
});

test('benign: a 204 answers null, a 2xx JSON answers its body', async () => {
  const { fetchImpl } = fake((url, init) => (init.method === 'DELETE' ? { status: 204 } : { json: { byteLimit: 5 } }));
  assert.equal(await api(fetchImpl).leaveLine(), null);
  assert.deepEqual(await api(fetchImpl).allowance(), { byteLimit: 5 });
});

test('no error the client raises carries the token', async () => {
  const answers = [{ status: 401, json: { error: `bad token ${TOKEN}` } }, { throw: new Error(`boom ${TOKEN}`) }, { status: 500, raw: TOKEN }];
  for (const a of answers) {
    const { fetchImpl } = fake(() => a);
    await assert.rejects(api(fetchImpl).allowance(), (e) => {
      assert.ok(!JSON.stringify({ m: e.message, s: e.stack, c: e.code }).includes(TOKEN.slice(5)));
      return true;
    });
  }
});

test('upload: exactly the signed headers, no Authorization, redirect error; 412 is stored', async () => {
  const { fetchImpl, seen } = fake((url) => (url.includes('dup') ? { status: 412 } : { status: 200 }));
  const a = api(fetchImpl);
  const signed = { url: 'https://store.example/k?X-Amz-Signature=1', method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': '3' }, expiresIn: 3600 };
  assert.deepEqual(await a.upload(signed, new Uint8Array([1, 2, 3])), { stored: true, already: false });
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'image/png', 'content-length': '3' });
  assert.equal(seen[0].init.method, 'PUT');
  assert.equal(seen[0].init.redirect, 'error');
  assert.ok(!Object.keys(seen[0].init.headers).some((h) => h.toLowerCase() === 'authorization'));
  assert.deepEqual(await a.upload({ ...signed, url: 'https://store.example/dup' }, new Uint8Array(3)), { stored: true, already: true });
});

test('upload: 403 is expired, 5xx transient; an http URL off 127.0.0.1 or a non-PUT is refused unsent', async () => {
  const signed = { url: 'https://store.example/k', method: 'PUT', headers: {} };
  for (const [status, kind] of [[403, 'expired'], [503, 'transient'], [400, 'invalid']]) {
    const { fetchImpl } = fake(() => ({ status }));
    await assert.rejects(api(fetchImpl).upload(signed, new Uint8Array(1)), (e) => e.kind === kind);
  }
  const { fetchImpl, seen } = fake(() => ({ status: 200 }));
  await assert.rejects(api(fetchImpl).upload({ ...signed, url: 'http://evil.example/k' }, new Uint8Array(1)), /upload/i);
  await assert.rejects(api(fetchImpl).upload({ ...signed, method: 'POST' }, new Uint8Array(1)), /upload/i);
  assert.equal(seen.length, 0);
  assert.deepEqual(await api(fetchImpl).upload({ ...signed, url: 'http://127.0.0.1:54390/k' }, new Uint8Array(1)), { stored: true, already: false });
});

// 466 review M4/M5 and LOW — a 2xx whose body cannot be read is resent, not a stop; an abort is its own kind; a
// redirect is refused (invalid, never resent); an object store's 408/429 are transient.
test('a 2xx whose body read fails is transient', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError('terminated'); } });
  await assert.rejects(api(fetchImpl).notesBatch({ job_id: JOB, notes: [] }), (e) => e.kind === 'transient' && e.code === 'body_read');
});

test('a request the run aborted is kind aborted; a refused redirect is invalid', async () => {
  const ac = new AbortController();
  ac.abort();
  const a = createImportApi({ app: 'https://kosko.app', token: TOKEN, signal: ac.signal,
    fetch: async (u, init) => { if (init.signal.aborted) throw Object.assign(new Error('x'), { name: 'AbortError' }); return new Response('{}'); } });
  await assert.rejects(a.allowance(), (e) => e.kind === 'aborted');
  const redirect = async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); };
  await assert.rejects(api(redirect).allowance(), (e) => e.kind === 'invalid' && e.code === 'redirect');
});

test('an object store answering 408 or 429 is transient', async () => {
  for (const status of [408, 429]) {
    const { fetchImpl } = fake(() => ({ status }));
    await assert.rejects(api(fetchImpl).upload({ url: 'https://store.example/k', method: 'PUT', headers: {} }, new Uint8Array(1)), (e) => e.kind === 'transient');
  }
});
