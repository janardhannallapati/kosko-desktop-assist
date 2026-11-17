// @vitest-environment jsdom
//
// Kosko 742 / 743: reading a sourced quote back from an Evernote file.
//
// Kosko's export marks the quote with `--kosko-quote-source:<uuid>` (and the page and start beside it) and
// ends it with a cite line, `<div style="--kosko-quote-cite:1">— <a href="url">title</a></div>`. The file is
// not trusted: each value is read through the rule the schema uses, the cite line is consumed only when it
// has exactly that shape, and anything else stays ordinary text so no word is lost.
import { describe, it, expect } from 'vitest';
import { conv, nodesOf, textOf, topTypes } from './support/convert-harness.js';
import { KOSKO_ENML, QUOTE_SOURCE_ATTRS } from '../src/index.js';
import { quoteHtml } from '../src/enml/enml-quote-source.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';
const NONE = Object.fromEntries(QUOTE_SOURCE_ATTRS.map((name) => [name, null]));
const CITE = '<div style="--kosko-quote-cite:1">— <a href="https://example.com/teams">How small teams plan</a></div>';
const LINES = '<div>Small teams plan in pairs.</div><div>They review on <b>Friday</b>.</div>';
const quote = (style, inner) => `<blockquote style="${style}">${inner}</blockquote>`;
const own = (inner = LINES + CITE, more = '') => quote(`--kosko-quote-source:${ID}; --kosko-quote-page:3; --kosko-quote-start:1280${more}`, inner);
const quoteIn = (doc) => nodesOf(doc, 'blockquote')[0];
const links = (doc) => nodesOf(doc, 'text').filter((t) => (t.marks || []).some((m) => m.type === 'link'));

describe('the markers', () => {
  it('five more names in the one fixed set, beside the eight of 0.5.0', () => {
    expect(KOSKO_ENML).toMatchObject({ quoteSource: '--kosko-quote-source', quotePage: '--kosko-quote-page', quoteStart: '--kosko-quote-start', quoteLength: '--kosko-quote-length', quoteCite: '--kosko-quote-cite' });
    expect(Object.keys(KOSKO_ENML)).toHaveLength(13);
    expect(Object.isFrozen(KOSKO_ENML)).toBe(true);
  });
});

