// 466 rule 12: the delays are Kosko's (lib/enex/import-backoff.js, 434/435) — the same constants and formulas, and the
// same numbers Kosko's own tests pin. A courtesy: the database holds the limit (ADR-0005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyDelayMs, gateDelayMs, BUSY_JITTER_CAP_MS, BUSY_GIVE_UP_MS } from '../src/send/backoff.mjs';

test('the constants are Kosko\'s', () => {
  assert.equal(BUSY_JITTER_CAP_MS, 30_000);
  assert.equal(BUSY_GIVE_UP_MS, 30 * 60_000);
});

test('busy: Retry-After is the floor, the jitter doubles per attempt and is capped at 30 s', () => {
  assert.equal(busyDelayMs({ retryAfterSeconds: 3, attempt: 0, random: () => 0 }), 3000);
  assert.equal(busyDelayMs({ retryAfterSeconds: 3, attempt: 0, random: () => 0.5 }), 4500);
  assert.equal(busyDelayMs({ retryAfterSeconds: 3, attempt: 2, random: () => 0.5 }), 9000);
  assert.equal(busyDelayMs({ retryAfterSeconds: 3, attempt: 10, random: () => 0.999999 }), 3000 + 29_999);
  assert.equal(busyDelayMs({ retryAfterSeconds: undefined, random: () => 0 }), 2000, 'no Retry-After: 2 s');
  assert.equal(busyDelayMs({ retryAfterSeconds: 0, random: () => 0 }), 1000, 'never under 1 s');
});

test('gate: Retry-After ± a quarter, at most a minute, 30 s when the server named none', () => {
  assert.equal(gateDelayMs({ retryAfterSeconds: 20, random: () => 0 }), 15_000);
  assert.equal(gateDelayMs({ retryAfterSeconds: 20, random: () => 1 }), 25_000);
  assert.equal(gateDelayMs({ retryAfterSeconds: 120, random: () => 0.5 }), 60_000);
  assert.equal(gateDelayMs({ retryAfterSeconds: null, random: () => 0.5 }), 30_000);
});
