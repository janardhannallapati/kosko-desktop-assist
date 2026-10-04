import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAccount } from '../src/reader/reader.mjs';
import { buildSyntheticAccount, ID, HASH, RECO_WORDS, EXPECTED_COUNTS } from './fixtures/synthetic-db.mjs';

const acct = buildSyntheticAccount();
const a = await openAccount(acct, { tmpRoot: mkdtempSync(join(tmpdir(), 'kosko-reader-test-')) });
after(() => a.close());

const notes = [...a.notes()];
const atts = [...a.attachments()];
const ocr = [...a.ocr()];
const noteTags = [...a.noteTags()];
const byId = (list, id) => list.find((x) => x.id === id);

test('counts() matches the synthetic account', () => {
  assert.deepEqual(a.counts(), EXPECTED_COUNTS);
});

test('meta reports versions and the snapshot path', () => {
  assert.equal(a.meta.majorVersion, 3);
  assert.equal(a.meta.migrationVersion, 139);
  assert.match(a.meta.snapshotPath, /kosko-assist-/);
});

test('active note yields with its fields', () => {
  const n = byId(notes, ID.nActive);
  assert.deepEqual(n, { id: ID.nActive, title: 'Active note', created: Date.UTC(2014, 2, 4, 10, 30, 15),
    updated: Date.UTC(2014, 2, 4, 10, 30, 16), notebookId: ID.nbWork1, workspaceId: null, plainText: 'hello world' });
});

test('trashed note, its tags, attachments and OCR are not yielded but counted', () => {
  assert.equal(byId(notes, ID.nTrashed), undefined);
  assert.equal(noteTags.some((t) => t.noteId === ID.nTrashed), false);
  assert.equal(atts.some((x) => x.noteId === ID.nTrashed), false);
  assert.equal(ocr.some((x) => x.attachmentId === ID.aTrashedNote), false);
  const c = a.counts();
  assert.equal(c.trashedNotes, 1);
  assert.equal(c.noteTagsAll, 3);
  assert.equal(c.ocrAll, 4);
});

test('what the iterators yield equals counts()', () => {
  const c = a.counts();
  assert.equal(notes.length, c.notes);
  assert.equal(atts.length, c.attachments);
  assert.equal(ocr.length, c.ocr);
  assert.equal(noteTags.length, c.noteTags);
  assert.equal(atts.reduce((s, x) => s + x.size, 0), c.attachmentBytes);
});

test('present file with exact size → present', () => {
  const x = byId(atts, ID.aPresent);
  assert.equal(x.cache.status, 'present');
  assert.equal(x.cache.path, join(acct.resourceCacheDir, ID.nActive, HASH.present));
  assert.equal(x.filename, 'receipt.png');
  assert.equal(x.mime, 'image/png');
  assert.equal(x.size, 5);
});

test('inactive attachment is skipped', () => {
  assert.equal(byId(atts, ID.aInactive), undefined);
});

test('missing file → missing', () => {
  assert.equal(byId(atts, ID.aMissing).cache.status, 'missing');
});

test('wrong size → size-mismatch with actualSize', () => {
  const x = byId(atts, ID.aWrongSize);
  assert.equal(x.cache.status, 'size-mismatch');
  assert.equal(x.cache.actualSize, 4);
});

test('a ../ note id gets invalid-id and no path', () => {
  const x = byId(atts, ID.aOnBadIdNote);
  assert.equal(x.cache.status, 'invalid-id');
  assert.equal(x.cache.path, null);
});

test('a non-hex dataHash gets invalid-id', () => {
  assert.equal(byId(atts, ID.aBadHash).cache.status, 'invalid-id');
});

test('OCR gives the top-candidate text, and a bad record an error while the run continues', () => {
  assert.deepEqual(ocr.find((x) => x.attachmentId === ID.aPresent), { attachmentId: ID.aPresent, text: RECO_WORDS, wordCount: 3 });
  const bad = ocr.find((x) => x.attachmentId === ID.aWrongSize);
  assert.match(bad.error, /hex/);
  assert.deepEqual(ocr.find((x) => x.attachmentId === ID.aMissing), { attachmentId: ID.aMissing, text: '', wordCount: 0 });
  assert.equal('text' in bad, false);
});

test('stack is personal_Stack_id, then recipient_Stack_id', () => {
  const nbs = a.notebooks();
  assert.equal(nbs.find((n) => n.id === ID.nbWork1).stack, 'Work');
  assert.equal(nbs.find((n) => n.id === ID.nbShared).stack, 'Shared stack');
  assert.equal(nbs.find((n) => n.id === ID.nbLoose).stack, null);
  assert.equal(nbs.find((n) => n.id === ID.nbLoose).name, 'Loose');
});

test('stacks() counts notebooks per stack', () => {
  assert.deepEqual(a.stacks(), [{ name: 'Shared stack', notebookCount: 1 }, { name: 'Work', notebookCount: 2 }]);
});

test('tags keep their parent', () => {
  assert.deepEqual(a.tags(), [{ id: ID.tagAlpha, name: 'alpha', parentId: null }, { id: ID.tagBeta, name: 'beta', parentId: ID.tagAlpha }]);
});

test('noteTags yields the active links', () => {
  assert.deepEqual(noteTags.map((t) => t.tagId).sort(), [ID.tagAlpha, ID.tagBeta].sort());
});

test('a Space note has notebookId null and is counted', () => {
  const n = byId(notes, ID.nSpace);
  assert.equal(n.notebookId, null);
  assert.equal(n.workspaceId, 'ws-1');
  assert.equal(a.counts().notesWithoutNotebook, 1);
});

test("missing and empty plain text give '' and are counted", () => {
  assert.equal(byId(notes, ID.nSpace).plainText, '');
  assert.equal(byId(notes, ID.nEmptyText).plainText, '');
  assert.equal(a.counts().emptyPlainText, 2);
});
