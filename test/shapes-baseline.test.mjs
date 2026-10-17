// Kosko 537 rule 3 — the committed baseline is a recording of the fake, never hand-written: it must equal a fresh
// recording, and a change to what the fake answers must make it stale (so the test is not vacuous).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baselineFromFake } from './fake-mcp/shapes-fixture.mjs';

const committed = () => JSON.parse(readFileSync(new URL('../src/mcp/shapes-baseline.json', import.meta.url), 'utf8'));

test('the committed baseline equals a fresh recording of the fake (npm run shapes:baseline rewrites it)', async () => {
  assert.deepEqual(committed(), await baselineFromFake(),
    'src/mcp/shapes-baseline.json is stale: run `npm run shapes:baseline` and commit it with the fake change');
});

test('a changed fake makes the committed baseline stale', async () => {
  const changed = await baselineFromFake({ mcp: { alter: { search_notes: (d) => ({ ...d, cursor: null }) } } });
  assert.notDeepEqual(committed(), changed);
});

test('the baseline covers the three tools the run calls, with their recorded input schemas', () => {
  const b = committed();
  assert.deepEqual(Object.keys(b.results).sort(), ['get_attachment', 'get_note', 'search_notes']);
  assert.deepEqual(b.tools.get_note.properties.includes('noteId'), true);
  assert.ok(b.results.search_notes.keys.hits.items.keys.noteId, 'search_notes.hits[].noteId is in the baseline');
});
