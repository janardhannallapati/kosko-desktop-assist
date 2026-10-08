// One request in flight, at a rate the server sets. Evernote's FAQ: "Tool calls are rate-limited per minute —
// both per tool and across all tools. If you hit a limit, pause briefly and try again." No numbers are published,
// so the pacer starts slow, halves on every limit, and creeps up only after a clean stretch.

export class RateLimitError extends Error {
  constructor(message, retryAfterSec = null, status = 429) {
    super(message);
    this.retryAfterSec = retryAfterSec;
    this.status = status;
  }
}

/** The pacer's retries ran out on rate limits. 512's route treats it as a transient failure of that one call. */
export class PacerGaveUp extends Error {}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export class Pacer {
  constructor({ rps = 1, minRps = 0.05, maxRps = 10, cleanStretch = 20, maxRetries = 5, maxBackoffMs = 300_000,
    sleep = sleepReal, now = Date.now, onLimit = () => {} } = {}) {
    Object.assign(this, { rps, minRps, maxRps, cleanStretch, maxRetries, maxBackoffMs, sleep, now, onLimit });
    this.nextAt = 0;
    this.cleanCount = 0;
  }

  async run(fn) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = this.now() + 1000 / this.rps;
      try {
        const out = await fn();
        if (++this.cleanCount >= this.cleanStretch) {
          this.rps = Math.min(this.maxRps, this.rps * 1.25);
          this.cleanCount = 0;
        }
        return out;
      } catch (e) {
        if (!(e instanceof RateLimitError)) throw e;
        if (attempt >= this.maxRetries) throw new PacerGaveUp(`gave up after ${this.maxRetries} retries: ${e.message}`);
        const backoff = e.retryAfterSec != null
          ? e.retryAfterSec * 1000
          : Math.min(this.maxBackoffMs, 5000 * 2 ** attempt);
        this.rps = Math.max(this.minRps, this.rps / 2);
        this.cleanCount = 0;
        this.onLimit({ status: e.status, retryAfterSec: e.retryAfterSec, waitedMs: backoff, newRps: this.rps });
        await this.sleep(backoff);
        this.nextAt = 0;
      }
    }
  }
}