describe('Kosko\'s own form reads back to the same attributes', () => {
  it('the item, page and start from the quote; the title and address from the cite line; the passage from the quote\'s text', () => {
    const { doc } = conv(own());
    expect(topTypes(doc)).toEqual(['blockquote']);
    expect(quoteIn(doc).attrs).toEqual({
      sourceItem: ID, sourceTitle: 'How small teams plan', sourceUrl: 'https://example.com/teams',
      sourceExact: 'Small teams plan in pairs. They review on Friday.', sourceCut: null, sourcePrefix: null, sourceSuffix: null,
      sourceStart: 1280, sourcePage: 3, sourceLength: null
    });
  });

  it('the length marker is read through its rule; without it, or with a bad one, the length is null', () => {
    expect(quoteIn(conv(own(LINES + CITE, '; --kosko-quote-length:48')).doc).attrs.sourceLength).toBe(48);
    for (const bad of ['0', '-48', '4.8e1', '48px', '1000001', '']) {
      const attrs = quoteIn(conv(own(LINES + CITE, `; --kosko-quote-length:${bad}`)).doc).attrs;
      expect(attrs, bad).toMatchObject({ sourceItem: ID, sourceLength: null, sourceTitle: 'How small teams plan' });
    }
  });

  it('the cite line is not part of the quote\'s words, and leaves no link behind', () => {
    const { doc } = conv(own());
    expect(textOf(quoteIn(doc))).toBe('Small teams plan in pairs.They review on Friday.');
    expect(quoteIn(doc).content.map((n) => n.type)).toEqual(['paragraph', 'paragraph']);
    expect(links(doc)).toEqual([]);
  });

  it('an article has no page; a quote with no hint has no start', () => {
    const { doc } = conv(quote(`--kosko-quote-source:${ID}`, LINES + CITE));
    expect(quoteIn(doc).attrs).toMatchObject({ sourceItem: ID, sourceTitle: 'How small teams plan', sourceStart: null, sourcePage: null });
  });

  it('a quote written with no cite line keeps its item and has no title or address', () => {
    const { doc } = conv(own(LINES));
    expect(quoteIn(doc).attrs).toMatchObject({ sourceItem: ID, sourceTitle: null, sourceUrl: null, sourceStart: 1280 });
  });

  it('Telugu, Hindi and Kannada: the words, the title and the passage survive', () => {
    const cite = '<div style="--kosko-quote-cite:1; color:#666">— <a href="https://example.com/%E0%B0%85">అరకు లోయ ప్రయాణం</a></div>';
    const { doc } = conv(own(`<div>ఉదయం ఆరు గంటలకు</div><div>बारिश में फिसलन</div><div>ಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ</div>${cite}`));
    expect(quoteIn(doc).attrs).toMatchObject({ sourceTitle: 'అరకు లోయ ప్రయాణం', sourceUrl: 'https://example.com/%E0%B0%85', sourceExact: 'ఉదయం ఆరు గంటలకు बारिश में फिसलन ಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ' });
    expect(textOf(quoteIn(doc))).toBe('ఉదయం ఆరు గంటలకుबारिश में फिसलनಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ');
  });

  it('a quote longer than the limit stores its first 500 and last 500, flagged; the note keeps every word', () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const { doc } = conv(own(`<div>${long}</div>${CITE}`, `; --kosko-quote-length:${long.length}`));
    const { sourceExact, sourceCut, sourceLength } = quoteIn(doc).attrs;
    expect(sourceCut).toBe(true);
    expect(sourceLength).toBe(long.length);
    // With no length in the file the same quote is not called cut: it cannot be placed, and says so later.
    expect(quoteIn(conv(own(`<div>${long}</div>${CITE}`)).doc).attrs).toMatchObject({ sourceCut: null, sourceLength: null });
    expect(sourceExact.length).toBeLessThanOrEqual(1000);
    expect(sourceExact.startsWith('word0 word1 ') && sourceExact.endsWith(' word299')).toBe(true);
    expect(textOf(quoteIn(doc))).toBe(long);
  });

  it('nothing of the file\'s style is stored', () => {
    const { doc } = conv(quote(`--kosko-quote-source:${ID}; background:url(https://evil.test/x); color:red`, LINES + CITE));
    expect(JSON.stringify(doc)).not.toMatch(/kosko|evil|background|color/);
    expect(quoteIn(doc).attrs.sourceItem).toBe(ID);
  });
});

describe('the element handed to the schema', () => {
  const build = (enml) => {
    const xml = new window.DOMParser().parseFromString(enml, 'application/xml').documentElement;
    const copyElement = (from, name) => {
      const el = document.createElement(name);
      for (const attr of Array.from(from.attributes)) el.setAttribute(attr.name, attr.value);
      return el;
    };
    return quoteHtml(xml, { doc: document, skip: new Set() }, 0, { childrenInto: () => {}, copyElement, block: new Set(['div']), dropped: new Set() });
  };

  it('a sourced quote is a new element holding the checked values and nothing of the file\'s', () => {
    const el = build(`<blockquote style="--kosko-quote-source:${ID}; --kosko-quote-page:3; color:red" class="c" onclick="x()" title="t"><div>Words</div></blockquote>`);
    expect(el.getAttributeNames().sort()).toEqual(['data-source-exact', 'data-source-item', 'data-source-page']);
    expect(el.getAttribute('data-source-exact')).toBe('Words');
    expect(el.getAttribute('data-source-item')).toBe(ID);
  });

  it('a quote with no valid marker is copied by the pre-pass\'s own copy, as before 0.6.0 (benign path)', () => {
    const el = build('<blockquote style="--kosko-quote-source:nope" align="left"><div>Words</div></blockquote>');
    expect(el.getAttributeNames().sort()).toEqual(['align', 'style']);
  });
});

