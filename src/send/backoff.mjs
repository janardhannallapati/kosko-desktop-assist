// 466 rule 12 — a COPY of Kosko's lib/enex/import-backoff.js (434 r3, 435 r2/r7), constants and formulas unchanged.
// It is copied, not shared, on purpose: these delays are a courtesy, because Kosko's database holds every limit
// (ADR-0005), so a drift here can make the tool politer or ruder but never lets it past a limit. If Kosko's numbers
// change, change them here too (test/send-backoff.test.mjs pins the same values Kosko's tests pin).
//
// busy: the server's Retry-After is the floor; on top of it, FULL jitter — a random share of Retry-After × 2^k, where
// k counts this request's consecutive refusals, capped at 30 s (Brooker, "Exponential Backoff And Jitter", 2015).
// gate: asking again is what keeps a place at the busy gate, so the wait is Retry-After ± a quarter, at most a minute.

export const BUSY_JITTER_CAP_MS = 30_000;
export const BUSY_GIVE_UP_MS = 30 * 60_000;
const DEFAULT_RETRY_SECONDS = 2;
const GATE_MAX_MS = 60_000;

export function busyDelayMs({ retryAfterSeconds, attempt = 0, random = Math.random }) {
  const seconds = Number.isFinite(retryAfterSeconds) ? Math.max(1, retryAfterSeconds) : DEFAULT_RETRY_SECONDS;
  const base = seconds * 1000;
  const spread = Math.min(BUSY_JITTER_CAP_MS, base * 2 ** attempt);
  return base + Math.floor(random() * spread);
}

export function gateDelayMs({ retryAfterSeconds, random = Math.random }) {
  const seconds = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 30;
  const ms = seconds * 1000 * (0.75 + random() * 0.5);
  return Math.min(GATE_MAX_MS, Math.round(ms));
}
