// Kosko 538 rule 7: the single executable built for THIS machine runs the CLI. `npm run test:sea` builds it into dist/
// first; the release workflow runs the same on each runner (Windows x64, macOS arm64, macOS x64), so every file
// attached to a release has passed these cases on its own platform. Not part of `npm test`: the build copies the
// ~120 MB node binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exeName } from '../../scripts/build-sea.mjs';
import { buildSyntheticAccount } from '../fixtures/synthetic-db.mjs';
import { ENML_SAMPLES } from '../sea-enml-samples.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXE = join(ROOT, 'dist', exeName());
const SOURCE = join(ROOT, 'bin/kosko-assist.mjs');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
assert.ok(existsSync(EXE), `${EXE} is missing: run npm run test:sea, which builds it first`);

const exe = (args, input) => spawnSync(EXE, args, { encoding: 'utf8', input });
const source = (args, input) => spawnSync(process.execPath, [SOURCE, ...args], { encoding: 'utf8', input });
const quiet = (r) => assert.doesNotMatch(r.stderr, /ExperimentalWarning|single executable/i);

test('the executable prints the package version', () => {
  const r = exe(['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), VERSION);
  quiet(r);
});

test('the executable prints the usage', () => {
  const r = exe(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kosko-assist dry-run --out <folder>/);
  quiet(r);
});

test('the executable lists the synthetic account', () => {
  const acct = buildSyntheticAccount();
  const r = exe(['accounts', '--data-dir', acct.dataDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /User1001 {2}/);
  quiet(r);
});

test('the executable dry-runs the synthetic account and writes the same plan as the source', () => {
  const acct = buildSyntheticAccount();
  const [a, b] = [join(mkdtempSync(join(tmpdir(), 'kosko-sea-')), 'exe'), join(mkdtempSync(join(tmpdir(), 'kosko-sea-')), 'src')];
  const r = exe(['dry-run', '--data-dir', acct.dataDir, '--out', a]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Count check: passed/);
  quiet(r);
  assert.equal(source(['dry-run', '--data-dir', acct.dataDir, '--out', b]).status, 0);
  const plan = (dir) => readFileSync(join(dir, 'kosko-plan.json'), 'utf8').replace(/"generatedAt": "[^"]+"/, '');
  assert.equal(plan(a), plan(b));
});

test('the executable converts every ENML sample byte-identically to the source', () => {
  for (const enml of ENML_SAMPLES) {
    const [r, s] = [exe(['convert-enml'], enml), source(['convert-enml'], enml)];
    assert.equal(r.status, 0, r.stderr);
    quiet(r);
    assert.equal(r.stdout, s.stdout, enml.slice(0, 120));
  }
});