describe('a marker value that is not Kosko\'s reads as a plain quote, with every word kept', () => {
  it.each([
    ['an upper-case uuid', ID.toUpperCase()],
    ['a uuid in braces', `{${ID}}`],
    ['not a uuid', 'item-7'],
    ['an empty value', ''],
    ['script-like text', 'javascript:alert(1)']
  ])('%s', (_name, value) => {
    const { doc } = conv(quote(`--kosko-quote-source:${value}; --kosko-quote-page:3`, LINES + CITE));
    expect(topTypes(doc)).toEqual(['blockquote']);
    expect(quoteIn(doc).attrs).toEqual(NONE);
    expect(textOf(doc)).toBe('Small teams plan in pairs.They review on Friday.— How small teams plan');
    expect(links(doc).map((t) => t.text)).toEqual(['How small teams plan']);
  });

  it.each([['5e1', '0x32'], ['-1', '1.5'], ['0', '10000001'], ['100001', 'x'], ['3 !important', '12px']])('a page of %j and a start of %j are dropped; the quote keeps its item', (page, start) => {
    const { doc } = conv(quote(`--kosko-quote-source:${ID}; --kosko-quote-page:${page}; --kosko-quote-start:${start}`, LINES + CITE));
    expect(quoteIn(doc).attrs).toMatchObject({ sourceItem: ID, sourcePage: null, sourceStart: null, sourceTitle: 'How small teams plan' });
  });

  it('a quote with no marker is the quote it always was', () => {
    const { doc } = conv(`<blockquote>${LINES}${CITE}</blockquote>`);
    expect(quoteIn(doc).attrs).toEqual(NONE);
    expect(textOf(doc)).toBe('Small teams plan in pairs.They review on Friday.— How small teams plan');
  });

  it('the marker on anything but a quote does nothing', () => {
    const { doc } = conv(`<div style="--kosko-quote-source:${ID}"><div>Just a line</div>${CITE}</div>`);
    expect(nodesOf(doc, 'blockquote')).toEqual([]);
    expect(textOf(doc)).toBe('Just a line— How small teams plan');
  });
});

