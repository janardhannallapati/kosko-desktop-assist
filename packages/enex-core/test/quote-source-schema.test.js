// @vitest-environment jsdom
//
// Kosko 742 / 743: the source attributes on the existing `blockquote`, schema only.
//
// A plain quote and a sourced quote are one block. The nine attributes are global attributes, as
// `CellBackground` adds `background` to a cell. Without a valid `sourceItem` none of the others exists, on
// the way in (HTML) and on the way out (stored JSON a client wrote).
import { describe, it, expect } from 'vitest';
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import { noteSchema, QuoteSource, NOTE_SCHEMA_EXTENSIONS, QUOTE_SOURCE_ATTRS } from '../src/index.js';
import { schema050 } from './support/schema-050.js';

const schema = noteSchema();
const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';

function parse(html, using = schema) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return DOMParser.fromSchema(using).parse(host).toJSON();
}

function render(json, using = schema) {
  const host = document.createElement('div');
  host.appendChild(DOMSerializer.fromSchema(using).serializeFragment(using.nodeFromJSON(json).content));
  return host.innerHTML;
}

const para = (text) => ({ type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text }] });
const NONE = Object.fromEntries(QUOTE_SOURCE_ATTRS.map((name) => [name, null]));
const quote = (attrs, ...content) => ({ type: 'doc', content: [{ type: 'blockquote', attrs: { ...NONE, ...attrs }, content }] });
const quoteOf = (json) => json.content.find((n) => n.type === 'blockquote');

const FULL = {
  sourceItem: ID, sourceTitle: 'How small teams plan', sourceUrl: 'https://example.com/teams?a=1&b=2',
  sourceExact: 'Small teams plan in pairs.', sourceCut: null, sourcePrefix: 'the end. ', sourceSuffix: ' Then they',
  sourceStart: 1280, sourcePage: 3, sourceLength: 26
};

describe('the stored shape', () => {
  it('the extension is in the schema list, and the quote has ten attributes, each null by default', () => {
    expect(NOTE_SCHEMA_EXTENSIONS).toContain(QuoteSource);
    const attrs = schema.nodes.blockquote.spec.attrs;
    expect(Object.keys(attrs)).toEqual(QUOTE_SOURCE_ATTRS);
    for (const name of QUOTE_SOURCE_ATTRS) expect(attrs[name].default, name).toBeNull();
  });

  it('no other block has them', () => {
    for (const type of ['paragraph', 'heading', 'callout', 'listItem', 'tableCell']) {
      expect(Object.keys(schema.nodes[type].spec.attrs || {}), type).not.toContain('sourceItem');
    }
  });

  it('a quote in a note written before 0.6.0 (no attributes) is accepted', () => {
    const old = { type: 'doc', content: [{ type: 'blockquote', content: [para('Plain words')] }] };
    expect(() => schema.nodeFromJSON(old).check()).not.toThrow();
    expect(schema.nodeFromJSON(old).toJSON().content[0].attrs).toEqual(NONE);
  });
});

describe('a plain quote is written exactly as 0.5.0 wrote it', () => {
  const plain = { type: 'doc', content: [{ type: 'blockquote', content: [para('Plain words'), para('second line')] }] };

  it('renders no new attribute', () => {
    expect(render(plain)).toBe('<blockquote><p>Plain words</p><p>second line</p></blockquote>');
  });

  it('is byte for byte what the 0.5.0 schema renders', () => {
    expect(render(plain)).toBe(render(plain, schema050()));
  });

  it('parses with every source attribute null', () => {
    expect(quoteOf(parse('<blockquote><p>Plain words</p></blockquote>')).attrs).toEqual(NONE);
  });
});

describe('a sourced quote round-trips through HTML', () => {
  it('renders each value as its data-* attribute', () => {
    expect(render(quote(FULL, para('Small teams plan in pairs.')))).toBe(
      `<blockquote data-source-item="${ID}" data-source-title="How small teams plan" ` +
      'data-source-url="https://example.com/teams?a=1&amp;b=2" data-source-exact="Small teams plan in pairs." ' +
      'data-source-prefix="the end. " data-source-suffix=" Then they" data-source-start="1280" data-source-page="3" data-source-length="26">' +
      '<p>Small teams plan in pairs.</p></blockquote>');
  });

  it('reads the same attributes back', () => {
    const doc = quote(FULL, para('Small teams plan in pairs.'));
    expect(quoteOf(parse(render(doc))).attrs).toEqual(FULL);
  });

  it('a Telugu, Hindi and Kannada quote round-trips', () => {
    const attrs = { ...FULL, sourceTitle: 'అరకు లోయ ప్రయాణం', sourceExact: 'ఉదయం ఆరు గంటలకు बारिश में ಮಳೆಯಲ್ಲಿ', sourcePrefix: 'ముందు ', sourceSuffix: ' తరువాత', sourcePage: null };
    expect(quoteOf(parse(render(quote(attrs, para('ఉదయం ఆరు గంటలకు'))))).attrs).toEqual(attrs);
  });

  it('a cut passage keeps its flag', () => {
    const exact = 'a'.repeat(500) + 'b'.repeat(500);
    const html = render(quote({ ...FULL, sourceExact: exact, sourceCut: true, sourceLength: 4200 }, para('x')));
    expect(html).toContain('data-source-cut="true"');
    expect(html).toContain('data-source-length="4200"');
    expect(quoteOf(parse(html)).attrs).toMatchObject({ sourceExact: exact, sourceCut: true, sourceLength: 4200 });
    // Without its length the flag is not written: a cut passage that cannot be placed is not called one.
    expect(render(quote({ ...FULL, sourceExact: exact, sourceCut: true, sourceLength: null }, para('x')))).not.toContain('data-source-cut');
  });

  it('a title that looks like a number or a boolean stays text', () => {
    for (const title of ['42', 'true', 'null']) {
      const back = quoteOf(parse(render(quote({ ...FULL, sourceTitle: title }, para('x'))))).attrs.sourceTitle;
      expect(back).toBe(title);
    }
  });

  it('a start of 0 is kept, not read as "none"', () => {
    const html = render(quote({ ...FULL, sourceStart: 0 }, para('x')));
    expect(html).toContain('data-source-start="0"');
    expect(quoteOf(parse(html)).attrs.sourceStart).toBe(0);
  });
});

