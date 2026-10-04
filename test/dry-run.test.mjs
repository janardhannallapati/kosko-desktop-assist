import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDryRun } from '../src/plan/dry-run.mjs';
import { renameSync as renameSyncReal } from 'node:fs';
import { openAccount } from '../src/reader/reader.mjs';
import { SchemaMismatchError } from '../src/reader/schema.mjs';
import { buildSyntheticAccount, ID, EXPECTED_COUNTS, USER_ID, HOST_DIR } from './fixtures/synthetic-db.mjs';

const scratch = (p = 'kosko-dry-test-') => mkdtempSync(join(tmpdir(), p));
const quiet = () => {};
const BIN = new URL('../bin/kosko-assist.mjs', import.meta.url).pathname;

async function run(extra = {}) {
  const acct = buildSyntheticAccount();
  const outDir = join(scratch(), 'out');
  const tmpRoot = scratch('kosko-dry-snap-');
  const result = await runDryRun({ dataDir: acct.dataDir, outDir, tmpRoot, log: quiet, ...extra });
  return { acct, outDir, tmpRoot, result };
}
const readPlan = (outDir) => JSON.parse(readFileSync(join(outDir, 'kosko-plan.json'), 'utf8'));

// A reader that yields one note fewer (or a byte less) than its counts() say.
function lyingOpen(tweak) {
  return async (account, opts) => {
    const real = await openAccount(account, opts);
    return tweak(real);
  };
}

test('the synthetic account passes the check and the plan holds every section', async () => {
  const { outDir, result } = await run();
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  const plan = readPlan(outDir);
  assert.equal(plan.format, 'kosko-plan');
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.source, { userId: USER_ID, host: HOST_DIR, majorVersion: 3, migrationVersion: 139 });
  assert.deepEqual(plan.counts, EXPECTED_COUNTS);
  assert.equal(plan.notes.length, 4);
  assert.equal(plan.attachments.length, 5);
  assert.equal(plan.ocr.length, 2);
  assert.equal(plan.noteTags.length, 2);
  assert.equal(plan.notebooks.length, 4);
  assert.equal(plan.stacks.length, 2);
  assert.equal(plan.tags.length, 2);
  assert.deepEqual(plan.check, { passed: true, differences: [] });
  assert.equal(plan.notes.find((n) => n.id === ID.nActive).plainText, 'hello world');
});

test('no absolute path or file bytes are written into the plan', async () => {
  const { acct, outDir } = await run();
  const raw = readFileSync(join(outDir, 'kosko-plan.json'), 'utf8');
  assert.ok(!raw.includes(acct.root), 'plan mentions a local path');
  assert.ok(!('path' in readPlan(outDir).attachments[0]));
});

test('plan says sent:false and the summary ends by saying nothing was sent', async () => {
  const { outDir, result } = await run();
  assert.equal(readPlan(outDir).sent, false);
  const lines = result.summaryText.trim().split('\n');
  assert.match(lines.at(-2), /^Nothing was sent\./);
  assert.equal(readFileSync(join(outDir, 'kosko-plan-summary.txt'), 'utf8'), result.summaryText);
});

