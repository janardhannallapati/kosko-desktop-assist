// 466 rules 1-2: the import token is pasted (hidden prompt) or taken from KOSKO_IMPORT_TOKEN, never a flag, and is
// never printed: redact() runs over every string the tool shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkToken, readToken, redact } from '../src/send/token.mjs';

const TOKEN = `cvit_${'a1'.repeat(32)}`;

function fakeTty(chunks) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.rawModes = [];
  stdin.setRawMode = (on) => { stdin.rawModes.push(on); };
  stdin.resume = () => { for (const c of chunks) queueMicrotask(() => stdin.emit('data', Buffer.from(c))); };
  stdin.pause = () => {};
  const written = [];
  const stderr = { write: (s) => { written.push(String(s)); return true; } };
  return { stdin, stderr, written };
}

test('a token from KOSKO_IMPORT_TOKEN is read, trimmed', async () => {
  assert.equal(await readToken({ env: { KOSKO_IMPORT_TOKEN: `  ${TOKEN}\n` }, stdin: { isTTY: false } }), TOKEN);
});

test('a pasted token is read from a hidden prompt: raw mode on, nothing of it echoed, raw mode restored', async () => {
  const t = fakeTty([TOKEN.slice(0, 20), `${TOKEN.slice(20)}\r`]);
  const got = await readToken({ env: {}, stdin: t.stdin, stderr: t.stderr });
  assert.equal(got, TOKEN);
  assert.deepEqual(t.stdin.rawModes, [true, false]);
  assert.ok(t.written.join('').includes('import token'), 'the prompt says what to paste');
  assert.ok(!t.written.join('').includes('cvit_'), 'nothing pasted is echoed');
});

test('backspace in the hidden prompt removes the last character', async () => {
  const t = fakeTty([`${TOKEN}x`, '\x7f', '\n']);
  assert.equal(await readToken({ env: {}, stdin: t.stdin, stderr: t.stderr }), TOKEN);
});

test('Ctrl-C in the hidden prompt stops, restoring raw mode', async () => {
  const t = fakeTty(['cvit_12', '\x03']);
  await assert.rejects(readToken({ env: {}, stdin: t.stdin, stderr: t.stderr }), /cancelled/i);
  assert.deepEqual(t.stdin.rawModes, [true, false]);
});

test('no terminal and no variable: stop, naming the variable', async () => {
  await assert.rejects(readToken({ env: {}, stdin: { isTTY: false } }), /KOSKO_IMPORT_TOKEN/);
});

test('a value that is not an import token is refused without repeating it', () => {
  for (const bad of ['', 'cvat_' + 'a'.repeat(64), 'cvit_' + 'a'.repeat(63), 'cvit_' + 'A'.repeat(64), 'hunter2-secret']) {
    assert.throws(() => checkToken(bad), (e) => {
      assert.match(e.message, /isn.t an import token/);
      if (bad) assert.ok(!e.message.includes(bad), 'the message must not repeat the value');
      return true;
    });
  }
});

test('benign: a valid token passes, surrounding space trimmed', () => {
  assert.equal(checkToken(` ${TOKEN} `), TOKEN);
});

test('redact replaces every import token in a text, and leaves other text alone', () => {
  const s = `sent Bearer ${TOKEN} then ${TOKEN.toUpperCase().replace('CVIT_', 'cvit_')} done`;
  const r = redact(s);
  assert.ok(!r.includes(TOKEN.slice(5, 20)));
  assert.equal(r, 'sent Bearer cvit_… then cvit_… done');
  assert.equal(redact('no secrets here'), 'no secrets here');
  assert.equal(redact(undefined), '');
});

// 466 review LOW — the prompt settles when stdin ends (EOF, a closed terminal), restoring raw mode.
test('stdin ending during the prompt stops it and restores raw mode', async () => {
  const t = fakeTty([]);
  t.stdin.resume = () => queueMicrotask(() => t.stdin.emit('end'));
  await assert.rejects(readToken({ env: {}, stdin: t.stdin, stderr: t.stderr }), /cancelled/i);
  assert.deepEqual(t.stdin.rawModes, [true, false]);
});
