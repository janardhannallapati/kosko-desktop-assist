import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer, RateLimitError } from '../src/mcp/pacer.mjs';

function fakeClock() {
  let t = 0;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}

test('429 with Retry-After waits that long and halves the rate', async () => {
  const c = fakeClock();
  const limits = [];
  const p = new Pacer({ rps: 2, now: c.now, sleep: c.sleep, onLimit: (l) => limits.push(l) });
  let n = 0;
  const out = await p.run(async () => { if (n++ === 0) throw new RateLimitError('429', 7); return 'ok'; });
  assert.equal(out, 'ok');
  assert.ok(c.slept.includes(7000));
  assert.equal(p.rps, 1);
  assert.equal(limits[0].retryAfterSec, 7);
});

test('without Retry-After it backs off 5 s then doubles', async () => {
  const c = fakeClock();
  const p = new Pacer({ rps: 1, now: c.now, sleep: c.sleep });
  let n = 0;
  await p.run(async () => { if (n++ < 2) throw new RateLimitError('429'); return 1; });
  assert.ok(c.slept.includes(5000) && c.slept.includes(10000));
});

test('gives up after 5 retries', async () => {
  const c = fakeClock();
  const p = new Pacer({ now: c.now, sleep: c.sleep });
  let calls = 0;
  await assert.rejects(p.run(async () => { calls++; throw new RateLimitError('429', 1); }), /gave up after 5 retries/);
  assert.equal(calls, 6);
});

test('a non-limit error is not retried', async () => {
  const c = fakeClock();
  const p = new Pacer({ now: c.now, sleep: c.sleep });
  let calls = 0;
  await assert.rejects(p.run(async () => { calls++; throw new Error('boom'); }), /boom/);
  assert.equal(calls, 1);
});

test('rate rises after a clean stretch', async () => {
  const c = fakeClock();
  const p = new Pacer({ rps: 1, cleanStretch: 3, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 3; i++) await p.run(async () => 1);
  assert.equal(p.rps, 1.25);
});

test('spaces calls at 1/rps', async () => {
  const c = fakeClock();
  const p = new Pacer({ rps: 2, cleanStretch: 1000, now: c.now, sleep: c.sleep });
  await p.run(async () => 1);
  await p.run(async () => 1);
  assert.deepEqual(c.slept, [500]);
});
