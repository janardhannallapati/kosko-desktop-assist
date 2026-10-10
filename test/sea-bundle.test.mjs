// Kosko 538 rules 1–5: the CLI bundled into one CommonJS file (what the single executable embeds) is complete, holds one
// ProseMirror, and behaves exactly as the source does on the same input. The bundle is built once, as shipped
// (minified), into a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, rewriteJsdom, JSDOM_REWRITES, NO_SYNC_WORKER } from '../scripts/sea-bundle.mjs';
import { buildSyntheticAccount } from './fixtures/synthetic-db.mjs';
import { ENML_SAMPLES } from './sea-enml-samples.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'bin/kosko-assist.mjs');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const scratch = () => mkdtempSync(join(tmpdir(), 'kosko-sea-'));
const BUNDLE = join(scratch(), 'kosko-assist.cjs');
const meta = await bundle({ outfile: BUNDLE });
const bundleText = readFileSync(BUNDLE, 'utf8');

const run = (script, args, input) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input });
const both = (args, input) => [run(SOURCE, args, input), run(BUNDLE, args, input)];

test("the bundle leaves only Node built-ins and jsdom's optional canvas unresolved", () => {
  const unresolved = new Map();
  for (const [file, input] of Object.entries(meta.inputs)) {
    for (const i of input.imports) if (i.external && i.path !== '<runtime>') unresolved.set(i.path, file);
  }
  const notBuiltin = [...unresolved.keys()].filter((p) => !isBuiltin(p));
  assert.deepEqual(notBuiltin, ['canvas']);
  assert.match(unresolved.get('canvas'), /node_modules\/jsdom\/lib\/jsdom\/utils\.js$/);
  assert.ok(unresolved.has('node:sqlite'));
  // And the dependencies really are inside: the converter, Tiptap, jsdom.
  for (const dep of ['node_modules/@kosko-app/enex-core/', 'node_modules/@tiptap/core/', 'node_modules/jsdom/lib/']) {
    assert.ok(Object.keys(meta.inputs).some((f) => f.startsWith(dep)), dep);
  }
});

test('the bundle holds exactly one prosemirror-model', () => {
  const copies = new Set(Object.keys(meta.inputs)
    .map((f) => /^(.*node_modules\/prosemirror-model)\//.exec(f)?.[1]).filter(Boolean));
  assert.deepEqual([...copies], ['node_modules/prosemirror-model']);
});

test("the pinned jsdom's two lookups are rewritten", () => {
  const lib = join(ROOT, 'node_modules/jsdom/lib');
  const css = rewriteJsdom('jsdom/living/css/helpers/computed-style.js', readFileSync(join(lib, 'jsdom/living/css/helpers/computed-style.js'), 'utf8'));
  assert.doesNotMatch(css, /default-stylesheet\.css/);
  assert.ok(css.includes(JSON.stringify(readFileSync(join(lib, 'jsdom/browser/default-stylesheet.css'), 'utf8'))));
  const xhr = rewriteJsdom('jsdom/living/xhr/XMLHttpRequest-impl.js', readFileSync(join(lib, 'jsdom/living/xhr/XMLHttpRequest-impl.js'), 'utf8'));
  assert.doesNotMatch(xhr, /require\.resolve/);
  assert.ok(bundleText.includes(NO_SYNC_WORKER));
  assert.doesNotMatch(bundleText, /default-stylesheet\.css/);
});

test("the jsdom rewrite fails loudly when jsdom's source no longer matches", () => {
  for (const rel of Object.keys(JSDOM_REWRITES)) {
    assert.throws(() => rewriteJsdom(rel, 'module.exports = {};'), new RegExp(`jsdom changed: ${rel.replaceAll('.', '\\.')}`));
    const twice = `${JSDOM_REWRITES[rel].find};${JSDOM_REWRITES[rel].find}`;
    assert.throws(() => rewriteJsdom(rel, twice), /exactly once/);
  }
  assert.equal(rewriteJsdom('jsdom/living/nodes/Node-impl.js', 'unchanged'), 'unchanged'); // other files pass through
});

test('a module that reads import.meta fails the build instead of shipping', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'entry.mjs'), "import { createRequire } from 'node:module';\nconsole.log(createRequire(import.meta.url));\n");
  await assert.rejects(bundle({ entry: join(dir, 'entry.mjs'), outfile: join(dir, 'out.cjs') }), /import\.meta/);
});

test('--version prints the package version, from the source and from the bundle', () => {
  for (const r of both(['--version'])) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${VERSION}\n`);
  }
});

test('--help prints the usage on standard output and exits 0', () => {
  const [src, bun] = both(['--help']);
  assert.equal(src.status, 0);
  assert.match(src.stdout, /^Usage:\n {2}kosko-assist --version \| --help\n/);
  assert.deepEqual([bun.status, bun.stdout, bun.stderr], [src.status, src.stdout, src.stderr]);
});

test('accounts lists the synthetic account the same way', () => {
  const acct = buildSyntheticAccount();
  const [src, bun] = both(['accounts', '--data-dir', acct.dataDir]);
  assert.equal(src.status, 0);
  assert.match(src.stdout, /User1001 {2}/);
  assert.deepEqual([bun.status, bun.stdout, bun.stderr], [src.status, src.stdout, src.stderr]);
});

test('dry-run writes the same plan and summary as the source, with no experimental warning', () => {
  const acct = buildSyntheticAccount();
  const outs = [join(scratch(), 'src'), join(scratch(), 'bundle')];
  const [src, bun] = [run(SOURCE, ['dry-run', '--data-dir', acct.dataDir, '--out', outs[0]]),
    run(BUNDLE, ['dry-run', '--data-dir', acct.dataDir, '--out', outs[1]])];
  for (const r of [src, bun]) {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Count check: passed/);
    assert.equal(r.stderr, '');
  }
  const norm = (s, out) => s.replaceAll(out, '<out>').replace(/Took \d+ s/, 'Took N s');
  assert.equal(norm(bun.stdout, outs[1]), norm(src.stdout, outs[0]));
  const plan = (out) => readFileSync(join(out, 'kosko-plan.json'), 'utf8').replace(/"generatedAt": "[^"]+"/, '"generatedAt": "T"');
  assert.equal(plan(outs[1]), plan(outs[0]));
  assert.equal(JSON.parse(plan(outs[1])).tool.version, VERSION);
});

test('convert-enml gives byte-identical documents from the source and the bundle', () => {
  const fallbacks = [];
  for (const enml of ENML_SAMPLES) {
    const [src, bun] = both(['convert-enml'], enml);
    assert.equal(src.status, 0, src.stderr);
    fallbacks.push(JSON.parse(src.stdout).report.fallback);
    assert.deepEqual([bun.status, bun.stdout, bun.stderr], [src.status, src.stdout, src.stderr], enml.slice(0, 120));
  }
  // The samples reach both of the converter's paths: the schema parse, and the raw-HTML fallback for broken XML.
  assert.equal(fallbacks.filter((f) => f === 'malformed-xml').length, 1);
  assert.equal(fallbacks.filter((f) => f === null).length, ENML_SAMPLES.length - 1);
});

test('convert-enml with no input exits 2, from the source and the bundle', () => {
  for (const r of both(['convert-enml'], '')) {
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no ENML on standard input/);
  }
});
