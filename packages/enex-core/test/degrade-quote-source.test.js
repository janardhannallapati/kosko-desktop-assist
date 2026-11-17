// Kosko 742 "Reader that does not know it" and 743: a sourced quote read by a reader pinned to 0.5.0.
//
// Unlike an unknown BLOCK, an unknown ATTRIBUTE does not empty the note: ProseMirror drops it without a word,
// the quote loads as a plain quote, and the reader's next save would store it without its source. So the
// note needs schema version 3 (the server then refuses the old client's save), and `degradeDoc` counts the
// attributes it dropped so the reader opens the note read-only.
import { describe, it, expect } from 'vitest';
import { noteSchema, degradeDoc, schemaVersionNeeded, NOTE_SCHEMA_VERSION, QUOTE_SOURCE_ATTRS, readQuoteSource } from '../src/index.js';
import { schema050 } from './support/schema-050.js';
import { schema040 } from './support/schema-040.js';

const now = noteSchema();
const old = schema050();
const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', attrs: { textAlign: null }, content });
const NONE = Object.fromEntries(QUOTE_SOURCE_ATTRS.map((name) => [name, null]));
const quote = (attrs, ...content) => ({ type: 'blockquote', attrs: { ...NONE, ...attrs }, content });
const SOURCE = {
  sourceItem: ID, sourceTitle: 'అరకు లోయ ప్రయాణం', sourceUrl: 'https://example.com/araku',
  sourceExact: 'ఉదయం ఆరు గంటలకు బయలుదేరాలి. Carry cash.', sourcePrefix: 'ముందు ', sourceSuffix: ' తరువాత', sourceStart: 412, sourcePage: 2, sourceLength: 39
};

function textOf(node) {
  let s = '';
  (function walk(n) {
    if (n.type === 'text') s += n.text;
    (n.content || []).forEach(walk);
  })(node);
  return s;
}

// The gate: a note holding a sourced quote (Telugu, Hindi and Kannada words, a mark, a list inside the quote),
// a plain quote, and a 0.5.0 callout beside them.
const SOURCED = {
  type: 'doc',
  content: [
    para(text('Notes from the trip')),
    quote(SOURCE,
      para(text('ఉదయం ఆరు గంటలకు బయలుదేరాలి. '), text('Carry cash.', [{ type: 'bold' }])),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('बारिश में फिसलन'))] }] },
      para(text('ಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ'))),
    quote({}, para(text('A plain quote stays plain'))),
    { type: 'callout', attrs: { kind: 'tip' }, content: [para(text('A tip beside it'))] }
  ]
};
const WORDS = ['Notes from the trip', 'ఉదయం ఆరు గంటలకు బయలుదేరాలి. ', 'Carry cash.', 'बारिश में फिसलन', 'ಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ', 'A plain quote stays plain', 'A tip beside it'];

describe('the fixture is a real 0.6.0 note', () => {
  it('passes today\'s schema', () => {
    expect(() => now.nodeFromJSON(SOURCED).check()).not.toThrow();
    expect(now.nodeFromJSON(SOURCED).toJSON().content[1].attrs).toEqual({ ...NONE, ...SOURCE });
  });

  it('the 0.5.0 schema loads it without an error and without the source: the loss a save would store', () => {
    const loaded = old.nodeFromJSON(SOURCED).toJSON();
    expect(loaded.content[1].type).toBe('blockquote');
    expect(loaded.content[1].attrs).toBeUndefined();
    expect(JSON.stringify(loaded)).not.toContain(ID);
  });
});

describe('degradeDoc: a note holding a sourced quote, read by the 0.5.0 schema (the wave\'s gate)', () => {
  const result = degradeDoc(SOURCED, old);

  it('reports that it degraded, and counts each attribute it dropped', () => {
    expect(result.degraded).toBe(true);
    expect(result.floor).toBe(false);
    expect(result.kinds).toEqual({
      'blockquote.sourceItem': 1, 'blockquote.sourceTitle': 1, 'blockquote.sourceUrl': 1, 'blockquote.sourceExact': 1,
      'blockquote.sourcePrefix': 1, 'blockquote.sourceSuffix': 1, 'blockquote.sourceStart': 1, 'blockquote.sourcePage': 1,
      'blockquote.sourceLength': 1
    });
  });

  it('loses no word: every string of the note is in the result, in order', () => {
    const out = textOf(result.doc);
    let from = 0;
    for (const words of WORDS) {
      const at = out.indexOf(words, from);
      expect(at, words).toBeGreaterThanOrEqual(0);
      from = at + words.length;
    }
    expect(out).toBe(textOf(SOURCED));
  });

  it('the quote is still a quote, with its blocks and marks, and no source attribute', () => {
    const [, sourced, plain, callout] = result.doc.content;
    expect(sourced.type).toBe('blockquote');
    expect(sourced.attrs).toEqual({});
    expect(sourced.content.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'paragraph']);
    expect(sourced.content[0].content[1]).toEqual(text('Carry cash.', [{ type: 'bold' }]));
    expect(plain.type).toBe('blockquote');
    expect(callout.type).toBe('callout');
  });

  it('the result passes the 0.5.0 schema, and the note it was given is not changed', () => {
    expect(() => old.nodeFromJSON(result.doc).check()).not.toThrow();
    expect(SOURCED.content[1].attrs.sourceItem).toBe(ID);
  });

  it('read by the 0.4.0 schema too: the callout becomes a quote, the source is counted, no word is lost', () => {
    const older = degradeDoc(SOURCED, schema040());
    expect(older.degraded).toBe(true);
    expect(older.kinds).toMatchObject({ 'blockquote.sourceItem': 1, callout: 1 });
    expect(textOf(older.doc)).toBe(textOf(SOURCED));
    expect(() => schema040().nodeFromJSON(older.doc).check()).not.toThrow();
  });
});

