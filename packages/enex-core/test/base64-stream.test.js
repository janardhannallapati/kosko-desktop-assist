// 253 — decoding a resource's base64 as it streams. The owner's largest attachment is 45 MB decoded
// (~60 MB of base64), inside a single 176 MB note, so the text is never held: sax hands it over in
// pieces of up to 128 KB that do not line up with 4-character quanta, and the decoded-size cap is
// enforced INSIDE the decoder (spec §3.4) — not after a string has already been built.
//
// The oracle is Node's Buffer base64 codec over the whole input.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createBase64Decoder } from '../src/enex/base64-stream.js';

function decodeInPieces(text, sizes, opts = {}) {
  const chunks = [];
  const d = createBase64Decoder({ ...opts, onBytes: (u8) => chunks.push(Buffer.from(u8)) });
  let at = 0;
  let k = 0;
  while (at < text.length) {
    const n = sizes[k++ % sizes.length];
    d.push(text.slice(at, at + n));
    at += n;
  }
  const result = d.end();
  return { ...result, data: Buffer.concat(chunks) };
}

describe('createBase64Decoder', () => {
  it('decodes exactly what Buffer decodes, for every length 0..64 and every piece size 1..9', () => {
    for (let len = 1; len <= 64; len++) {
      const raw = randomBytes(len);
      const text = raw.toString('base64');
      for (let size = 1; size <= 9; size++) {
        const r = decodeInPieces(text, [size]);
        expect(r.problem, `len ${len} size ${size}`).toBe(null);
        expect(r.bytes, `len ${len} size ${size}`).toBe(len);
        expect(r.data.equals(raw), `len ${len} size ${size}`).toBe(true);
      }
    }
  });

  it('ignores the whitespace Evernote wraps base64 in (CRLF, LF, spaces, tabs), wherever a piece boundary falls', () => {
    const raw = randomBytes(3000);
    const text = raw.toString('base64').replace(/(.{76})/g, '$1\r\n').replace(/^/, '\n\t ') + '\n  ';
    const r = decodeInPieces(text, [1, 7, 128, 3, 5000]);
    expect(r.problem).toBe(null);
    expect(r.data.equals(raw)).toBe(true);
    expect(r.bytes).toBe(3000);
  });

  it('accepts unpadded input (a 2- or 3-character final quantum)', () => {
    for (const len of [1, 2, 4, 5]) {
      const raw = randomBytes(len);
      const text = raw.toString('base64').replace(/=+$/, '');
      const r = decodeInPieces(text, [2]);
      expect(r.problem).toBe(null);
      expect(r.data.equals(raw)).toBe(true);
    }
  });

  it('an UNDER-padded tail is decoded, not refused — its bytes are unambiguous (the adopted mutant)', () => {
    const r = decodeInPieces('QQ=', [1]);
    expect(r.problem).toBe(null);
    expect([...r.data]).toEqual([0x41]);
    expect(decodeInPieces('QUI=', [2]).data.toString()).toBe('AB');
  });

  it('an empty <data> is a counted problem, not an error', () => {
    expect(decodeInPieces('', [1])).toMatchObject({ bytes: 0, problem: 'empty' });
    expect(decodeInPieces(' \r\n\t', [1])).toMatchObject({ bytes: 0, problem: 'empty' });
  });

  for (const [label, text] of [
    ['a character outside the alphabet', 'QUJD*REVG'],
    ['URL-safe characters', 'QUJD-_VG'],
    ['data after padding', 'QQ==QUJD'],
    ['a single leftover character', 'QUJDR'],
    ['too much padding', 'QQ==='],
    ['padding after a whole quantum', 'QUJD='],
    ['padding after one character', 'Q=']
  ]) {
    it(`marks ${label} as corrupt and stops emitting bytes`, () => {
      const r = decodeInPieces(text, [3]);
      expect(r.problem).toBe('corrupt');
    });
  }

  it('enforces the decoded-size cap INSIDE the decoder: no byte beyond the cap is ever emitted, and the size is still counted', () => {
    const raw = randomBytes(10000);
    const text = raw.toString('base64');
    const r = decodeInPieces(text, [100], { maxBytes: 4096 });
    expect(r.problem).toBe('too-large-to-read');
    expect(r.data.length).toBeLessThanOrEqual(4096);
    expect(r.bytes).toBe(10000);
  });

  it('a resource exactly at the cap is read', () => {
    const raw = randomBytes(4096);
    const r = decodeInPieces(raw.toString('base64'), [333], { maxBytes: 4096 });
    expect(r.problem).toBe(null);
    expect(r.data.equals(raw)).toBe(true);
  });

  it('never holds more than one piece of input: a 64 MB resource fed in 64 KB pieces emits bytes piece by piece', { timeout: 60000 }, () => {
    const piece = randomBytes(48 * 1024).toString('base64'); // 64 KB of text, a whole number of quanta
    let emitted = 0;
    let largestEmit = 0;
    const d = createBase64Decoder({ onBytes: (u8) => { emitted += u8.length; largestEmit = Math.max(largestEmit, u8.length); } });
    for (let i = 0; i < 1000; i++) d.push(piece);
    expect(d.end()).toEqual({ bytes: 48 * 1024 * 1000, problem: null });
    expect(emitted).toBe(48 * 1024 * 1000);
    expect(largestEmit).toBeLessThanOrEqual(48 * 1024);
  });

  it('the default cap is 1 GiB', async () => {
    const { MAX_RESOURCE_BYTES } = await import('../src/enex/base64-stream.js');
    expect(MAX_RESOURCE_BYTES).toBe(1024 * 1024 * 1024);
  });
});
