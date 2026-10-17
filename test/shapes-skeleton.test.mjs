// Kosko 537 rule 5 — a value's skeleton (keys and types, no values) and the diff of a live skeleton against the baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skeleton, merge, diffSkeletons, MAX_DEPTH, MAP_KEY } from '../src/mcp/skeleton.mjs';

test('a skeleton keeps keys and types and drops every value', () => {
  const s = skeleton({ title: 'Secret plans', n: 3, ok: true, gone: null });
  assert.deepEqual(s, { types: ['object'], keys: {
    gone: { types: ['null'] }, n: { types: ['number'] }, ok: { types: ['boolean'] }, title: { types: ['string'] } } });
  assert.ok(!JSON.stringify(s).includes('Secret'), 'no value survives');
});

test('an array merges EVERY item, not the first two', () => {
  const s = skeleton({ hits: [{ a: 1 }, { a: 2 }, { a: 3, late: 'x' }] });
  assert.deepEqual(Object.keys(s.keys.hits.items.keys), ['a', 'late']);
  assert.deepEqual(skeleton([1, 'two', null]).items.types, ['null', 'number', 'string']);
  assert.equal(skeleton([]).items, undefined, 'an empty array has no item skeleton');
});

test('the skeleton stops at MAX_DEPTH', () => {
  let v = 'leaf';
  for (let i = 0; i < MAX_DEPTH + 5; i++) v = { d: v };
  let s = skeleton(v);
  for (let i = 0; i < MAX_DEPTH; i++) s = s.keys.d;
  assert.deepEqual(s, { types: ['deep'] });
});

const base = skeleton({ hits: [{ noteId: 'g', title: 't', score: 0 }], isLastPage: true, extra: null });

test('identical shapes have no difference and nothing noted', () => {
  assert.deepEqual(diffSkeletons(base, base, 'search_notes'), { differences: [], noted: [] });
});

test('a key the baseline has and live lacks is a difference, named by its path', () => {
  const live = skeleton({ hits: [{ title: 't', score: 0 }], isLastPage: true, extra: null });
  assert.deepEqual(diffSkeletons(base, live, 'search_notes').differences, ['search_notes.hits[].noteId: string → missing']);
});

test('a non-null type that changed is a difference', () => {
  const live = skeleton({ hits: [{ noteId: 7, title: 't', score: 0 }], isLastPage: 'yes', extra: null });
  assert.deepEqual(diffSkeletons(base, live, 'search_notes').differences.sort(), [
    'search_notes.hits[].noteId: string → number', 'search_notes.isLastPage: boolean → string']);
});

test('null on either side is compatible with any type', () => {
  const live = skeleton({ hits: [{ noteId: null, title: 't', score: 0 }], isLastPage: true, extra: { now: 'filled' } });
  assert.deepEqual(diffSkeletons(base, live, 'search_notes').differences, []);
});

test('a key live has and the baseline lacks is noted, not a difference', () => {
  const live = skeleton({ hits: [{ noteId: 'g', title: 't', score: 0, snippet: 's' }], isLastPage: true, extra: null });
  const d = diffSkeletons(base, live, 'search_notes');
  assert.deepEqual(d.differences, []);
  assert.deepEqual(d.noted, ['search_notes.hits[].snippet: new (string)']);
});

test('an array empty in the live sample is noted, never silently passed or failed', () => {
  const live = skeleton({ hits: [], isLastPage: true, extra: null });
  const d = diffSkeletons(base, live, 'search_notes');
  assert.deepEqual(d.differences, []);
  assert.deepEqual(d.noted, ['search_notes.hits[]: empty in this sample, not compared']);
});

test('an object that became a string is a difference at that path, not one per lost key', () => {
  const live = skeleton({ hits: 'none', isLastPage: true, extra: null });
  assert.deepEqual(diffSkeletons(base, live, 'search_notes').differences, ['search_notes.hits: array → string']);
});

test('an object keyed by data collapses to one entry, so no tag or file name is written (review A6)', () => {
  const s = skeleton({ byName: { 'Trip to Hampi.pdf': { size: 1 }, 'minutes 2024': { size: 2 } } });
  assert.deepEqual(s.keys.byName.keys, { [MAP_KEY]: { types: ['object'], keys: { size: { types: ['number'] } } } });
  assert.ok(!JSON.stringify(s).includes('Hampi'));
  const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, i]));
  assert.deepEqual(Object.keys(skeleton(many).keys), [MAP_KEY]);
});

test('a key named __proto__ is an ordinary key, never the prototype (review A8)', () => {
  // Only on the right: `keys['__proto__']` on a plain object would read Object.prototype, not undefined.
  const m = merge(skeleton({ a: 1 }), skeleton(JSON.parse('{"__proto__": {"y": "s"}}')));
  assert.equal(Object.getPrototypeOf(m.keys), Object.prototype);
  assert.ok(Object.hasOwn(m.keys, '__proto__'));
  assert.deepEqual(Object.keys(m.keys.__proto__.keys), ['y']);
  assert.deepEqual(Object.keys(merge(m, m).keys).sort(), ['__proto__', 'a']);
});
