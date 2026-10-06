// 466 rule 7: starting a job through Kosko's busy gate — asking again keeps the place; an abort or a wait past the
// limit leaves the line (DELETE /api/import/jobs) before stopping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startThroughGate } from '../src/send/gate.mjs';
import { ImportApiError, SendStopped } from '../src/send/errors.mjs';

const gate = (position, etaMinutes) => new ImportApiError({ status: 429, kind: 'gate', code: 'imports_busy', position, etaMinutes, retryAfterSeconds: 30 });
function fakeApi(answers) {
  const calls = [];
  return {
    calls,
    startJob: async (body) => { calls.push(['start', body]); const a = answers.shift(); if (a instanceof Error) throw a; return a; },
    leaveLine: async () => { calls.push(['leave']); return null; }
  };
}
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('gate twice, then admitted: says the place each time and answers the job', async () => {
  const api = fakeApi([gate(3, 12), gate(1, null), { id: 'j', status: 'running' }]);
  const waits = [];
  const c = clock();
  const job = await startThroughGate(api, { source: 'desktop' }, { ...c, random: () => 0.5, onWaiting: (w) => waits.push(w) });
  assert.deepEqual(job, { id: 'j', status: 'running' });
  assert.deepEqual(waits, [{ position: 3, etaMinutes: 12 }, { position: 1, etaMinutes: null }]);
  assert.equal(api.calls.filter((x) => x[0] === 'start').length, 3);
  assert.ok(!api.calls.some((x) => x[0] === 'leave'));
});

test('an abort while waiting leaves the line, then stops', async () => {
  const ac = new AbortController();
  const api = fakeApi([gate(2, 5), gate(2, 5)]);
  const sleep = async () => { ac.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(startThroughGate(api, {}, { sleep, now: () => 0, signal: ac.signal }),
    (e) => e instanceof SendStopped && e.code === 'aborted');
  assert.deepEqual(api.calls.at(-1), ['leave']);
});

test('a wait past the limit leaves the line and stops with imports_busy', async () => {
  const api = fakeApi(Array.from({ length: 500 }, () => gate(9, 40)));
  await assert.rejects(startThroughGate(api, {}, { ...clock(), random: () => 0.5, maxWaitMs: 5 * 60_000 }),
    (e) => e instanceof SendStopped && e.code === 'imports_busy' && /busy/i.test(e.message));
  assert.deepEqual(api.calls.at(-1), ['leave']);
});

test('a leave that fails does not hide the stop', async () => {
  const api = fakeApi(Array.from({ length: 50 }, () => gate(1, 1)));
  api.leaveLine = async () => { throw new Error('offline'); };
  await assert.rejects(startThroughGate(api, {}, { ...clock(), random: () => 0.5, maxWaitMs: 60_000 }), (e) => e.code === 'imports_busy');
});

test('benign: any other refusal is passed on for the sender to handle', async () => {
  const busy = new ImportApiError({ status: 503, kind: 'transient', code: 'unavailable' });
  await assert.rejects(startThroughGate(fakeApi([busy]), {}, clock()), (e) => e === busy);
});

// 466 review H1 — with the REAL client: after Ctrl-C the run's signal is aborted, and the DELETE that leaves the line
// must still go out (its own short timeout), or the person behind waits for a seat nobody takes.
import { createImportApi } from '../src/send/api.mjs';
test('the real client still sends DELETE after the run is aborted', async () => {
  const ac = new AbortController();
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    sent.push(init.method);
    if (init.method === 'POST') return new Response(JSON.stringify({ code: 'imports_busy', position: 2, retryAfterSeconds: 30 }), { status: 429 });
    return new Response(null, { status: 204 });
  };
  const api = createImportApi({ app: 'https://kosko.app', token: `cvit_${'d'.repeat(64)}`, fetch: fetchImpl, signal: ac.signal });
  const sleep = async () => { ac.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(startThroughGate(api, {}, { sleep, now: () => 0, signal: ac.signal }), (e) => e.code === 'aborted');
  assert.deepEqual(sent, ['POST', 'DELETE']);
});
