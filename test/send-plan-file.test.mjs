// 467 rules 1-2: only a checked plan is sent, the database is counted again first, and the job's expected counts are
// the plan's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlan, countDifferences, expectedOf } from '../src/send/library/plan-file.mjs';

const COUNTS = { notes: 4, trashedNotes: 1, notesWithoutNotebook: 1, notebooks: 4, stacks: 2, tags: 2, noteTags: 2, noteTagsAll: 3, attachments: 5, attachmentBytes: 26, ocr: 3 };
const plan = (x = {}) => ({ format: 'kosko-plan', version: 1, counts: COUNTS, check: { passed: true, differences: [] }, problems: { missingFiles: [{}], sizeMismatch: [], invalidIds: [], ocrErrors: [] }, ...x });
const write = (obj) => {
  const p = join(mkdtempSync(join(tmpdir(), 'kda-plan-')), 'kosko-plan.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

test('a plan that is not a checked kosko-plan v1 is refused, with a sentence', () => {
  for (const [bad, re] of [[plan({ format: 'x' }), /not a Kosko plan/], [plan({ version: 2 }), /version/], [plan({ check: { passed: false, differences: ['x'] } }), /did not pass/], ['{bad', /not a Kosko plan/]]) {
    assert.throws(() => loadPlan(write(bad)), re);
  }
  assert.throws(() => loadPlan('/no/such/kosko-plan.json'), /can.t be read/);
});

test('benign: a checked plan loads', () => {
  assert.equal(loadPlan(write(plan())).counts.notes, 4);
});

test('the database is compared on every count the receipt checks, and nothing else', () => {
  assert.deepEqual(countDifferences(COUNTS, { ...COUNTS, attachmentBytes: 1, ocrAll: 9, ocrStoredBytes: 1 }), []);
  assert.deepEqual(countDifferences(COUNTS, { ...COUNTS, ocr: 99 }), ['ocr: the plan has 3, Evernote now has 99']); // 504
  assert.deepEqual(countDifferences(COUNTS, { ...COUNTS, notes: 5, trashedNotes: 0 }),
    ['notes: the plan has 4, Evernote now has 5', 'trashedNotes: the plan has 1, Evernote now has 0']);
  for (const k of ['notebooks', 'stacks', 'tags', 'noteTags', 'attachments']) {
    assert.equal(countDifferences(COUNTS, { ...COUNTS, [k]: COUNTS[k] + 1 }).length, 1, k);
  }
});

test('expected counts: the nine the job and the receipt carry, missing files from the plan\'s problems, ocr from the plan\'s tally', () => {
  assert.deepEqual(expectedOf(plan()), { notes: 4, attachments: 5, notebooks: 4, stacks: 2, tags: 2, noteTags: 2, trashedNotes: 1, missingFiles: 1, ocr: 3 });
});