describe('a cite line is consumed only in the exact shape Kosko writes', () => {
  const cite = (inner, style = '--kosko-quote-cite:1') => `<div style="${style}">${inner}</div>`;
  const LINK = '<a href="https://example.com/teams">How small teams plan</a>';

  it.each([
    ['a title longer than 200 characters', cite(`— <a href="https://example.com/teams">${'long title '.repeat(30)}</a>`)],
    ['two links', cite(`— ${LINK} <a href="https://example.com/b">second</a>`)],
    ['words after the link', cite(`— ${LINK} and more words`)],
    ['words before the dash', cite(`see — ${LINK}`)],
    ['a hyphen in place of the dash', cite(`- ${LINK}`)],
    ['no dash', cite(LINK)],
    ['an element inside the link', cite('— <a href="https://example.com/teams"><b>How small</b> teams plan</a>')],
    ['the link inside another element', cite(`— <span>${LINK}</span>`)],
    ['no link at all', cite('— How small teams plan')],
    ['a link with no address', cite('— <a>How small teams plan</a>')],
    ['an empty link', cite('— <a href="https://example.com/teams"> </a>')],
    ['a javascript: address', cite('— <a href="javascript:alert(1)">How small teams plan</a>')],
    ['an address with a password', cite('— <a href="https://u:p@example.com/">How small teams plan</a>')],
    ['an ftp: address', cite('— <a href="ftp://example.com/f">How small teams plan</a>')],
    ['a marker value that is not 1', cite(`— ${LINK}`, '--kosko-quote-cite:yes')],
    ['a paragraph in place of the div', `<p style="--kosko-quote-cite:1">— ${LINK}</p>`]
  ])('%s stays an ordinary line of the quote', (_name, line) => {
    const { doc } = conv(own(LINES + line));
    const q = quoteIn(doc);
    expect(q.attrs).toMatchObject({ sourceItem: ID, sourceTitle: null, sourceUrl: null, sourcePage: 3 });
    expect(q.content).toHaveLength(3);
    const expected = line.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    expect(textOf(q.content[2]).replace(/\s+/g, '')).toBe(expected);
    expect(JSON.stringify(doc)).not.toMatch(/javascript:/);
  });

  it('a cite line that is not the last line stays an ordinary line', () => {
    const { doc } = conv(own(`<div>Small teams plan in pairs.</div>${CITE}<div>A line after it.</div>`));
    expect(quoteIn(doc).attrs).toMatchObject({ sourceItem: ID, sourceTitle: null, sourceUrl: null });
    expect(textOf(quoteIn(doc))).toBe('Small teams plan in pairs.— How small teams planA line after it.');
  });

  it('text after the cite line, outside any line, keeps the cite line ordinary too', () => {
    const { doc } = conv(own(`${LINES}${CITE}trailing words`));
    expect(quoteIn(doc).attrs.sourceTitle).toBeNull();
    expect(textOf(doc)).toContain('— How small teams plan');
    expect(textOf(doc)).toContain('trailing words');
  });

  it('a cite line outside a quote is ordinary text', () => {
    const { doc } = conv(`<div>Before</div>${CITE}`);
    expect(nodesOf(doc, 'blockquote')).toEqual([]);
    expect(textOf(doc)).toBe('Before— How small teams plan');
    expect(links(doc).map((t) => t.text)).toEqual(['How small teams plan']);
  });

  it('a cite line in a plain quote, or deeper inside a sourced quote, is ordinary text', () => {
    expect(textOf(conv(`<blockquote>${LINES}${CITE}</blockquote>`).doc)).toContain('— How small teams plan');
    const nested = conv(own(`<div>Small teams.</div><ul><li>${CITE}</li></ul>`)).doc;
    expect(quoteIn(nested).attrs).toMatchObject({ sourceItem: ID, sourceTitle: null });
    expect(textOf(nested)).toBe('Small teams.— How small teams plan');
  });

  it('a sourced quote inside a sourced quote: the outer passage does not hold the inner cite line', () => {
    const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
    const inner = quote(`--kosko-quote-source:${OTHER}`, '<div>b</div><div style="--kosko-quote-cite:1">— <a href="https://example.com/in">In</a></div>');
    const { doc } = conv(own(`<div>a</div>${inner}<div>c</div>${CITE}`));
    const [outer, nested] = nodesOf(doc, 'blockquote');
    expect(outer.attrs).toMatchObject({ sourceItem: ID, sourceExact: 'a b c', sourceTitle: 'How small teams plan' });
    expect(nested.attrs).toMatchObject({ sourceItem: OTHER, sourceExact: 'b', sourceTitle: 'In', sourceUrl: 'https://example.com/in' });
    expect(textOf(doc)).toBe('abc');
  });

  it('a plain quote inside a sourced quote keeps its cite-like line, and the outer passage holds it (its words are in the note)', () => {
    const inner = '<blockquote><div>b</div><div style="--kosko-quote-cite:1">— <a href="https://example.com/in">In</a></div></blockquote>';
    const { doc } = conv(own(`<div>a</div>${inner}${CITE}`));
    expect(nodesOf(doc, 'blockquote')[0].attrs.sourceExact).toBe('a b — In');
    expect(textOf(doc)).toBe('ab— In');
  });

  it('0.6.1: a link whose text is its own address is a source with no title; the line is still consumed', () => {
    const address = 'https://example.com/teams?a=1';
    for (const shown of [address, `\n  ${address}  \n`]) {
      const { doc } = conv(own(`${LINES}<div style="--kosko-quote-cite:1">— <a href="https://example.com/teams?a=1">${shown.replace('&', '&amp;')}</a></div>`));
      const q = quoteIn(doc);
      expect(q.attrs).toMatchObject({ sourceItem: ID, sourceTitle: null, sourceUrl: address });
      expect(q.content).toHaveLength(2);
      expect(textOf(doc)).toBe('Small teams plan in pairs.They review on Friday.');
      expect(links(doc)).toEqual([]);
    }
  });

  it('0.6.1: a long address shown cut to the title limit is no title either', () => {
    const address = `https://example.com/${'p'.repeat(280)}`;
    expect(address).toHaveLength(300);
    const { doc } = conv(own(`${LINES}<div style="--kosko-quote-cite:1">— <a href="${address}">${address.slice(0, 200)}</a></div>`));
    expect(quoteIn(doc).attrs).toMatchObject({ sourceTitle: null, sourceUrl: address });
    expect(quoteIn(doc).content).toHaveLength(2);
  });

  it('0.6.1: a title that only begins like the address, or continues past it, is a title', () => {
    const address = `https://example.com/${'p'.repeat(280)}`;
    for (const title of ['https://example.com', address.slice(0, 199), address.slice(0, 150), 'https://example.com/pp and what it says', 'HTTPS://EXAMPLE.COM/teams']) {
      const { doc } = conv(own(`${LINES}<div style="--kosko-quote-cite:1">— <a href="${title.startsWith('HTTPS') ? 'https://example.com/teams' : address}">${title}</a></div>`));
      expect(quoteIn(doc).attrs.sourceTitle, title).toBe(title);
    }
  });

  it('whitespace around the dash and the link is not a different shape (benign path)', () => {
    const { doc } = conv(own(`${LINES}<div style="--kosko-quote-cite:1">\n  —\u00a0<a href="https://example.com/teams">How small teams plan</a>\n</div>\n`));
    expect(quoteIn(doc).attrs).toMatchObject({ sourceTitle: 'How small teams plan', sourceUrl: 'https://example.com/teams' });
  });
});
