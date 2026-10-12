// Kosko content-vault 605: this repo takes @kosko-app/design-tokens on terms it controls, and its design-system guard
// cannot be switched off quietly. Read as text where the thing is a shape (package.json, the workflow); run where it is
// behaviour (the check, on a planted violation in a throwaway copy of this repo's config).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const config = JSON.parse(read('kosko-ds.config.json'));
const WF = read('.github/workflows/test.yml');
const NAME = '@kosko-app/design-tokens';
const BIN = path.join(ROOT, 'node_modules', NAME, 'bin', 'kosko-ds-check.mjs');

test('the package is pinned exactly, as a dev dependency, with an integrity hash in the lockfile', () => {
  const spec = pkg.devDependencies[NAME];
  assert.match(spec, /^\d+\.\d+\.\d+$/, `pin ${NAME} exactly, not "${spec}"`);
  assert.equal(pkg.dependencies?.[NAME], undefined, 'build-time only: never shipped in the executable');
  const entry = lock.packages[`node_modules/${NAME}`];
  assert.equal(entry.version, spec);
  assert.match(entry.integrity, /^sha512-/);
});

test('npm test runs the check first, so a violation stops the suite', () => {
  assert.match(pkg.scripts.test, /^kosko-ds-check && /);
  assert.equal(pkg.scripts['ds:check'], 'kosko-ds-check');
});

test('the check reads all of src/ and bin/, exempts nothing, and has an empty baseline', () => {
  assert.deepEqual(config.channels.cli.dirs, ['src', 'bin']);
  assert.ok(config.channels.cli.extensions.includes('.mjs'));
  assert.equal(config.exempt, undefined);
  assert.deepEqual(JSON.parse(read(config.baseline)).counts, {});
});

test('CI runs npm test on every pull request and every push to main', () => {
  assert.match(WF, /\n"on":\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/);
  assert.match(WF, /- run: npm ci\n {6}- run: npm test\n/);
  for (const [, u] of WF.matchAll(/uses: (\S+)/g)) assert.match(u, /@[0-9a-f]{40}$/);
  assert.doesNotMatch(WF.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /secrets\.|continue-on-error|\|\| true/);
});

test('a planted raw hex in src/ fails the check, naming the file, the line and the token', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kda-ds-'));
  mkdirSync(path.join(dir, 'src')); mkdirSync(path.join(dir, 'bin'));
  copyFileSync(path.join(ROOT, 'kosko-ds.config.json'), path.join(dir, 'kosko-ds.config.json'));
  writeFileSync(path.join(dir, 'bin', 'cli.mjs'), 'export {};\n');
  writeFileSync(path.join(dir, 'src', 'page.mjs'), "export const ok = 1;\nexport const html = '<p style=\"color:#4338ca\">Signed in</p>';\n");
  const r = spawnSync(process.execPath, [BIN], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /src\/page\.mjs:2\s+raw-colour\s+#4338ca/);
  assert.match(r.stderr, /TOKENS\.app\.<theme>\['acc'\]/);
  writeFileSync(path.join(dir, 'src', 'page.mjs'), "export const html = '<p>Signed in</p>';\n");
  assert.equal(spawnSync(process.execPath, [BIN], { cwd: dir, encoding: 'utf8' }).status, 0);
});
