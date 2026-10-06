// 466 rule 6: one request in flight; busy waits Kosko's full jitter and gives up after 30 minutes; transient resends
// five times; limit, closed, auth and invalid stop at once with a sentence; an abort ends any wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSender } from '../src/send/sender.mjs';
import { ImportApiError, SendStopped } from '../src/send/errors.mjs';

const err = (kind, code, extra = {}) => new ImportApiError({ status: 0, kind, code, ...extra });
function clock() {
  let t = 0;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}
const sender = (c, extra = {}) => createSender({ now: c.now, sleep: c.sleep, random: () => 0, ...extra });

test('busy then ok: resent after at least Retry-After', async () => {
  const c = clock();
  let n = 0;
  const out = await sender(c).call(async () => { if (n++ < 2) throw err('busy', 'import_busy', { retryAfterSeconds: 3 }); return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(n, 3);
  assert.deepEqual(c.slept, [3000, 3000]);
});

test('30 minutes of busy stops the run with import_busy', async () => {
  const c = clock();
  await assert.rejects(sender(c).call(async () => { throw err('busy', 'import_busy', { retryAfterSeconds: 60 }); }),
    (e) => e instanceof SendStopped && e.code === 'import_busy' && /busy/i.test(e.message));
  assert.ok(c.now() >= 30 * 60_000);
});

test('a success ends the busy spell: the next busy request has its own 30 minutes', async () => {
  const c = clock();
  const s = sender(c);
  let n = 0;
  await s.call(async () => { if (n++ < 25) throw err('busy', 'import_busy', { retryAfterSeconds: 60 }); return 1; });
  let m = 0;
  assert.equal(await s.call(async () => { if (m++ < 25) throw err('busy', 'import_busy', { retryAfterSeconds: 60 }); return 2; }), 2);
});

test('transient: five resends, then a stop', async () => {
  const c = clock();
  let n = 0;
  assert.equal(await sender(c).call(async () => { if (n++ < 5) throw err('transient', 'unavailable'); return 'ok'; }), 'ok');
  assert.deepEqual(c.slept, [2000, 4000, 8000, 16000, 32000]);
  let m = 0;
  await assert.rejects(sender(clock()).call(async () => { m++; throw err('transient', 'network'); }),
    (e) => e instanceof SendStopped && e.code === 'unavailable');
  assert.equal(m, 6);
});

test('limit, closed, auth and invalid stop at once, each with its own sentence', async () => {
  const cases = [
    [err('limit', 'too_many_imports', { retryAfterSeconds: 7200 }), 'too_many_imports', /in 2 hours/],
    [err('closed', 'job_closed'), 'job_closed', /closed/],
    [err('auth', 'http_401'), 'auth', /not valid any more/],
    [err('invalid', 'batch_too_large'), 'batch_too_large', /refused/]
  ];
  for (const [e, code, re] of cases) {
    let n = 0;
    await assert.rejects(sender(clock()).call(async () => { n++; throw e; }), (x) => {
      assert.ok(x instanceof SendStopped);
      assert.equal(x.code, code);
      assert.match(x.message, re);
      return true;
    });
    assert.equal(n, 1, `${code} is never resent`);
  }
});

test('an error that is not a Kosko answer passes through untouched', async () => {
  const boom = new RangeError('a bug');
  await assert.rejects(sender(clock()).call(async () => { throw boom; }), (e) => e === boom);
});

test('an abort during a wait ends it at once', async () => {
  const ac = new AbortController();
  const s = createSender({ signal: ac.signal, random: () => 0 });
  const started = performance.now();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(s.call(async () => { throw err('busy', 'import_busy', { retryAfterSeconds: 60 }); }),
    (e) => e instanceof SendStopped && e.code === 'aborted');
  assert.ok(performance.now() - started < 2000);
});

test('benign: an answer passes straight through with no wait', async () => {
  const c = clock();
  assert.deepEqual(await sender(c).call(async () => ({ ok: 1 })), { ok: 1 });
  assert.deepEqual(c.slept, []);
});

// 466 review M3/M5/M6 — one request really is in flight at a time; an aborted request stops at once; a huge
// Retry-After cannot overflow setTimeout into a hot loop.
test('two calls at once run one after the other', async () => {
  const s = createSender({ random: () => 0 });
  let inFlight = 0;
  let most = 0;
  const work = async () => { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 10)); inFlight--; return 1; };
  await Promise.all([s.call(work), s.call(work), s.call(work)]);
  assert.equal(most, 1);
});

test('a request aborted by the run stops at once, with no wait', async () => {
  const c = clock();
  await assert.rejects(sender(c).call(async () => { throw err('aborted', 'aborted'); }), (e) => e instanceof SendStopped && e.code === 'aborted');
  assert.deepEqual(c.slept, []);
});

test('a Retry-After past a day is capped at 15 minutes per wait', async () => {
  const c = clock();
  let n = 0;
  await sender(c).call(async () => { if (n++ === 0) throw err('busy', 'import_busy', { retryAfterSeconds: 9e9 }); return 1; });
  assert.deepEqual(c.slept, [15 * 60_000]);
});
