import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { snapshotDb, EvernoteBusyError } from '../src/reader/snapshot.mjs';
import { openAccount } from '../src/reader/reader.mjs';
import { SchemaMismatchError } from '../src/reader/schema.mjs';
import { buildSyntheticAccount } from './fixtures/synthetic-db.mjs';

function fingerprintTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${p} ${s.size} ${s.mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out;
}
const scratch = () => mkdtempSync(join(tmpdir(), 'kosko-snapshot-test-'));
const kids = (d) => readdirSync(d);

test('the source folder is byte-identical after openAccount + reading everything + close', async () => {
  const acct = buildSyntheticAccount();
  const before = fingerprintTree(acct.dataDir);
  const a = await openAccount(acct, { tmpRoot: scratch() });
  a.counts(); [...a.notes()]; [...a.attachments()]; [...a.ocr()]; [...a.noteTags()]; a.notebooks(); a.tags();
  a.close();
  assert.deepEqual(fingerprintTree(acct.dataDir), before);
});

test('snapshot dir is 0700 and holds an intact copy', async () => {
  const { dbPath } = buildSyntheticAccount();
  const snap = await snapshotDb(dbPath, { tmpRoot: scratch() });
  if (process.platform !== 'win32') assert.equal(statSync(snap.dir).mode & 0o777, 0o700);
  const db = new DatabaseSync(snap.path, { readOnly: true });
  assert.equal(db.prepare('select count(*) n from Nodes_Note').get().n, 5);
  db.close();
  snap.cleanup();
});

test('close() deletes the snapshot dir', async () => {
  const root = scratch();
  const a = await openAccount(buildSyntheticAccount(), { tmpRoot: root });
  assert.equal(kids(root).length, 1);
  assert.ok(existsSync(a.meta.snapshotPath));
  a.close();
  assert.deepEqual(kids(root), []);
});

test('a failed open (schema mismatch) deletes the snapshot too', async () => {
  const root = scratch();
  const acct = buildSyntheticAccount({ mutate: (d) => d.exec('DROP TABLE NoteTag') });
  await assert.rejects(openAccount(acct, { tmpRoot: root }), SchemaMismatchError);
  assert.deepEqual(kids(root), []);
});

test('a snapshot that fails integrity_check refuses and is deleted', async () => {
  const root = scratch();
  const { dbPath } = buildSyntheticAccount();
  await assert.rejects(snapshotDb(dbPath, { tmpRoot: root, integrityCheck: () => 'row 3 missing from index' }), /integrity_check/);
  assert.deepEqual(kids(root), []);
});

test('an exclusive lock on the source refuses with the close-Evernote message', async () => {
  const root = scratch();
  const { dbPath } = buildSyntheticAccount();
  const writer = new DatabaseSync(dbPath);
  writer.exec('BEGIN EXCLUSIVE');
  try {
    await assert.rejects(snapshotDb(dbPath, { tmpRoot: root, busyTimeoutMs: 50 }), (e) => e instanceof EvernoteBusyError
      && e.message === 'Evernote is writing to its database. Close Evernote and try again.');
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
  assert.deepEqual(kids(root), []);
});

test('a -journal file next to the source refuses before copying', async () => {
  const root = scratch();
  const { dbPath } = buildSyntheticAccount();
  writeFileSync(`${dbPath}-journal`, 'hot');
  await assert.rejects(snapshotDb(dbPath, { tmpRoot: root }), EvernoteBusyError);
  assert.deepEqual(kids(root), []);
  assert.ok(existsSync(dirname(dbPath)));
});

// Rule 2's other exits: a process that ends without close(), and one stopped by Ctrl-C, leave no snapshot behind.
for (const [how, tail] of [['exit without close()', 'process.exit(0);'], ['SIGINT', "process.kill(process.pid, 'SIGINT'); await new Promise((r) => setTimeout(r, 5000));"]]) {
  test(`the snapshot is deleted on ${how}`, async () => {
    const root = scratch();
    const { dbPath, resourceCacheDir } = buildSyntheticAccount();
    const script = `import { openAccount } from ${JSON.stringify(new URL('../src/reader/reader.mjs', import.meta.url).href)};
      const a = await openAccount(${JSON.stringify({ dbPath, resourceCacheDir })}, { tmpRoot: ${JSON.stringify(root)} });
      process.stdout.write(a.meta.snapshotPath); ${tail}`;
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.match(r.stdout, /kosko-assist-/, r.stderr);
    if (how === 'SIGINT') assert.equal(r.signal, 'SIGINT');
    assert.deepEqual(kids(root), []);
  });
}
