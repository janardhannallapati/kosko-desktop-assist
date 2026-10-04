import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummary } from '../src/plan/summary.mjs';

const BASE = {
  account: { userId: '20989808', host: 'https%3A%2F%2Fwww.evernote.com', majorVersion: 3, migrationVersion: 139 },
  counts: { notes: 5532, trashedNotes: 3047, notesWithoutNotebook: 4, notebooks: 579, stacks: 63, tags: 2081,
    noteTags: 3832, noteTagsAll: 3914, attachments: 25696, attachmentBytes: 8258653652, ocr: 25327, ocrAll: 29725,
    emptyPlainText: 861, ocrStoredBytes: 89838908 },
  problems: { missingFiles: 52, sizeMismatch: 0, invalidIds: 0, ocrErrors: 0 },
  ocrTextBytes: 9_500_000,
  ocrWithWords: 21_614,
  check: { passed: true, differences: [] },
  planPath: 'C:\\Users\\u\\kosko-dry-run\\kosko-plan.json',
  planBytes: 123_400_000,
  otherAccounts: [{ userId: '317463525', dbBytes: 3_600_000 }],
  elapsedMs: 41_200
};

test('every required line is present, in order, within 24 lines', () => {
  const s = renderSummary(BASE);
  const lines = s.trimEnd().split('\n');
  assert.ok(lines.length <= 24, `${lines.length} lines`);
  const order = [/dry run/i, /User20989808/, /database v3 \(migration 139\)/, /Notes\s+5,532.*3,047 in Evernote's trash/,
    /Notebooks\s+579.*63 stacks/, /Tags\s+2,081.*3,832 note.tag links/, /Attachments\s+25,696.*8\.26 GB.*25,644 found.*52 missing/,
    /OCR\s+25,327/, /Plain text.*861 empty/, /4 notes are in a Space/, /Count check: passed/, /kosko-plan\.json/,
    /Other accounts here: User317463525/, /^Nothing was sent\./m, /Took 41 s/];
  let at = 0;
  for (const re of order) {
    const i = lines.findIndex((l, k) => k >= at && re.test(l));
    assert.ok(i >= 0, `missing or out of order: ${re}`);
    at = i;
  }
});

test('R4 line shows words bytes against stored bytes', () => {
  assert.match(renderSummary(BASE), /OCR\s+25,327\s+scanned for text, 21,614 with words; 9\.5 MB of words.*89\.8 MB stored/);
});

test('a failed check is impossible to miss and lists each difference', () => {
  const s = renderSummary({ ...BASE, check: { passed: false, differences: ['notes: wrote 5,531, database has 5,532'] }, planPath: null, planBytes: 0 });
  assert.match(s, /COUNT CHECK FAILED/);
  assert.match(s, /notes: wrote 5,531, database has 5,532/);
  assert.match(s, /No plan was saved/);
  assert.doesNotMatch(s, /Count check: passed/);
});

test('no Space line when every note is in a notebook, no other-accounts line when there is one account', () => {
  const s = renderSummary({ ...BASE, counts: { ...BASE.counts, notesWithoutNotebook: 0 }, otherAccounts: [] });
  assert.doesNotMatch(s, /Space/);
  assert.doesNotMatch(s, /Other accounts/);
});

test('one Space note reads as singular', () => {
  assert.match(renderSummary({ ...BASE, counts: { ...BASE.counts, notesWithoutNotebook: 1 } }), /1 note is in a Space/);
});

test('one stack reads as singular', () => {
  assert.match(renderSummary({ ...BASE, counts: { ...BASE.counts, stacks: 1 } }), /in 1 stack \(/);
});