test("an --out inside Evernote's folder is refused and nothing is written", async () => {
  const acct = buildSyntheticAccount();
  const before = readdirSync(acct.dataDir).sort();
  await assert.rejects(runDryRun({ dataDir: acct.dataDir, outDir: join(acct.dataDir, 'plans'), log: quiet }),
    /inside Evernote's data folder/);
  assert.deepEqual(readdirSync(acct.dataDir).sort(), before);
});

test('a missing --out folder is created', async () => {
  const { outDir } = await run();
  assert.ok(existsSync(join(outDir, 'kosko-plan.json')));
});

test('plan and summary are 0600', { skip: process.platform === 'win32' }, async () => {
  const { outDir } = await run();
  assert.equal(statSync(join(outDir, 'kosko-plan.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(outDir, 'kosko-plan-summary.txt')).mode & 0o777, 0o600);
});

test('a reader that writes one note fewer than it counts fails with exit 1, naming the difference', async () => {
  const open = lyingOpen((r) => ({ ...r, *notes() { let i = 0; for (const n of r.notes()) if (i++ > 0) yield n; } }));
  const { outDir, result } = await run({ open });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.differences.includes('notes: wrote 3, database has 4'), result.differences.join('; '));
  assert.ok(!existsSync(join(outDir, 'kosko-plan.json')));
  assert.ok(!existsSync(join(outDir, 'kosko-plan.json.partial')));
  assert.match(result.summaryText, /COUNT CHECK FAILED/);
  assert.match(result.summaryText, /notes: wrote 3, database has 4/);
});

test('attachmentBytes is checked', async () => {
  const open = lyingOpen((r) => ({ ...r, *attachments() { for (const a of r.attachments()) yield { ...a, size: a.size + 1 }; } }));
  const { result } = await run({ open });
  assert.ok(result.differences.some((d) => d.startsWith('attachmentBytes: wrote')), result.differences.join('; '));
});

test('a failed check leaves the earlier plan untouched; a passing run replaces it', async () => {
  const acct = buildSyntheticAccount();
  const outDir = scratch();
  writeFileSync(join(outDir, 'kosko-plan.json'), 'EARLIER');
  const open = lyingOpen((r) => ({ ...r, *ocr() {} }));
  const bad = await runDryRun({ dataDir: acct.dataDir, outDir, open, log: quiet });
  assert.equal(bad.ok, false);
  assert.equal(readFileSync(join(outDir, 'kosko-plan.json'), 'utf8'), 'EARLIER');
  assert.match(bad.summaryText, /earlier kosko-plan\.json is still in this folder/);
  assert.ok(!existsSync(join(outDir, 'kosko-plan.json.partial')));
  const good = await runDryRun({ dataDir: acct.dataDir, outDir, log: quiet });
  assert.equal(good.ok, true);
  assert.equal(readPlan(outDir).format, 'kosko-plan');
});

test('an altered schema stops before any file exists in --out', async () => {
  const acct = buildSyntheticAccount({ mutate: (d) => d.exec('ALTER TABLE Attachment DROP COLUMN dataSize') });
  const outDir = join(scratch(), 'out');
  await assert.rejects(runDryRun({ dataDir: acct.dataDir, outDir, log: quiet }), SchemaMismatchError);
  assert.ok(!existsSync(outDir));
  const r = spawnSync(process.execPath, [BIN, 'dry-run', '--data-dir', acct.dataDir, '--out', outDir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Attachment\.dataSize/);
  assert.ok(!existsSync(outDir));
});

test('missing and wrong-size files are named by note title and file name; invalid ids and OCR errors listed', async () => {
  const { outDir, result } = await run();
  const p = readPlan(outDir).problems;
  assert.deepEqual(p.missingFiles, [{ noteId: ID.nActive, noteTitle: 'Active note', filename: 'lost.pdf', size: 7 }]);
  assert.deepEqual(p.sizeMismatch, [{ noteId: ID.nActive, noteTitle: 'Active note', filename: 'file.png', size: 9, actualSize: 4 }]);
  assert.deepEqual(p.invalidIds.map((x) => x.attachmentId).sort(), [ID.aBadHash, ID.aOnBadIdNote].sort());
  assert.equal(p.ocrErrors.length, 1);
  assert.equal(p.ocrErrors[0].attachmentId, ID.aWrongSize);
  assert.match(result.summaryText, /1 missing/);
});

test('--account picks that account; an unknown one is refused naming the ids found', async () => {
  const acct = buildSyntheticAccount();
  const host = join(acct.dataDir, 'conduit-storage', HOST_DIR);
  const small = buildSyntheticAccount();
  // A second, smaller account: copy only the DB file under another user id.
  writeFileSync(join(host, 'UDB-User5+RemoteGraph.sql'), readFileSync(small.dbPath));
  mkdirSync(join(acct.dataDir, 'resource-cache', 'User5'), { recursive: true });
  const outDir = scratch();
  const picked = await runDryRun({ dataDir: acct.dataDir, accountId: '5', outDir, log: quiet });
  assert.equal(readPlan(outDir).source.userId, '5');
  assert.equal(picked.ok, true);
  await assert.rejects(runDryRun({ dataDir: acct.dataDir, accountId: '42', outDir, log: quiet }), /no account User42.*User1001.*User5|User5.*User1001/);
});

test('no --account takes the largest and the summary names the others', async () => {
  const acct = buildSyntheticAccount();
  writeFileSync(join(acct.dataDir, 'conduit-storage', HOST_DIR, 'UDB-User5+RemoteGraph.sql'), 'tiny');
  const outDir = scratch();
  const r = await runDryRun({ dataDir: acct.dataDir, outDir, log: quiet });
  assert.equal(readPlan(outDir).source.userId, USER_ID);
  assert.match(r.summaryText, /Other accounts here: User5 .*--account 5/);
});

test('the snapshot folder is empty after a passing and after a failing run', async () => {
  const ok = await run();
  assert.deepEqual(readdirSync(ok.tmpRoot), []);
  const bad = await run({ open: lyingOpen((r) => ({ ...r, *notes() {} })) });
  assert.equal(bad.result.ok, false);
  assert.deepEqual(readdirSync(bad.tmpRoot), []);
});

test('the CLI prints the summary and exits 0', () => {
  const acct = buildSyntheticAccount();
  const outDir = join(scratch(), 'out');
  const out = execFileSync(process.execPath, [BIN, 'dry-run', '--data-dir', acct.dataDir, '--out', outDir], { encoding: 'utf8' });
  assert.match(out, /Count check: passed/);
  assert.match(out, /Nothing was sent\./);
});

test("the CLI does not print node:sqlite's experimental warning", () => {
  const acct = buildSyntheticAccount();
  const r = spawnSync(process.execPath, [BIN, 'dry-run', '--data-dir', acct.dataDir, '--out', join(scratch(), 'o')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});

test('a stale .partial and an earlier summary left at 0644 still end up 0600', { skip: process.platform === 'win32' }, async () => {
  const acct = buildSyntheticAccount();
  const outDir = scratch();
  writeFileSync(join(outDir, 'kosko-plan.json.partial'), 'crashed run', { mode: 0o644 });
  writeFileSync(join(outDir, 'kosko-plan-summary.txt'), 'earlier', { mode: 0o644 });
  await runDryRun({ dataDir: acct.dataDir, outDir, log: quiet });
  assert.equal(statSync(join(outDir, 'kosko-plan.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(outDir, 'kosko-plan-summary.txt')).mode & 0o777, 0o600);
});

test("a symlink into Evernote's folder does not get past the --out check", { skip: process.platform === 'win32' }, async () => {
  const acct = buildSyntheticAccount();
  const link = join(scratch(), 'innocent-looking');
  symlinkSync(acct.dataDir, link);
  await assert.rejects(runDryRun({ dataDir: acct.dataDir, outDir: join(link, 'plans'), log: quiet }), /inside Evernote's data folder/);
  assert.ok(!existsSync(join(acct.dataDir, 'plans')));
});

test('on Windows, a plan outside the user folder carries a privacy warning; inside it does not', async () => {
  const outside = await run({ platform: 'win32', home: join(tmpdir(), 'no-such-home') });
  assert.match(outside.result.summaryText, /WARNING: this folder is outside your user folder/);
  const inside = await run({ platform: 'win32', home: tmpdir() });
  assert.doesNotMatch(inside.result.summaryText, /WARNING/);
  assert.match(inside.result.summaryText, /readable only by you/);
});

test('a plan file held open elsewhere is retried, and a finished plan is kept when it cannot be replaced', async () => {
  let calls = 0;
  const flaky = (from, to) => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return renameSyncReal(from, to); };
  const ok = await run({ rename: flaky });
  assert.equal(ok.result.ok, true);
  assert.equal(calls, 3);
  const stuck = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  const acct = buildSyntheticAccount();
  const outDir = scratch();
  await assert.rejects(runDryRun({ dataDir: acct.dataDir, outDir, log: quiet, rename: stuck }), /complete and checked.*could not be replaced.*EBUSY/);
  assert.ok(existsSync(join(outDir, 'kosko-plan.json.partial')), 'the finished plan was thrown away');
});

test('a process that dies mid-write leaves no half-written plan behind', () => {
  const acct = buildSyntheticAccount();
  const outDir = scratch();
  const script = `
    import { runDryRun } from ${JSON.stringify(new URL('../src/plan/dry-run.mjs', import.meta.url).href)};
    import { openAccount } from ${JSON.stringify(new URL('../src/reader/reader.mjs', import.meta.url).href)};
    const open = async (a, o) => { const r = await openAccount(a, o); return { ...r, *notes() { for (const n of r.notes()) { yield n; process.exit(3); } } }; };
    await runDryRun({ dataDir: ${JSON.stringify(acct.dataDir)}, outDir: ${JSON.stringify(outDir)}, open, log: () => {} });`;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(readdirSync(outDir), []);
});
