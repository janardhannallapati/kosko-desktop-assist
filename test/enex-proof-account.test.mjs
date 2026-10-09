// Kosko 519 — the ENEX proof account and its exports (test/fake-mcp/enex-proof-account.mjs) are what Kosko's ENEX proof
// expects, read back with enex-core's own reader: a fixture drift fails here first, in seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openAsBlob, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { readEnex, fingerprintNote, formatEnexDate } from '@kosko-app/enex-core/enex';
import { runDryRun } from '../src/plan/dry-run.mjs';
import { enexFile } from './fixtures/enex-writer.mjs';
import { buildEnexProofAccount, writeEnexExports, ENEX_ID, ENEX_EXPECTED, LATER_EDITED, TWIN_TITLE } from './fake-mcp/enex-proof-account.mjs';
import { PROOF_ID, PROOF_HASH } from './fake-mcp/proof-account.mjs';
import { ID } from './fixtures/synthetic-db.mjs';

async function read(file) {
  const notes = [];
  let end;
  for await (const r of readEnex(await openAsBlob(file))) {
    if (r.kind === 'note') notes.push(r);
    if (r.kind === 'end') end = r;
  }
  return { notes, end };
}
const hashesIn = (enml) => [...enml.matchAll(/<en-media hash="([0-9a-f]{32})"/g)].map((m) => m[1]);

async function exportsOf(acct, later) {
  const dir = mkdtempSync(join(tmpdir(), 'kda-enex-'));
  const files = writeEnexExports(acct, dir, { later });
  return Promise.all(files.map(async (f) => ({ file: f.file, ids: f.notes, ...(await read(f.file)) })));
}

test('the export holds every planned note, one file per notebook, each readable whole', async () => {
  const acct = buildEnexProofAccount();
  const outDir = mkdtempSync(join(tmpdir(), 'kda-enex-plan-'));
  await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const plan = JSON.parse(readFileSync(join(outDir, 'kosko-plan.json'), 'utf8'));
  const files = await exportsOf(acct, false);
  assert.equal(plan.notes.length, ENEX_EXPECTED.notes);
  assert.deepEqual(files.map((f) => basename(f.file)), ['Loose.enex', 'Personal.enex', 'Projects.enex', 'Receipts.enex']);
  assert.equal(files.length, ENEX_EXPECTED.files);
  assert.deepEqual(files.flatMap((f) => f.ids).sort(), plan.notes.map((n) => n.id).sort());
  for (const f of files) {
    assert.equal(f.end.error, undefined, f.file);
    assert.equal(f.notes.length, f.end.notes);
    assert.ok(f.notes.every((n) => Object.keys(n.problems).length === 0), JSON.stringify(f.notes.map((n) => n.problems)));
  }
  assert.ok(files.find((f) => basename(f.file) === 'Projects.enex').notes.some((n) => n.title === 'Split two'));
  assert.ok(files.find((f) => basename(f.file) === 'Receipts.enex').notes.some((n) => n.title === 'Split one'));
});

test('every <created> is the note\'s own second, and the same-second groups are there', async () => {
  const acct = buildEnexProofAccount();
  const outDir = mkdtempSync(join(tmpdir(), 'kda-enex-plan-'));
  await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot: mkdtempSync(join(tmpdir(), 'kda-snap-')), log: () => {} });
  const plan = JSON.parse(readFileSync(join(outDir, 'kosko-plan.json'), 'utf8'));
  const created = new Map(plan.notes.map((n) => [n.title, formatEnexDate(n.created)]));
  const notes = (await exportsOf(acct, false)).flatMap((f) => f.notes);
  for (const n of notes) if (n.title !== TWIN_TITLE) assert.equal(n.created, created.get(n.title), n.title);
  const bySecond = Map.groupBy(notes, (n) => n.created);
  const groups = [...bySecond.values()].filter((g) => g.length > 1).map((g) => g.map((n) => n.title).sort());
  assert.deepEqual(groups.sort(), [['Same second A', 'Same second B'], ['Split one', 'Split two'], [TWIN_TITLE, TWIN_TITLE]].sort());
});

test('every <en-media> names a resource of its note by the MD5 of its bytes; the scan Evernote holds is in it, lost.pdf is not', async () => {
  const acct = buildEnexProofAccount();
  const notes = (await exportsOf(acct, false)).flatMap((f) => f.notes);
  let media = 0;
  for (const n of notes) {
    const have = new Set(n.resources.map((r) => r.md5));
    for (const h of hashesIn(n.content)) { media += 1; assert.ok(have.has(h), `${n.title}: ${h}`); }
  }
  assert.equal(media, 1 + 2 + 2 + 1); // Active's receipt, two scans on the Space note, two pictures, the fetched scan
  const fetched = notes.find((n) => n.title === 'Fetched file');
  assert.deepEqual(fetched.resources.map((r) => r.md5), [PROOF_HASH.fetched]);
  const active = notes.find((n) => n.title === 'Active note');
  assert.equal(active.resources.length, 1); // lost.pdf and the wrong-size file are not in the export
  assert.deepEqual(active.tags, ['alpha', 'beta']);
});

test('links name their targets by GUID; the LATER export changes exactly three notes\' versions', async () => {
  const acct = buildEnexProofAccount();
  const first = (await exportsOf(acct, false)).flatMap((f) => f.notes);
  const later = (await exportsOf(acct, true)).flatMap((f) => f.notes);
  const sameA = first.find((n) => n.title === 'Same second A');
  assert.match(sameA.content, new RegExp(`evernote:///view/1001/s1/${ENEX_ID.nSplit2}/`));
  assert.match(first.find((n) => n.title === 'Links note').content, new RegExp(ID.nTrashed));
  const version = async (n) => (await fingerprintNote({ created: n.created, title: n.title, content: n.content, tags: n.tags, resources: n.resources })).version;
  const changed = [];
  for (let i = 0; i < first.length; i++) {
    assert.equal(later[i].title, first[i].title);
    if (await version(first[i]) !== await version(later[i])) changed.push(first[i].title);
  }
  assert.deepEqual(changed.sort(), ['Pictures note', 'Same second A', 'Table note']);
  assert.equal(LATER_EDITED.length, 3);
  assert.ok(LATER_EDITED.includes(PROOF_ID.nTable));
});

test('the writer escapes text and splits a CDATA end inside a body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kda-enex-w-'));
  const file = join(dir, 'x.enex');
  const enml = '<?xml version="1.0" encoding="UTF-8"?><en-note><div>a ]]> b</div></en-note>';
  (await import('node:fs')).writeFileSync(file, enexFile([{ title: 'A & <B> "c"', created: Date.UTC(2020, 0, 2, 3, 4, 5, 900), tags: ['x&y'], enml }]));
  const { notes, end } = await read(file);
  assert.equal(end.error, undefined);
  assert.equal(notes[0].title, 'A & <B> "c"');
  assert.equal(notes[0].created, '20200102T030405Z'); // whole seconds, floored
  assert.deepEqual(notes[0].tags, ['x&y']);
  assert.equal(notes[0].content, enml);
});
