// Kosko 743, review H1: a quote's source is read through ONE function, never from `node.attrs` directly.
//
// The value rules run when HTML is parsed and when HTML is rendered. A note loaded from stored JSON
// (`schema.nodeFromJSON`, the editor's `setContent(json)`) goes through neither: ProseMirror keeps whatever
// the JSON held, and the note must still load (a note that fails to load is the worse fault). So the raw
// attributes of a node are untrusted, and `readQuoteSource` is how they are read.
import { describe, it, expect } from 'vitest';
import { noteSchema, readQuoteSource, readSourceAnchor, findPassage, QUOTE_SOURCE_ATTRS } from '../src/index.js';

const schema = noteSchema();
const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';
const para = (text) => ({ type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text }] });
const quote = (attrs) => ({ type: 'blockquote', attrs, content: [para('words')] });
const CLEAN = {
  sourceItem: ID, sourceTitle: 'How small teams plan', sourceUrl: 'https://example.com/teams', sourceExact: 'Small teams plan in pairs.',
  sourceCut: null, sourcePrefix: 'the end. ', sourceSuffix: ' Then', sourceStart: 1280, sourcePage: 3, sourceLength: 26
};
const HOSTILE = {
  sourceItem: ID, sourceTitle: `t\u202e${'x'.repeat(5000)}`, sourceUrl: 'javascript:alert(1)', sourceExact: ['words'], sourceCut: 'yes',
  sourcePrefix: { toString: () => 'p' }, sourceSuffix: 9, sourceStart: -5, sourcePage: '2; x', sourceLength: 1e9
};

describe('readQuoteSource: the cleaned source of a quote, or null', () => {
  it('reads plain attributes, a JSON node and a ProseMirror node alike', () => {
    expect(readQuoteSource(CLEAN)).toEqual(CLEAN);
    expect(readQuoteSource(quote(CLEAN))).toEqual(CLEAN);
    expect(readQuoteSource(schema.nodeFromJSON(quote(CLEAN)))).toEqual(CLEAN);
    expect(Object.keys(readQuoteSource(CLEAN))).toEqual(QUOTE_SOURCE_ATTRS);
  });

  it('is null for a quote with no item, whatever else it holds', () => {
    for (const item of [null, undefined, '', ID.toUpperCase(), 'x', 7, {}]) {
      expect(readQuoteSource({ ...CLEAN, sourceItem: item }), JSON.stringify(item)).toBeNull();
      expect(readQuoteSource(schema.nodeFromJSON(quote({ ...CLEAN, sourceItem: item }))), JSON.stringify(item)).toBeNull();
    }
  });

  it('is null for a node that is not a quote, even one carrying the attributes', () => {
    expect(readQuoteSource({ type: 'paragraph', attrs: CLEAN })).toBeNull();
    expect(readQuoteSource(schema.nodeFromJSON(para('x')))).toBeNull();
    expect(readQuoteSource({ type: 'callout', attrs: CLEAN })).toBeNull();
  });

  it('a node is read from its attrs and nowhere else: values set on the node itself are not a source', () => {
    expect(readQuoteSource({ type: 'blockquote', sourceItem: ID, sourceTitle: 'T' })).toBeNull();
    expect(readQuoteSource({ type: 'blockquote', ...CLEAN, attrs: null })).toBeNull();
    expect(readQuoteSource({ type: 'blockquote', ...CLEAN, attrs: {} })).toBeNull();
    expect(readSourceAnchor({ type: 'blockquote', sourceExact: 'words' })).toBeNull();
    expect(findPassage('some words here', { type: 'blockquote', sourceExact: 'words' })).toEqual({ found: false });
    // Bare attributes (no type) are still read as attributes.
    expect(readQuoteSource({ sourceItem: ID, sourceTitle: 'T' })).toMatchObject({ sourceItem: ID, sourceTitle: 'T' });
  });

  it('is null for anything that is not a node or attributes, without throwing', () => {
    for (const bad of [null, undefined, 'x', 5, true, [], [CLEAN], () => CLEAN, { attrs: 'x' }, { attrs: null }, { attrs: [CLEAN] }, Object.create(CLEAN), { attrs: Object.create(CLEAN) }]) {
      expect(readQuoteSource(bad)).toBeNull();
    }
  });
});

describe('a note loaded from stored JSON keeps what the JSON held: the reason for the reader', () => {
  const stored = { type: 'doc', content: [para('Every word of the note.'), quote(HOSTILE)] };
  const node = schema.nodeFromJSON(stored);
  const loaded = node.content.child(1);

  it('the note loads and passes the schema: a bad attribute never costs the user the note', () => {
    expect(() => node.check()).not.toThrow();
    expect(node.textContent).toBe('Every word of the note.words');
  });

  it('the raw attributes are whatever the client wrote, and come back out of toJSON unchanged', () => {
    expect(loaded.attrs.sourceUrl).toBe('javascript:alert(1)');
    expect(loaded.attrs.sourceStart).toBe(-5);
    expect(loaded.attrs.sourceTitle).toHaveLength(5002);
    expect(node.toJSON().content[1].attrs.sourceUrl).toBe('javascript:alert(1)');
  });

  it('read through the reader, every value has passed its rule', () => {
    expect(readQuoteSource(loaded)).toEqual({
      sourceItem: ID, sourceTitle: `t${'x'.repeat(199)}`, sourceUrl: null, sourceExact: null, sourceCut: null,
      sourcePrefix: null, sourceSuffix: null, sourceStart: null, sourcePage: null, sourceLength: null
    });
  });

  it('a title and an address beside no item are not a source', () => {
    const orphan = schema.nodeFromJSON(quote({ sourceItem: null, sourceTitle: 'T', sourceUrl: 'https://example.com/' }));
    expect(orphan.attrs.sourceTitle).toBe('T');
    expect(readQuoteSource(orphan)).toBeNull();
  });
});

describe('readSourceAnchor: the anchor alone (a highlight has no quote and no item)', () => {
  it('gives the seven anchor values through their rules', () => {
    expect(readSourceAnchor(CLEAN)).toEqual({ sourceExact: CLEAN.sourceExact, sourceCut: null, sourcePrefix: 'the end. ', sourceSuffix: ' Then', sourceStart: 1280, sourcePage: 3, sourceLength: 26 });
    expect(readSourceAnchor({ sourceExact: ' a  b ', sourceStart: '5e1', sourcePrefix: 4 })).toEqual({ sourceExact: 'a b', sourceCut: null, sourcePrefix: null, sourceSuffix: null, sourceStart: null, sourcePage: null, sourceLength: null });
  });

  it('reads a node\'s attributes too, and is null with no passage', () => {
    expect(readSourceAnchor(schema.nodeFromJSON(quote(CLEAN))).sourceExact).toBe(CLEAN.sourceExact);
    for (const bad of [null, 'x', [], {}, { sourceExact: '' }, { sourceExact: 7 }, HOSTILE, Object.create(CLEAN)]) expect(readSourceAnchor(bad)).toBeNull();
  });

  it('findPassage takes a node as it is, and reads it the same way', () => {
    const text = 'It was said that Small teams plan in pairs. And so on.';
    const node = schema.nodeFromJSON(quote({ ...CLEAN, sourceStart: -5, sourcePrefix: 77 }));
    expect(findPassage(text, node)).toEqual({ found: true, start: 17, end: 43, by: 'search' });
    expect(findPassage(text, quote(CLEAN))).toEqual({ found: true, start: 17, end: 43, by: 'search' });
    expect(findPassage(text, schema.nodeFromJSON(quote(HOSTILE)))).toEqual({ found: false });
  });
});
