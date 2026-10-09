// 466 rule 6 — every import request goes through call(): one in flight, and the ONE place that decides what a refusal
// means for the run. busy (a write slot was not free) waits Kosko's full jitter and resends, until a 30-minute busy
// spell stops the run; transient (5xx, timeout, network) resends five times — safe because Kosko's ledger makes every
// resend idempotent (432); limit, closed, auth and invalid stop at once with one plain sentence. An abort ends any wait.
// Java: resilience4j's Retry with a per-exception IntervalBiFunction, where most exceptions are not retried at all.
import { ImportApiError, SendStopped, TOKEN_INVALID } from './errors.mjs';
import { busyDelayMs, BUSY_GIVE_UP_MS } from './backoff.mjs';

const TRANSIENT_RETRIES = 5;
// A Retry-After the server means is never this long; a bigger one would overflow setTimeout (2^31 ms) and fire at once,
// turning the wait into a hot loop (466 review M6). Kosko's own formula stays a byte-for-byte copy (backoff.mjs).
const MAX_WAIT_MS = 15 * 60_000;
export const STOPPED = 'Stopped. Run the assist again to continue — nothing is sent twice.';

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const inHours = (seconds) => (!Number.isFinite(seconds) || seconds <= 3600 ? 'in an hour' : `in ${Math.ceil(seconds / 3600)} hours`);

function stopFor(e) {
  switch (e.kind) {
    case 'limit': return new SendStopped('too_many_imports', `Too many imports were started recently. Try again ${inHours(e.retryAfterSeconds)}.`);
    case 'closed': return new SendStopped('job_closed', 'This import was closed in Kosko (a newer import continued it). Run the assist again to continue — nothing is sent twice.');
    case 'auth': return new SendStopped('auth', TOKEN_INVALID);
    default: return new SendStopped(e.code, `Kosko refused a request (${e.code}). The import stopped; nothing already sent is lost.`);
  }
}

export function createSender({ sleep = abortableSleep, random = Math.random, now = Date.now, signal, onWait = () => {},
  busyGiveUpMs = BUSY_GIVE_UP_MS, transientRetries = TRANSIENT_RETRIES } = {}) {
  let busySince = null; // a busy spell spans requests: it ends at the next success
  let queue = Promise.resolve(); // one request in flight: each call waits for the one before (466 review M3)

  const wait = async (ms) => {
    try { await sleep(ms, signal); } catch (e) {
      if (e?.name === 'AbortError') throw new SendStopped('aborted', STOPPED);
      throw e;
    }
  };

  async function run(fn) {
    let busyAttempt = 0;
    let transient = 0;
    for (;;) {
      if (signal?.aborted) throw new SendStopped('aborted', STOPPED);
      try {
        const out = await fn();
        busySince = null;
        return out;
      } catch (e) {
        if (!(e instanceof ImportApiError)) throw e;
        if (e.kind === 'aborted') throw new SendStopped('aborted', STOPPED);
        if (e.kind === 'busy') {
          busySince ??= now();
          if (now() - busySince >= busyGiveUpMs) {
            throw new SendStopped('import_busy', 'Kosko has been busy for 30 minutes, so the import stopped. Run the assist again later — it continues where it stopped.');
          }
          const ms = Math.min(MAX_WAIT_MS, busyDelayMs({ retryAfterSeconds: e.retryAfterSeconds, attempt: busyAttempt++, random }));
          onWait({ kind: 'busy', ms });
          await wait(ms);
        } else if (e.kind === 'transient') {
          if (++transient > transientRetries) {
            throw new SendStopped('unavailable', "Kosko couldn't be reached after several tries. Run the assist again — nothing is sent twice.");
          }
          const ms = 1000 * 2 ** transient + Math.floor(random() * 1000);
          onWait({ kind: 'transient', ms });
          await wait(ms);
        } else {
          throw stopFor(e);
        }
      }
    }
  }

  return {
    call(fn) {
      const turn = queue.then(() => run(fn));
      queue = turn.catch(() => {});
      return turn;
    }
  };
}
