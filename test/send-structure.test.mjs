// 467 rules 3-5: notebooks under their stacks, Space notebooks for notes with no notebook, every tag by its full path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notebookPlan, spaceNames, tagPaths, noteTagNames, NO_NOTEBOOK } from '../src/send/library/structure.mjs';

const plan = (x = {}) => ({
  stacks: [{ name: 'Work', notebookCount: 2 }],
  notebooks: [{ id: 'n1', name: 'Receipts', stack: 'Work' }, { id: 'n2', name: 'Projects', stack: 'Work' }, { id: 'n3', name: 'Loose', stack: null }],
  spaces: [{ id: 'ws-a', name: 'Work', created: 2 }, { id: 'ws-b', name: 'Work', created: 1 }, { id: 'ws-c', name: 'Home', created: 3 }],
  notes: [{ id: 'g1', notebookId: 'n1' }, { id: 'g2', notebookId: null, workspaceId: 'ws-a' }, { id: 'g3', notebookId: null, workspaceId: 'ws-b' },
    { id: 'g4', notebookId: null, workspaceId: null }, { id: 'g5', notebookId: null, workspaceId: 'ws-unknown' }],
  ...x
});

test('stacks are parents; each notebook sits under its stack', () => {
  const { entries, parentKeyOf } = notebookPlan(plan());
  assert.deepEqual(entries.filter((e) => e.key.startsWith('stack:') || e.key.startsWith('nb:')), [
    { key: 'stack:Work', name: 'Work', parent_key: null },
    { key: 'nb:n1', name: 'Receipts', parent_key: 'stack:Work' },
    { key: 'nb:n2', name: 'Projects', parent_key: 'stack:Work' },
    { key: 'nb:n3', name: 'Loose', parent_key: null }
  ]);
  assert.equal(parentKeyOf({ notebookId: 'n1' }), 'nb:n1');
});

test('two Spaces with one name are told apart by when they were created', () => {
  assert.deepEqual([...spaceNames(plan().spaces)], [['ws-b', 'Work'], ['ws-a', 'Work (2)'], ['ws-c', 'Home']]);
});

test('notes with no notebook go into their Space\'s notebook; none or unknown → one fallback notebook', () => {
  const { entries, parentKeyOf } = notebookPlan(plan());
  const spaces = entries.filter((e) => e.key.startsWith('space:'));
  // oldest Space first; both "Work" Spaces meet the top-level stack "Work", so they number on from it
  assert.deepEqual(spaces, [
    { key: 'space:ws-b', name: 'Work (2)', parent_key: null },
    { key: 'space:ws-a', name: 'Work (3)', parent_key: null },
    { key: 'space:none', name: NO_NOTEBOOK, parent_key: null }
  ]);
  assert.equal(parentKeyOf({ notebookId: null, workspaceId: 'ws-a' }), 'space:ws-a');
  assert.equal(parentKeyOf({ notebookId: null, workspaceId: null }), 'space:none');
  assert.equal(parentKeyOf({ notebookId: null, workspaceId: 'ws-unknown' }), 'space:none');
  assert.equal(NO_NOTEBOOK, 'Evernote — no notebook');
});

test('a plan written before Spaces were read falls back to one notebook', () => {
  const { entries } = notebookPlan(plan({ spaces: undefined }));
  assert.deepEqual(entries.filter((e) => e.key.startsWith('space:')).map((e) => e.name), [NO_NOTEBOOK]);
});

test('siblings that would share a name in Kosko are numbered, the user\'s notebooks first', () => {
  const { entries } = notebookPlan(plan({ notebooks: [{ id: 'n9', name: 'work', stack: null }], notes: [{ id: 'g', notebookId: null, workspaceId: 'ws-c' }], spaces: [{ id: 'ws-c', name: 'WORK ', created: 1 }] }));
  const top = entries.filter((e) => e.parent_key === null).map((e) => e.name);
  // entries are stacks, notebooks, Spaces; the notebook keeps its name, the stack is (2), the Space (3); names trimmed
  assert.deepEqual(top, ['Work (2)', 'work', 'WORK (3)']);
});

test('no Space notebook is made when every note has a notebook', () => {
  const { entries } = notebookPlan(plan({ notes: [{ id: 'g1', notebookId: 'n1' }] }));
  assert.ok(!entries.some((e) => e.key.startsWith('space:')));
});

test('over 2,000 notebooks stops with a sentence', () => {
  const notebooks = Array.from({ length: 2001 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, stack: null }));
  assert.throws(() => notebookPlan(plan({ stacks: [], notebooks, notes: [] })), /2,000/);
});

test('every tag is named by its full path; a cycle or a missing parent never loops', () => {
  const paths = tagPaths([{ id: 't1', name: 'Travel', parentId: null }, { id: 't2', name: 'Japan', parentId: 't1' }, { id: 't3', name: 'Tokyo', parentId: 't2' },
    { id: 'x', name: 'A', parentId: 'y' }, { id: 'y', name: 'B', parentId: 'x' }, { id: 'z', name: 'Orphan', parentId: 'gone' }]);
  assert.equal(paths.get('t1'), 'Travel');
  assert.equal(paths.get('t2'), 'Travel/Japan');
  assert.equal(paths.get('t3'), 'Travel/Japan/Tokyo');
  assert.equal(paths.get('z'), 'Orphan');
  assert.ok(paths.get('x').length < 100 && paths.get('y').length < 100);
});

test('a note\'s tags are its links\' full names', () => {
  const paths = tagPaths([{ id: 't1', name: 'Travel', parentId: null }, { id: 't2', name: 'Japan', parentId: 't1' }]);
  const names = noteTagNames([{ noteId: 'g1', tagId: 't2' }, { noteId: 'g1', tagId: 't1' }, { noteId: 'g2', tagId: 'missing' }], paths);
  assert.deepEqual(names.get('g1'), ['Travel/Japan', 'Travel']);
  assert.deepEqual(names.get('g2') ?? [], []);
});

test('a numbered name never lands on a name already taken', () => {
  const { entries } = notebookPlan({ stacks: [], notebooks: [{ id: 'a', name: 'Work (2)', stack: null }], notes: [{ id: 'g1', notebookId: null, workspaceId: 's1' }, { id: 'g2', notebookId: null, workspaceId: 's2' }],
    spaces: [{ id: 's1', name: 'Work', created: 1 }, { id: 's2', name: 'Work', created: 2 }] });
  const names = entries.map((e) => e.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, names.join(', '));
  assert.deepEqual(entries.map((e) => e.name), ['Work (2)', 'Work', 'Work (3)']);
});
