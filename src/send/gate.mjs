// 466 rule 7 — starting a job through Kosko's busy gate (435). When too many imports are running, POST
// /api/import/jobs answers 429 imports_busy with a place in line and an estimate; asking again is what KEEPS the place
// (a silent waiter loses it after 2 minutes), so the tool asks again after gateDelayMs. Stopping — an abort, or a wait
// past the limit — leaves the line first (DELETE /api/import/jobs), so the people behind do not wait for a seat nobody
// will take. Any other refusal is passed on for the sender to handle.
import { ImportApiError, SendStopped } from './errors.mjs';
import { gateDelayMs } from './backoff.mjs';
import { abortableSleep } from './sender.mjs';

const MAX_WAIT_MS = 60 * 60_000;

export async function startThroughGate(api, body, { sleep = abortableSleep, random = Math.random, now = Date.now, signal,
  onWaiting = () => {}, maxWaitMs = MAX_WAIT_MS } = {}) {
  const started = now();
  const leave = () => api.leaveLine().catch(() => null); // best effort: the line forgets a silent waiter anyway
  for (;;) {
    try {
      return await api.startJob(body);
    } catch (e) {
      if (!(e instanceof ImportApiError) || e.kind !== 'gate') throw e;
      if (now() - started >= maxWaitMs) {
        await leave();
        throw new SendStopped('imports_busy', 'Kosko has been too busy to start your import for an hour. Run the assist again later.');
      }
      onWaiting({ position: e.position, etaMinutes: e.etaMinutes });
      try {
        await sleep(gateDelayMs({ retryAfterSeconds: e.retryAfterSeconds, random }), signal);
      } catch (x) {
        await leave();
        if (x?.name === 'AbortError') throw new SendStopped('aborted', 'Stopped before the import started. Nothing was sent.');
        throw x;
      }
    }
  }
}
