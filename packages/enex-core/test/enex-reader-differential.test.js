// @vitest-environment jsdom
//
// 253 — the reader against an independent oracle. Seeded random ENEX-shaped documents (escaped titles with
// astral and Indic characters, tags, attributes, CDATA content including the VALID split spelling of `]]>`,
// resources with random bytes and random base64 line wrapping) are:
//   - read by readEnex, fed in random byte pieces with a random sax slice size, and
//   - parsed WHOLE by jsdom's XML DOMParser, with each resource decoded by Buffer and hashed by node:crypto.
// Every field must agree. And because none of these documents holds a stray terminator, the CDATA repair
// must return each one byte-for-byte unchanged.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readEnex } from '../src/enex/enex-reader.js';
import { createCdataRepair } from '../src/enex/cdata-repair.js';

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'Z', '7', ' ', '&', '<', '>', '"', "'", 'é', 'ß', '中', 'తె', 'లు', '😀', '\n', '\t', ']', '[', '!'];
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function generate(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const text = (max) => Array.from({ length: Math.floor(rand() * max) }, () => pick(ALPHABET)).join('');
  const ts = () => `20${10 + Math.floor(rand() * 16)}0${1 + Math.floor(rand() * 9)}1${Math.floor(rand() * 9)}T1${Math.floor(rand() * 9)}3${Math.floor(rand() * 9)}00Z`;
  const notes = [];
  const count = 1 + Math.floor(rand() * 4);
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n<en-export application="Evernote" version="${pick(['10.58', '11.32.5'])}">\n`;
  for (let n = 0; n < count; n++) {
    const title = text(30);
    const tags = Array.from({ length: Math.floor(rand() * 3) }, () => text(8) || 't');
    const resources = Array.from({ length: Math.floor(rand() * 3) }, () => {
      const len = Math.floor(rand() * 4000);
      const bytes = Buffer.from(Array.from({ length: len }, () => Math.floor(rand() * 256)));
      return { bytes, wrap: pick([0, 76, 64, 3]), mime: pick(['image/png', 'application/pdf', 'application/octet-stream']), fileName: text(12) };
    });
    // ENML body text: anything but a raw `]]>`, which the export would have to spell as a split section.
    const bodyParts = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => escapeXml(text(40)).replace(/]]>/g, ']]&gt;'));
    const enml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${bodyParts.map((p) => `<div>${p}</div>`).join('')}</en-note>`;
    let splitAt = Math.floor(rand() * enml.length);
    // never between the halves of a surrogate pair: two sections each holding half of 😀 is not XML
    if (/[\uDC00-\uDFFF]/.test(enml[splitAt] || '')) splitAt -= 1;
    const contentXml = rand() < 0.3
      ? `<![CDATA[${enml.slice(0, splitAt)}]]><![CDATA[${enml.slice(splitAt)}]]>`
      : `<![CDATA[${enml}]]>`;
    const parts = [
      `<title>${escapeXml(title)}</title>`,
      `<created>${ts()}</created>`,
      `<updated>${ts()}</updated>`,
      ...tags.map((t) => `<tag>${escapeXml(t)}</tag>`),
      `<note-attributes><author>${escapeXml(text(10))}</author></note-attributes>`,
      `<content>${pick(['', '\n', '  '])}${contentXml}${pick(['', '\n'])}</content>`,
      ...resources.map((r) => {
        let b64 = r.bytes.toString('base64');
        if (r.wrap) b64 = b64.replace(new RegExp(`(.{${r.wrap}})`, 'g'), '$1\n');
        return `<resource><data encoding="base64">${b64}</data><mime>${r.mime}</mime><resource-attributes><file-name>${escapeXml(r.fileName)}</file-name></resource-attributes></resource>`;
      })
    ];
    // Real exports put content after metadata; other importers report other orders. Shuffle a copy.
    if (rand() < 0.5) parts.sort(() => rand() - 0.5);
    xml += `<note>${parts.join(pick(['', '\n', '\r\n  ']))}</note>\n`;
    notes.push(n);
  }
  return `${xml}</en-export>\n`;
}

function oracle(xml) {
  const doc = new window.DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  const child = (el, name) => [...el.children].filter((c) => c.localName === name);
  const one = (el, name) => child(el, name)[0]?.textContent ?? null;
  return [...doc.documentElement.children].filter((c) => c.localName === 'note').map((note, index) => {
    const contentEl = child(note, 'content')[0];
    const cdata = [...contentEl.childNodes].filter((c) => c.nodeType === 4).map((c) => c.data).join('');
    return {
      kind: 'note', index,
      title: one(note, 'title'),
      created: one(note, 'created'),
      updated: one(note, 'updated'),
      tags: child(note, 'tag').map((t) => t.textContent),
      attributes: { author: child(child(note, 'note-attributes')[0], 'author')[0].textContent },
      content: cdata,
      resources: child(note, 'resource').map((r) => {
        const bytes = Buffer.from(one(r, 'data').replace(/\s+/g, ''), 'base64');
        return {
          md5: createHash('md5').update(bytes).digest('hex'),
          bytes: bytes.length,
          mime: one(r, 'mime'),
          fileName: child(child(r, 'resource-attributes')[0], 'file-name')[0].textContent,
          width: null, height: null,
          problem: bytes.length === 0 ? 'empty' : null
        };
      }),
      tasks: [],
      problems: {}
    };
  });
}

function piecewiseBlob(text, sizes) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    stream() {
      let at = 0;
      let k = 0;
      return new ReadableStream({
        pull(c) {
          if (at >= bytes.length) return c.close();
          const n = sizes[k++ % sizes.length];
          c.enqueue(new Uint8Array(bytes.subarray(at, at + n)));
          at += n;
        }
      });
    }
  };
}

describe('readEnex — differential against a whole-document XML parse', () => {
  it('agrees on every field for 150 generated exports read in random pieces', { timeout: 120000 }, async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rand = prng(seed);
      const xml = generate(rand);

      const repair = createCdataRepair();
      const sizes = Array.from({ length: 5 }, () => 1 + Math.floor(rand() * 300));
      let repaired = '';
      let at = 0;
      for (let k = 0; at < xml.length; k++) { repaired += repair.push(xml.slice(at, at + sizes[k % 5])); at += sizes[k % 5]; }
      expect(repaired + repair.end(), `seed ${seed}: repair is an identity`).toBe(xml);

      const records = [];
      for await (const r of readEnex(piecewiseBlob(xml, sizes), { limits: { chunkChars: 1 + Math.floor(rand() * 500) } })) records.push(r);
      const expected = oracle(xml);
      expect(records.filter((r) => r.kind === 'note'), `seed ${seed}`).toEqual(expected);
      expect(records.at(-1), `seed ${seed}`).toEqual({ kind: 'end', notes: expected.length });
    }
  });
});
