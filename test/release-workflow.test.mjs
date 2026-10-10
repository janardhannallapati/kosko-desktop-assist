// Kosko 538 rules 6, 8 and 9: the SEA config, the release workflow's trigger, tag check, pinning and permissions, and
// the README's Download section. Read as text: the repo has no YAML parser, and these are shapes, not behaviour (the
// behaviour is test/sea/, which the workflow runs on each runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILD_NODE, checkBuildNode, exeName, seaConfig, SEA_FUSE } from '../scripts/build-sea.mjs';

const WF = readFileSync(new URL('../.github/workflows/release-binaries.yml', import.meta.url), 'utf8');
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const BUILD = readFileSync(new URL('../scripts/build-sea.mjs', import.meta.url), 'utf8');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('the SEA config turns the warning off and leaves code cache and snapshot off', () => {
  assert.deepEqual(seaConfig('m.cjs', 'b.blob'), { main: 'm.cjs', output: 'b.blob', disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false });
  assert.equal(SEA_FUSE, 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'); // Node 22's documented sentinel
  // macOS: the shipped signature off before the injection, an ad-hoc one (no identity) after it, the NODE_SEA segment.
  assert.match(BUILD, /'codesign', \['--remove-signature', exe\]/);
  assert.match(BUILD, /'codesign', \['--sign', '-', exe\]/);
  assert.match(BUILD, /machoSegmentName: 'NODE_SEA'/);
});

test('each platform has the file name the workflow and the README use', () => {
  const names = [exeName('win32', 'x64'), exeName('darwin', 'arm64'), exeName('darwin', 'x64')];
  assert.deepEqual(names, ['kosko-assist-windows-x64.exe', 'kosko-assist-macos-arm64', 'kosko-assist-macos-x64']);
  for (const n of names) {
    assert.ok(WF.includes(`exe: ${n}`), `workflow builds ${n}`);
    assert.ok(README.includes(`\`${n}\``), `README names ${n}`);
  }
  assert.throws(() => exeName('aix', 'ppc64'), /no single-executable build/);
});

test('the workflow runs on a pushed v* tag and on nothing else', () => {
  assert.match(WF, /\non:\n {2}push:\n {4}tags: \['v\*'\]\n\n/);
  assert.doesNotMatch(code(WF), /pull_request|workflow_dispatch|schedule:|branches:|repository_dispatch/);
});

test('the workflow refuses a tag that is not v + the package version', () => {
  assert.match(WF, /want="v\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
  assert.match(WF, /\[ "\$GITHUB_REF_NAME" = "\$want" \] \|\| \{ echo "tag \$GITHUB_REF_NAME does not match \$want"; exit 1; \}/);
});

test('every action is pinned to a commit SHA', () => {
  const uses = [...WF.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 4, `found ${uses.length} uses`);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});

test('permissions: read by default, write only for the release job', () => {
  assert.match(WF, /\npermissions:\n {2}contents: read\n/);
  assert.equal(WF.match(/contents: write/g)?.length, 1);
  const release = WF.slice(WF.indexOf('\n  release:\n'));
  assert.match(release, /\n {4}needs: build\n/);
  assert.match(release, /\n {4}permissions:\n {6}contents: write/);
  assert.doesNotMatch(code(WF), /id-token|secrets\./);
});

test('every build is tested on its own runner before it is uploaded', () => {
  for (const r of ['windows-latest', 'macos-latest', 'macos-15-intel']) assert.ok(WF.includes(`runner: ${r}`), r);
  const build = WF.slice(WF.indexOf('\n  build:\n'), WF.indexOf('\n  release:\n'));
  assert.ok(build.indexOf('npm run test:sea') > 0 && build.indexOf('npm run test:sea') < build.indexOf('upload-artifact'));
});

test('the README tells how to download and open an unsigned build, and keeps npx', () => {
  const download = README.slice(README.indexOf('## Download'), README.indexOf('\n## ', README.indexOf('## Download') + 1));
  assert.ok(download.length > 200, 'a Download section');
  assert.match(download, /github\.com\/janardhannallapati\/kosko-desktop-assist\/releases/);
  // No promise that a file exists before a release is published (the workflow makes drafts).
  assert.match(download, /No release has been published yet|Once a release is published/);
  assert.doesNotMatch(download, /Each \[release\]\(/);
  assert.match(download, /\*\*More info\*\*, then \*\*Run anyway\*\*/);
  assert.match(download, /System Settings → Privacy & Security/);
  assert.match(download, /\*\*Open Anyway\*\*/);
  assert.match(download, /not signed/);
  assert.match(download, /Signed installers come before the public launch/);
  assert.match(README, /npx https:\/\/github\.com\/janardhannallapati\/kosko-desktop-assist\/archive\/refs\/heads\/main\.tar\.gz/);
});

test('the build runs on exactly the pinned Node, in CI and in the build script', () => {
  assert.equal(BUILD_NODE, '22.23.3');
  const pins = [...WF.matchAll(/node-version: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(pins, [BUILD_NODE]);
  assert.doesNotThrow(() => checkBuildNode(`v${BUILD_NODE}`));
  for (const other of ['v22.23.2', 'v22.24.0', 'v24.1.0']) assert.throws(() => checkBuildNode(other), /22\.23\.3/, other);
});

test('the workflow refuses a tag whose commit is not on main', () => {
  const build = WF.slice(WF.indexOf('\n  build:\n'), WF.indexOf('\n  release:\n'));
  assert.match(build, /fetch-depth: 0/);
  assert.match(build, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(build, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main \|\| \{ echo "[^"]*not on main[^"]*"; exit 1; \}/);
  // The check runs before anything is built.
  assert.ok(build.indexOf('merge-base --is-ancestor') < build.indexOf('npm ci'));
});

test('the release is a draft the owner publishes by hand', () => {
  const create = WF.slice(WF.indexOf('gh release create'));
  assert.match(create, /--draft/);
  assert.doesNotMatch(create, /--prerelease/);
});
