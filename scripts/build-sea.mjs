#!/usr/bin/env node
// Kosko 538 rule 6: kosko-assist as a single executable for THIS machine's platform and architecture, by the steps in
// https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html. CI runs it once per runner
// (.github/workflows/release-binaries.yml); a cross-build is not attempted, because the blob must be made by the same
// node binary it is injected into.
//
//   node scripts/build-sea.mjs [--out dist]
//
// Writes <out>/kosko-assist.cjs (the bundle), <out>/sea-config.json, <out>/sea-prep.blob, and the executable
// <out>/kosko-assist-<windows|macos|linux>-<arch>[.exe] with a <name>.sha256 next to it. Unsigned: on macOS the
// signature node shipped with is removed before the injection and an AD-HOC one (`codesign --sign -`, no identity)
// added after it, which Apple silicon needs to run the file at all.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inject } from 'postject';
import { bundle } from './sea-bundle.mjs';

export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const OS_NAME = { win32: 'windows', darwin: 'macos', linux: 'linux' };

/** The executable's file name for a platform and architecture. */
export function exeName(platform = process.platform, arch = process.arch) {
  const os = OS_NAME[platform];
  if (!os) throw new Error(`no single-executable build for ${platform}`);
  return `kosko-assist-${os}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

/** sea-config.json (rule 6): no experimental-SEA warning; code cache and snapshot off (the CLI uses import()). */
export function seaConfig(main, output) {
  return { main, output, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false };
}

export async function buildSea({ out = 'dist', log = console.log } = {}) {
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  const main = join(dir, 'kosko-assist.cjs');
  const blob = join(dir, 'sea-prep.blob');
  const config = join(dir, 'sea-config.json');
  const exe = join(dir, exeName());

  await bundle({ outfile: main });
  writeFileSync(config, `${JSON.stringify(seaConfig(main, blob), null, 2)}\n`);
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  rmSync(exe, { force: true });
  copyFileSync(process.execPath, exe);
  chmodSync(exe, 0o755);
  const mac = process.platform === 'darwin';
  if (mac) execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
  // Windows: node.exe's Authenticode signature is left in place and stops matching; postject says so and goes on.
  // The file is unsigned either way, which is what SmartScreen's "Run anyway" is for (README, Download).
  await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: SEA_FUSE,
    ...(mac ? { machoSegmentName: 'NODE_SEA' } : {}),
    overwrite: true
  });
  if (mac) execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });

  const sha256 = createHash('sha256').update(readFileSync(exe)).digest('hex');
  writeFileSync(`${exe}.sha256`, `${sha256}  ${exeName()}\n`);
  log(`${exe}\n  ${(statSync(exe).size / 1e6).toFixed(1)} MB (bundle ${(statSync(main).size / 1e6).toFixed(1)} MB)  sha256 ${sha256}`);
  return { exe, main, sha256 };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'dist' } } });
  await buildSea({ out: values.out });
}
