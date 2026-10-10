// 528 — the same cases as Kosko's lib/enex/__tests__/import-estimate.test.js, over the tool's copy (send-estimate.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEstimator, estimateText, roundRange } from '../src/send/library/send-estimate.mjs';

const MIN = 60_000;
function clocked(totalNotes, totalBytes = 0) {
  let t = 0;
  const est = createEstimator({ totalNotes, totalBytes, now: () => t });
  return { est, at: (ms, notes, bytes = 0) => { t = ms; return est.sample({ notes, bytes }); } };
}

describe('when there is no estimate yet', () => {
  it('says nothing before a minute has passed, however far the run is', () => {
    const { at } = clocked(1000);
    at(0, 0);
    assert.deepEqual(at(59_999, 500), { kind: 'none' });
    assert.deepEqual(at(60_000, 500).kind, 'rough');
  });

  it('says nothing before 5 % of the notes, however long it has run', () => {
    const { at } = clocked(1000);
    at(0, 0);
    assert.deepEqual(at(5 * MIN, 49), { kind: 'none' });
    assert.equal(at(5 * MIN + 1, 50).kind, 'rough');
  });
});

describe('the rough figure', () => {
  it('extrapolates the average so far, rounded', () => {
    const { at } = clocked(1000);
    at(0, 0);
    // 100 notes in 2 minutes -> 900 left at 50/min = 18 min -> rounded to 20 (5-minute steps above 10).
    assert.deepEqual(at(2 * MIN, 100), { kind: 'rough', minutes: 20 });
  });

  it('takes the slower of notes and bytes', () => {
    const { at } = clocked(1000, 1000);
    at(0, 0, 0);
    // notes say 18 min left, bytes (100 of 1000 bytes in 2 min... but only 50 here) say 38 min.
    assert.deepEqual(at(2 * MIN, 100, 50), { kind: 'rough', minutes: 40 });
  });
});

describe('the measured range', () => {
  it('appears once the rolling rate has held within ±25 % for 3 samples, and stays', () => {
    const { at } = clocked(3000);
    at(0, 0);
    let last;
    for (let s = 1; s <= 8; s++) last = at(s * 30_000, s * 50); // a steady 100 notes a minute
    assert.deepEqual(last.kind, 'measured');
    // 2,600 left at 100/min = 26 min -> ±20 % = 20.8..31.2 -> 20..35 in 5-minute steps.
    assert.equal(last.low, 20);
    assert.equal(last.high, 35);
  });

  it('stays rough while the rate is still swinging', () => {
    const { at } = clocked(3000);
    at(0, 0);
    const notes = [0, 40, 200, 220, 500, 520, 800, 820];
    let last;
    notes.forEach((n, i) => { if (i) last = at(i * 30_000, n); });
    assert.deepEqual(last.kind, 'rough');
  });

  it('never rises more than 20 % above the last figure shown, even when the rate collapses', () => {
    const { at } = clocked(3000);
    at(0, 0);
    let shown;
    for (let s = 1; s <= 8; s++) shown = at(s * 30_000, s * 50);
    const slow = at(9 * 30_000 + 5 * MIN, 410); // five minutes with almost nothing done
    assert.ok(slow.high <= Math.ceil(shown.high * 1.2 / 5) * 5);
    assert.ok(slow.low <= slow.high);
  });

  it('says "less than a minute" at the very end', () => {
    const { at } = clocked(100);
    at(0, 0);
    let last;
    for (let s = 1; s <= 12; s++) last = at(s * 10_000 + MIN, Math.min(99, s * 8 + 5));
    assert.deepEqual(at(13 * 10_000 + MIN, 99), { kind: 'soon' });
    assert.ok(last);
  });
});

describe('rounding (roundRange)', () => {
  it('rounds to 5 minutes above 10 and to 1 below, low down and high up', () => {
    assert.deepEqual(roundRange(20.8, 31.2), { low: 20, high: 35 });
    assert.deepEqual(roundRange(4.2, 6.3), { low: 4, high: 7 });
    assert.deepEqual(roundRange(8.5, 12.1), { low: 8, high: 15 });
  });
  it('never shows a range that collapses to nothing or starts at zero', () => {
    assert.deepEqual(roundRange(0.2, 0.9), { low: 1, high: 1 });
  });
});

describe('the words (estimateText)', () => {
  it('words each state, and has none for "none"', () => {
    assert.equal(estimateText({ kind: 'none' }), null);
    assert.deepEqual(estimateText({ kind: 'soon' }), 'Less than a minute left.');
    assert.deepEqual(estimateText({ kind: 'rough', minutes: 10 }), 'Roughly 10 minutes left: a first guess from your export’s size.');
    assert.deepEqual(estimateText({ kind: 'rough', minutes: 1 }), 'Roughly 1 minute left: a first guess from your export’s size.');
    assert.deepEqual(estimateText({ kind: 'measured', low: 5, high: 10 }), 'About 5–10 minutes left.');
    assert.deepEqual(estimateText({ kind: 'measured', low: 1, high: 1 }), 'About 1 minute left.');
  });
});