describe('without a valid item there is no source at all', () => {
  const others = 'data-source-title="T" data-source-url="https://example.com/" data-source-exact="words" data-source-cut="true" ' +
    'data-source-prefix="p" data-source-suffix="s" data-source-start="5" data-source-page="2" data-source-length="5"';

  it.each([
    ['no item', ''],
    ['an upper-case item', `data-source-item="${ID.toUpperCase()}"`],
    ['an item in braces', `data-source-item="{${ID}}"`],
    ['an item that is not a uuid', 'data-source-item="1"'],
    ['an empty item', 'data-source-item=""']
  ])('HTML in, %s: every attribute is null', (_name, item) => {
    expect(quoteOf(parse(`<blockquote ${item} ${others}><p>words</p></blockquote>`)).attrs).toEqual(NONE);
  });

  it.each([null, ID.toUpperCase(), 'x', 7, '', { id: ID }])('stored JSON out, item %j: the quote renders plain', (item) => {
    const stored = quote({ ...FULL, sourceItem: item }, para('words'));
    expect(render(stored)).toBe('<blockquote><p>words</p></blockquote>');
  });

  it('with a valid item the same HTML keeps them (benign path)', () => {
    const attrs = quoteOf(parse(`<blockquote data-source-item="${ID}" ${others}><p>words</p></blockquote>`)).attrs;
    expect(attrs).toMatchObject({ sourceItem: ID, sourceTitle: 'T', sourceUrl: 'https://example.com/', sourceExact: 'words', sourcePrefix: 'p', sourceSuffix: 's', sourceStart: 5, sourcePage: 2, sourceLength: 5 });
    // The flag beside a five-unit passage is not a cut passage.
    expect(attrs.sourceCut).toBeNull();
  });
});

describe('each value is checked again on the way out: stored JSON is what a client wrote', () => {
  const out = (attrs) => render(quote({ ...FULL, ...attrs }, para('words')));

  it.each([
    ['a javascript: address', { sourceUrl: 'javascript:alert(1)' }, 'data-source-url'],
    ['a data: address', { sourceUrl: 'data:text/html,x' }, 'data-source-url'],
    ['an address with a password', { sourceUrl: 'https://a:b@example.com/' }, 'data-source-url'],
    ['a title that is an object', { sourceTitle: { toString: () => 'x' } }, 'data-source-title'],
    ['a start that is not a whole number', { sourceStart: '5e1' }, 'data-source-start'],
    ['a start past the limit', { sourceStart: 10_000_001 }, 'data-source-start'],
    ['a page of 0', { sourcePage: 0 }, 'data-source-page'],
    ['a length of 0', { sourceLength: 0 }, 'data-source-length'],
    ['a length that is not a whole number', { sourceLength: '1e3' }, 'data-source-length'],
    ['a prefix that is a number', { sourcePrefix: 12 }, 'data-source-prefix'],
    ['a passage that is an array', { sourceExact: ['words'] }, 'data-source-exact']
  ])('%s is not rendered', (_name, attrs, dataName) => {
    const html = out(attrs);
    expect(html).not.toContain(dataName);
    expect(html).toContain(`data-source-item="${ID}"`);
    expect(html).not.toMatch(/javascript|data:text|a:b@/);
  });

  it('a stored title longer than the limit is rendered cut, and a stored passage longer than the limit is rendered cut with its flag', () => {
    const html = out({ sourceTitle: 't'.repeat(900), sourceExact: 'a'.repeat(700) + 'b'.repeat(700), sourceCut: null, sourceLength: 1400 });
    expect(html).toContain(`data-source-title="${'t'.repeat(200)}"`);
    expect(html).toContain(`data-source-exact="${'a'.repeat(500)}${'b'.repeat(500)}"`);
    expect(html).toContain('data-source-cut="true"');
  });

  it('a value cannot break out of its attribute', () => {
    const html = out({ sourceTitle: '"><img src=x onerror=alert(1)>', sourceExact: '"><script>alert(1)</script>' });
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelectorAll('img, script')).toHaveLength(0);
    expect(host.querySelector('blockquote').getAttribute('data-source-title')).toBe('"><img src=x onerror=alert(1)>');
  });
});
