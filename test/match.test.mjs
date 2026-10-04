// The ENEX match probe (Kosko doc 462). A synthetic local account, with invented notes that share a creation second,
// against a hand-written export that reaches every outcome. No real account data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSyntheticAccount, ID } from './fixtures/synthetic-db.mjs';
import { openAccount } from '../src/reader/reader.mjs';
import { matchExports, renderMatch, decide, overlap, enmlText, enexFiles, PASS_RATE } from '../src/match/match.mjs';

const T0 = Date.UTC(2014, 2, 4, 10, 30, 15); // the fixture's own T0
const at = (s) => new Date(T0 + s * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20140304T103015Z
const BIN = new URL('../bin/kosko-assist.mjs', import.meta.url).pathname;

// Copies the fixture's active note under a new id, title, second and text: every other column keeps a valid value.
function addNote(db, { id, title, second, text }) {
  const cols = db.prepare('PRAGMA table_info("Nodes_Note")').all().map((c) => c.name);
  const row = db.prepare('SELECT * FROM Nodes_Note WHERE id = ?').get(ID.nActive);
  Object.assign(row, { id, label: title, created: T0 + second * 1000 });
  db.prepare(`INSERT INTO Nodes_Note (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
  db.prepare('INSERT INTO Offline_Search_Note_Content (id, content) VALUES (?, ?)').run(id, text);
}

function account() {
  return buildSyntheticAccount({
    mutate(db) {
      addNote(db, { id: 'twin-a', title: 'Twin A', second: 240, text: 'first twin' });
      addNote(db, { id: 'twin-b', title: 'Twin B', second: 240, text: 'second twin' });
      addNote(db, { id: 'same-1', title: 'Same', second: 300, text: 'apples oranges pears plums' });
      addNote(db, { id: 'same-2', title: 'Same', second: 300, text: 'bolts nuts screws washers' });
      addNote(db, { id: 'dup-1', title: 'Dup', second: 360, text: 'identical words here' });
      addNote(db, { id: 'dup-2', title: 'Dup', second: 360, text: 'identical words here' });
    }
  });
}

const note = (title, created, body = '') => `<note><title>${title}</title>${created ? `<created>${created}</created>` : ''}`
  + `<content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>${body}</div></en-note>]]></content></note>`;
const enex = (...notes) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n`
  + `<en-export export-date="20261004T120000Z" application="Evernote" version="10.0">${notes.join('')}</en-export>`;

function exportDir(...files) {
  const dir = mkdtempSync(join(tmpdir(), 'kosko-match-enex-'));
  files.forEach((text, i) => writeFileSync(join(dir, `nb${i}.enex`), text));
  writeFileSync(join(dir, 'notes.txt'), 'not an export');
  return dir;
}

const EVERY_OUTCOME = enex(
  note('Active note', at(0), 'hello world'),               // single
  note('Empty text', at(60)),                               // single
  note('Twin B', at(240)),                                  // shared second, told by title
  note('Same', at(300), 'apples oranges pears plums'),      // shared second and title, told by text
  note('Dup', at(360), 'identical words here'),             // not told apart
  note('Nowhere', at(999)),                                 // miss
  note('No date', null),                                    // no <created>
  note('Active note again', at(0))                          // claims nActive a second time
);

async function runOn(files) {
  const acct = await openAccount(account());
  try { return await matchExports(acct, files); } finally { acct.close(); }
}

test('every outcome is counted, and every note that did not match is named', async () => {
  const r = await runOn(enexFiles([exportDir(EVERY_OUTCOME)]));
  assert.deepEqual(r.counts, { enexNotes: 8, single: 3, title: 1, text: 1, unresolved: 1, miss: 1, noCreated: 1, claimedTwice: 1 });
  assert.equal(r.localNotes, 10);
  assert.equal(r.matched, 4); // 3 + 1 + 1, less the double claim
  assert.equal(r.pass, false);
  assert.deepEqual(r.named.miss.map((n) => n.title), ['Nowhere']);
  assert.deepEqual(r.named.unresolved.map((n) => n.title), ['Dup']);
  assert.deepEqual(r.named.noCreated.map((n) => n.title), ['No date']);
  assert.deepEqual(r.named.claimedTwice.map((n) => [n.title, n.alsoClaimedBy]), [['Active note again', 'Active note']]);
});

test('a clean export passes, and the report holds counts and titles only, never note text', async () => {
  const r = await runOn(enexFiles([exportDir(enex(note('Active note', at(0), 'hello world')), enex(note('Twin A', at(240), 'first twin')))]));
  assert.equal(r.matched, 2);
  assert.equal(r.rate, 1);
  assert.equal(r.pass, true);
  const json = JSON.stringify(r);
  for (const text of ['hello world', 'first twin', 'apples', 'identical words']) assert.ok(!json.includes(text), text);
  assert.match(renderMatch(r), /PASS/);
});

test('the pass bar is 99%: 99 of 100 passes, 98 of 100 does not', async () => {
  assert.equal(PASS_RATE, 0.99);
  // A fake account with 100 local notes, one per second, so each export note can claim its own.
  const fake = { notes: function* () { for (let i = 0; i < 100; i += 1) yield { id: `l${i}`, title: `n${i}`, created: T0 + i * 1000, plainText: '' }; } };
  const mk = (good) => exportDir(enex(...Array.from({ length: 100 }, (_, i) => note(`n${i}`, i < good ? at(i) : at(9000 + i)))));
  assert.equal((await matchExports(fake, enexFiles([mk(99)]))).pass, true);
  assert.equal((await matchExports(fake, enexFiles([mk(98)]))).pass, false);
});

test('an export that cannot be read fully never passes', async () => {
  const r = await runOn(enexFiles([exportDir(`${enex(note('Active note', at(0)))}`.replace('</en-export>', '<note><title>cut'))]));
  assert.equal(r.fileErrors.length, 1);
  assert.equal(r.pass, false);
});

test('decide: title first, then a clear text lead, else unresolved', () => {
  const c = [{ id: 'a', title: 'X', plainText: 'red green blue' }, { id: 'b', title: 'Y', plainText: 'red green blue' }];
  assert.deepEqual(decide({ title: 'y', text: '' }, c), { outcome: 'title', localId: 'b' });
  assert.deepEqual(decide({ title: 'Z', text: 'red green blue' }, c), { outcome: 'unresolved' });
  const d = [{ id: 'a', title: 'X', plainText: 'red green blue' }, { id: 'b', title: 'X', plainText: 'cats dogs' }];
  assert.deepEqual(decide({ title: 'X', text: 'red green blue' }, d), { outcome: 'text', localId: 'a' });
  assert.deepEqual(decide({ title: 'X', text: 'nothing alike' }, d), { outcome: 'unresolved' });
  assert.deepEqual(decide({ title: 'X', text: '' }, []), { outcome: 'miss' });
});

test('the summary never prints a control character from a title or file name', () => {
  const evil = '\u001b[2K\rPASS\u001b]0;owned\u0007';
  const report = { files: ['x.enex'], localNotes: 1, matched: 0, passBar: 0.99, pass: false, fileErrors: [{ file: `bad${evil}.enex`, error: 'malformed-xml' }],
    counts: { enexNotes: 1, single: 0, title: 0, text: 0, unresolved: 0, miss: 1, noCreated: 0, claimedTwice: 0 },
    named: { unresolved: [], noCreated: [], claimedTwice: [], miss: [{ file: 'x.enex', title: `Lost ${evil}`, created: '20140304T103015Z' }] } };
  const out = renderMatch(report);
  assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/); // newlines between lines are ours
  assert.match(out, /Lost \uFFFD\[2K\uFFFDPASS/);
});

test('overlap and enmlText', () => {
  assert.equal(overlap('a b c', 'a b c'), 1);
  assert.equal(overlap('', 'a'), 0);
  assert.equal(enmlText('<div>R&amp;D &lt;2&gt; &#233;&#x1F600;</div>').trim(), 'R&D <2> é😀');
});

test('the CLI prints the summary, writes the report 0600 and exits 1 below the bar', () => {
  const acct = account();
  const out = mkdtempSync(join(tmpdir(), 'kosko-match-out-'));
  const r = spawnSync(process.execPath, [BIN, 'match', exportDir(EVERY_OUTCOME), '--data-dir', acct.dataDir, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /FAIL/);
  assert.match(r.stdout, /Nowhere/);
  const file = join(out, 'kosko-match-report.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).format, 'kosko-match-report');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('the CLI refuses a call with no export paths', () => {
  const r = spawnSync(process.execPath, [BIN, 'match'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
