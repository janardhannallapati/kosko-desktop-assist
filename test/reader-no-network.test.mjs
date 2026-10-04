// Rule 12 of 456-local-db-reader and rule 1 of 457-dry-run-manifest: the reader and the dry run have no network
// code. "Does not send" is a negative claim, so it is proven by scanning the source, and the list of files is the
// directory listing, so a new module cannot slip past. (src/mcp/ is the one place allowed to talk to a network.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIRS = ['../src/reader/', '../src/plan/'].map((d) => new URL(d, import.meta.url));
const FORBIDDEN = [
  /\bfrom\s+['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\bimport\(\s*['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\brequire\(\s*['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/
];

test('no reader or plan module imports a network module or calls fetch', () => {
  const files = DIRS.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')).map((f) => new URL(f, dir)));
  assert.ok(files.length >= 8, `expected the reader's and the plan's modules, found ${files.length}`);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) assert.doesNotMatch(src, re, `${f.pathname} matches ${re}`);
  }
});

test('the scan would catch a violation', () => {
  for (const line of ["import http from 'node:http';", "const r = await fetch('https://x');", "import('net')"]) {
    assert.ok(FORBIDDEN.some((re) => re.test(line)), line);
  }
});