describe('degradeDoc: what is not degraded', () => {
  it('a note with only plain quotes, written by 0.6.0 (ten null attributes), comes back as the same object', () => {
    const plain = { type: 'doc', content: [quote({}, para(text('plain'))), para(text('after'))] };
    const result = degradeDoc(plain, old);
    expect(result.doc).toBe(plain);
    expect(result).toMatchObject({ degraded: false, floor: false });
    expect(Object.keys(result.kinds)).toEqual([]);
  });

  it('today\'s schema knows the source: the note comes back as the same object', () => {
    const result = degradeDoc(SOURCED, now);
    expect(result.doc).toBe(SOURCED);
    expect(result.degraded).toBe(false);
  });
});

describe('schemaVersionNeeded: 1, 2 and 3', () => {
  const docOf = (...content) => ({ type: 'doc', content });
  const callout = { type: 'callout', attrs: { kind: 'tip' }, content: [para(text('x'))] };

  it('this release writes schema version 3', () => {
    expect(NOTE_SCHEMA_VERSION).toBe(3);
  });

  it('a plain note needs 1; a plain quote does not need 3', () => {
    expect(schemaVersionNeeded(docOf(para(text('x'))))).toBe(1);
    expect(schemaVersionNeeded(docOf({ type: 'blockquote', content: [para(text('x'))] }))).toBe(1);
    expect(schemaVersionNeeded(docOf(quote({}, para(text('x')))))).toBe(1);
  });

  it('a 0.5.0 block needs 2', () => {
    expect(schemaVersionNeeded(docOf(callout))).toBe(2);
    expect(schemaVersionNeeded(docOf(callout, quote({}, para(text('x')))))).toBe(2);
  });

  it('a quote with a source item needs 3, wherever it sits', () => {
    const sourced = quote(SOURCE, para(text('x')));
    expect(schemaVersionNeeded(docOf(sourced))).toBe(3);
    expect(schemaVersionNeeded(docOf(sourced, callout))).toBe(3);
    expect(schemaVersionNeeded(docOf(callout, para(text('y')), sourced))).toBe(3);
    expect(schemaVersionNeeded(docOf({ type: 'callout', attrs: { kind: 'tip' }, content: [para(text('x'))] }, { type: 'details', content: [{ type: 'detailsSummary' }, { type: 'detailsContent', content: [sourced] }] }))).toBe(3);
    expect(schemaVersionNeeded(docOf(quote({ sourceItem: ID }, para(text('x')))))).toBe(3);
  });

  it('the other attributes without an item are not a source: they render as nothing and need no newer reader', () => {
    expect(schemaVersionNeeded(docOf(quote({ sourceTitle: 'T', sourceUrl: 'https://example.com/', sourceExact: 'words' }, para(text('x')))))).toBe(1);
  });

  it('an item that is set and is not a uuid is not a source: the reader answers null for it, and so no newer reader is needed', () => {
    for (const item of [ID.toUpperCase(), 'x', '', 7, true, {}, [ID]]) {
      const doc = docOf(quote({ sourceItem: item, sourceTitle: 'T' }, para(text('x'))));
      expect(readQuoteSource(doc.content[0]), JSON.stringify(item)).toBeNull();
      expect(schemaVersionNeeded(doc), JSON.stringify(item)).toBe(1);
    }
  });

  it('an upper-case uuid: the reader says no source, so version 1 (the reader is the authority)', () => {
    const upper = quote({ ...SOURCE, sourceItem: ID.toUpperCase() }, para(text('x')));
    expect(readQuoteSource(upper)).toBeNull();
    expect(schemaVersionNeeded(docOf(upper))).toBe(1);
    expect(schemaVersionNeeded(docOf(now.nodeFromJSON(docOf(upper)).toJSON().content[0]))).toBe(1);
    expect(schemaVersionNeeded(docOf(quote(SOURCE, para(text('x')))))).toBe(3);
  });

  it('a source item on any other block is not one', () => {
    expect(schemaVersionNeeded(docOf({ type: 'paragraph', attrs: { sourceItem: ID }, content: [text('x')] }))).toBe(1);
  });

  it('hostile shapes answer without throwing', () => {
    expect(schemaVersionNeeded(docOf({ type: 'blockquote', attrs: 'x' }))).toBe(1);
    expect(schemaVersionNeeded(docOf({ type: 'blockquote', attrs: [ID] }))).toBe(1);
    expect(schemaVersionNeeded(docOf({ type: 'blockquote', attrs: Object.create({ sourceItem: ID }) }))).toBe(1);
    let node = quote(SOURCE, para(text('deep')));
    for (let i = 0; i < 20000; i += 1) node = { type: 'blockquote', content: [node] };
    expect(schemaVersionNeeded(docOf(node))).toBe(3);
  });
});
