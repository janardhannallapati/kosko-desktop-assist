// Rule 12 of 456-local-db-reader: the reader has no network code. "Does not send" is a negative claim, so it is
// proven by scanning the source, and the list of files is the directory listing, so a new module cannot slip past.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../src/reader/', import.meta.url);
const FORBIDDEN = [
  /\bfrom\s+['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\bimport\(\s*['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\brequire\(\s*['"](node:)?(http|https|http2|net|dgram|tls|dns)['"]/,
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/
];

test('no reader module imports a network module or calls fetch', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
  assert.ok(files.length >= 5, `expected the reader's modules, found ${files.join(', ')}`);
  for (const f of files) {
    const src = readFileSync(new URL(f, DIR), 'utf8');
    for (const re of FORBIDDEN) assert.doesNotMatch(src, re, `${f} matches ${re}`);
  }
});

test('the scan would catch a violation', () => {
  for (const line of ["import http from 'node:http';", "const r = await fetch('https://x');", "import('net')"]) {
    assert.ok(FORBIDDEN.some((re) => re.test(line)), line);
  }
});
