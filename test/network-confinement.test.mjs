// 466 rule 10: network code lives only in src/send/ (Kosko) and src/mcp/ (Evernote). Every other module and the CLI
// entry are scanned, and the file list is the directory walk, so a new module cannot slip past unscanned.
// ("Does not send" is a negative claim, so it is proven by a scan — the shape of reader-no-network.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = ['src/send/', 'src/mcp/'];
const FORBIDDEN = [
  /\bfrom\s+['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\bimport\(\s*['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\brequire\(\s*['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(mjs|js)$/.test(f) ? [p] : [];
  });
}

test('no module outside src/send and src/mcp, and not the CLI entry, has network code', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'bin'))]
    .map((p) => relative(ROOT, p).split('\\').join('/'))
    .filter((p) => !ALLOWED.some((a) => p.startsWith(a)));
  assert.ok(files.length >= 10, `expected the reader, plan, match and CLI modules, found ${files.length}`);
  assert.ok(files.includes('bin/kosko-assist.mjs') && files.some((f) => f.startsWith('src/match/')));
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const re of FORBIDDEN) assert.doesNotMatch(src, re, `${f} matches ${re}`);
  }
});

test('the send client is where the network code is (the scan is not vacuous)', () => {
  assert.match(readFileSync(join(ROOT, 'src/send/api.mjs'), 'utf8'), /\bfetch\b/);
});

test('the scan catches a planted violation', () => {
  for (const line of ["import https from 'node:https';", 'await fetch(url)', "await import('node:net')"]) {
    assert.ok(FORBIDDEN.some((re) => re.test(line)), line);
  }
});
