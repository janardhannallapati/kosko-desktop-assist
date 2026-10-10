// 528 rules 2-3 (Kosko doc 528): the running lines while `send` works. On a terminal, two lines redrawn in place at
// most once a second, cleared before any other line is printed; into a file or a pipe, the same two lines every
// 30 s and at the end, with no control characters. The clock and the stream are inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressLines, createSendProgress } from '../src/send/library/send-progress.mjs';

const state = (over = {}) => ({
  settled: 2750, notes: { created: 2690, updated: 50, skipped: 10, not_imported: 0 }, bytes: 0,
  notebook: { name: 'Work - Clients', index: 312, count: 579 }, ...over
});

test('the two lines: counts, then the notebook and the estimate', () => {
  const [a, b] = progressLines(state(), 5532, { kind: 'measured', low: 20, high: 25 });
  // 2,750 / 5,532 is 49.7 %: rounded DOWN, so the line never says 100 % before the last note.
  assert.equal(a, 'Sent 2,750 of 5,532 notes (49 %): 2,690 created, 50 updated, 10 already in Kosko');
  assert.equal(b, 'Now: Work - Clients, notebook 312 of 579 · about 20–25 minutes left');
});

test('not imported is named only when there are some; no estimate, no dot', () => {
  const [a, b] = progressLines(state({ notes: { created: 1, updated: 0, skipped: 0, not_imported: 2 }, settled: 3 }), 10, { kind: 'none' });
  assert.equal(a, 'Sent 3 of 10 notes (30 %): 1 created, 0 updated, 0 already in Kosko, 2 not imported');
  assert.equal(b, 'Now: Work - Clients, notebook 312 of 579');
});

test('the rough estimate says it is a first guess', () => {
  const [, b] = progressLines(state(), 5532, { kind: 'rough', minutes: 50 });
  assert.equal(b, 'Now: Work - Clients, notebook 312 of 579 · roughly 50 minutes left (a first guess)');
});

function stream(isTTY) {
  const writes = [];
  return { isTTY, write: (s) => { writes.push(s); return true; }, writes, text: () => writes.join('') };
}

test('a terminal: redrawn in place at most once a second, cleared before another line, left on screen at the end', () => {
  let t = 0;
  const out = stream(true);
  const p = createSendProgress({ total: 100, out, now: () => t });
  p.update(state({ settled: 10 }));
  p.update(state({ settled: 20 })); // same instant: not redrawn
  assert.equal((out.text().match(/Sent /g) || []).length, 1);
  t = 1000;
  p.update(state({ settled: 30 }));
  assert.equal((out.text().match(/Sent /g) || []).length, 2);
  assert.match(out.writes.at(-1), /\x1b\[2K/, 'a redraw erases what was there');
  const before = out.writes.length;
  p.clear();
  assert.ok(out.writes.length > before, 'clear erases the two lines before another line is printed');
  t = 1100;
  p.finish(state({ settled: 100 }));
  assert.match(out.text(), /Sent 100 of 100 notes \(100 %\)/, 'the final redraw always happens');
  assert.ok(out.text().endsWith('\n'), 'and the cursor ends on a fresh line');
});

test('a pipe: every 30 s and at the end, plain lines, no control characters', () => {
  let t = 0;
  const out = stream(false);
  const p = createSendProgress({ total: 100, out, now: () => t });
  for (let s = 1; s <= 59; s++) { t = s * 1000; p.update(state({ settled: s })); }
  assert.equal((out.text().match(/Sent /g) || []).length, 1, 'once in the first minute: at 30 s');
  t = 60_000; p.update(state({ settled: 60 }));
  assert.equal((out.text().match(/Sent /g) || []).length, 2);
  p.clear(); // a no-op off a terminal
  p.finish(state({ settled: 100 }));
  assert.equal((out.text().match(/Sent /g) || []).length, 3);
  assert.doesNotMatch(out.text(), /\x1b/);
});

test('a short run off a terminal still prints its final lines (benign)', () => {
  const out = stream(false);
  const p = createSendProgress({ total: 3, out, now: () => 0 });
  p.update(state({ settled: 1 }));
  p.finish(state({ settled: 3, notes: { created: 3, updated: 0, skipped: 0, not_imported: 0 } }));
  assert.match(out.text(), /^Sent 3 of 3 notes \(100 %\): 3 created/m);
});
