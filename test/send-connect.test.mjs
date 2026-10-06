// 466 rules 1, 2 and 11: `kosko-assist connect` proves the import token over real HTTP and writes nothing; the token
// never appears in any output, and there is no --token flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/kosko-assist.mjs', import.meta.url));
const TOKEN = `cvit_${'c3'.repeat(32)}`;

async function server(handler) {
  const seen = [];
  const s = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const { status, json } = handler(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { app: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((r) => s.close(r)) };
}
function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', BIN, ...args], { env: { ...process.env, KOSKO_IMPORT_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('connect: a working token reads the allowance only, prints used and left, exits 0', async () => {
  const s = await server(() => ({ status: 200, json: { byteLimit: 2 * 1024 ** 3, bytesUsed: 512 * 1024 ** 2, maxFileBytes: 200 * 1024 ** 2 } }));
  try {
    const r = await run(['connect', '--app', s.app], { KOSKO_IMPORT_TOKEN: TOKEN });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(s.seen.map((x) => `${x.method} ${x.url}`), ['GET /api/import/allowance']);
    assert.equal(s.seen[0].auth, `Bearer ${TOKEN}`);
    assert.match(r.out, /Connected to http:\/\/127\.0\.0\.1:\d+/);
    assert.match(r.out, /512 MB of 2\.0 GB used, 1\.5 GB left/);
    assert.ok(!(r.out + r.err).includes(TOKEN.slice(5)));
  } finally { await s.close(); }
});

test('connect: a refused token says to make a new one and exits 1, without printing it', async () => {
  const s = await server(() => ({ status: 401, json: { error: `token ${TOKEN} revoked` } }));
  try {
    const r = await run(['connect', '--app', s.app], { KOSKO_IMPORT_TOKEN: TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.err, /not valid any more/);
    assert.ok(!(r.out + r.err).includes(TOKEN.slice(5)));
  } finally { await s.close(); }
});

test('there is no --token flag: refused with exit 2 before any request, the value not echoed', async () => {
  const r = await run(['connect', '--token', TOKEN, '--app', 'http://127.0.0.1:9']);
  assert.equal(r.code, 2);
  assert.match(r.err, /no --token option/);
  assert.ok(!(r.out + r.err).includes(TOKEN.slice(5)));
});

test('connect: localhost is refused with the 127.0.0.1 hint', async () => {
  const r = await run(['connect', '--app', 'http://localhost:3003'], { KOSKO_IMPORT_TOKEN: TOKEN });
  assert.equal(r.code, 1);
  assert.match(r.err, /127\.0\.0\.1/);
});

// 466 review M7/M8 — "Connected" only for a real allowance; a token anywhere on the command line is refused unechoed.
test('connect: a 2xx that is not an allowance is not "Connected"', async () => {
  const s = await server(() => ({ status: 200, json: {} }));
  try {
    const r = await run(['connect', '--app', s.app], { KOSKO_IMPORT_TOKEN: TOKEN });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /Connected/);
  } finally { await s.close(); }
});

test('a token given as a word or after a mistyped flag is refused with exit 2, never echoed', async () => {
  for (const args of [['connect', TOKEN], ['connect', '--tokn', TOKEN], ['connect', '--app', 'http://127.0.0.1:9', '--nope']]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(!(r.out + r.err).includes(TOKEN.slice(5)));
    assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
  }
});
