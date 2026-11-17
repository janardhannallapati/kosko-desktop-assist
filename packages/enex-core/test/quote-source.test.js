// Kosko 742 (the contract) and 743 (this release): the value rules of a quote's source.
//
// A sourced quote stores nine values. Each is read through one pure rule that returns the cleaned value or
// null, never throws and never repairs. The rules run where a value enters (HTML parse, the Evernote
// converter) and again where it leaves (HTML render), because a stored note is JSON a client wrote.
import { describe, it, expect } from 'vitest';
import {
  QUOTE_SOURCE_ATTRS, QUOTE_SOURCE_DATA, SOURCE_TITLE_MAX, SOURCE_URL_MAX, SOURCE_EXACT_MAX, SOURCE_EXACT_HALF,
  SOURCE_CONTEXT_MAX, SOURCE_START_MAX, SOURCE_PAGE_MAX, SOURCE_LENGTH_MAX,
  quoteSourceItem, quoteSourceTitle, quoteSourcePassage, quoteSourceExact, quoteSourceCut,
  quoteSourcePrefix, quoteSourceSuffix, quoteSourceStart, quoteSourcePage, quoteSourceLength
} from '../src/index.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';
const HOSTILE = [null, undefined, 7, true, {}, [], [ID], { toString: () => ID }, new String(ID), Symbol.iterator, () => ID, NaN];

describe('the fixed names and bounds', () => {
  it('names ten attributes, each with its data-* name', () => {
    expect(QUOTE_SOURCE_ATTRS).toEqual(['sourceItem', 'sourceTitle', 'sourceUrl', 'sourceExact', 'sourceCut', 'sourcePrefix', 'sourceSuffix', 'sourceStart', 'sourcePage', 'sourceLength']);
    expect(QUOTE_SOURCE_DATA).toEqual({
      sourceItem: 'data-source-item', sourceTitle: 'data-source-title', sourceUrl: 'data-source-url',
      sourceExact: 'data-source-exact', sourceCut: 'data-source-cut', sourcePrefix: 'data-source-prefix',
      sourceSuffix: 'data-source-suffix', sourceStart: 'data-source-start', sourcePage: 'data-source-page',
      sourceLength: 'data-source-length'
    });
    expect(Object.isFrozen(QUOTE_SOURCE_ATTRS) && Object.isFrozen(QUOTE_SOURCE_DATA)).toBe(true);
  });

  it('exports the bounds of doc 742', () => {
    expect([SOURCE_TITLE_MAX, SOURCE_URL_MAX, SOURCE_EXACT_MAX, SOURCE_EXACT_HALF, SOURCE_CONTEXT_MAX, SOURCE_START_MAX, SOURCE_PAGE_MAX, SOURCE_LENGTH_MAX])
      .toEqual([200, 2000, 1000, 500, 32, 10_000_000, 100_000, 1_000_000]);
  });
});

describe('quoteSourceItem: a lower-case uuid, else null', () => {
  it('keeps a lower-case uuid as it is', () => {
    expect(quoteSourceItem(ID)).toBe(ID);
    expect(quoteSourceItem('018f4e2a-7b3c-7d1e-9f00-aabbccddeeff')).toBe('018f4e2a-7b3c-7d1e-9f00-aabbccddeeff');
  });

  it.each([
    ['upper case', ID.toUpperCase()],
    ['one upper-case letter', ID.replace('f', 'F')],
    ['braces', `{${ID}}`],
    ['a urn', `urn:uuid:${ID}`],
    ['no hyphens', ID.replaceAll('-', '')],
    ['a line break after it', `${ID}\n`],
    ['a space before it', ` ${ID}`],
    ['the nil uuid', '00000000-0000-0000-0000-000000000000'],
    ['a variant that is not RFC 4122', '3f2b8c1e-9a4d-4e7b-7c21-5d6f7a8b9c0d'],
    ['one character short', ID.slice(0, -1)],
    ['a style after it', `${ID}; background:url(x)`],
    ['the empty string', ''],
    ['__proto__', '__proto__']
  ])('refuses %s', (_name, value) => {
    expect(quoteSourceItem(value)).toBeNull();
  });

  it('refuses everything that is not a string, without throwing', () => {
    for (const bad of HOSTILE) expect(quoteSourceItem(bad)).toBeNull();
  });
});

describe('quoteSourceTitle: one line, at most 200 units', () => {
  it('evens out whitespace and line breaks', () => {
    expect(quoteSourceTitle('  How  small\n teams\tplan ')).toBe('How small teams plan');
    expect(quoteSourceTitle('చిన్న బృందాలు ఎలా ప్రణాళిక వేస్తాయి')).toBe('చిన్న బృందాలు ఎలా ప్రణాళిక వేస్తాయి');
  });

  it('is null when blank or not a string', () => {
    for (const bad of ['', '   ', '\n\t', ...HOSTILE]) expect(quoteSourceTitle(bad)).toBeNull();
  });

  it('keeps 200 units and cuts the 201st', () => {
    expect(quoteSourceTitle('a'.repeat(200))).toHaveLength(200);
    expect(quoteSourceTitle('a'.repeat(201))).toBe('a'.repeat(200));
    expect(quoteSourceTitle('a'.repeat(1_000_000))).toHaveLength(200);
  });

  it('takes out control characters and the bidi overrides that could dress a title up as something else', () => {
    expect(quoteSourceTitle('safe\u0000 title\u0007')).toBe('safe title');
    expect(quoteSourceTitle('invoice\u202egnp.exe')).toBe('invoicegnp.exe');
    expect(quoteSourceTitle('a\u2066b\u2069c\u202ad\u202c')).toBe('abcd');
    expect(quoteSourceTitle('\u202e\u0001')).toBeNull();
    // Joiners are letters' business in Indic scripts and are kept.
    expect(quoteSourceTitle('క్\u200cష')).toBe('క్\u200cష');
  });

  // 0.6.1: Kosko's Evernote exporter strips what XML 1.0 cannot hold before it writes (`stripIllegal` in
  // lib/export/enml-filter.js). The title rule takes the same characters out, so a stored title is already
  // what comes back from a file.
  const stripIllegal = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

  it('takes out half a surrogate pair and U+FFFE / U+FFFF, which an Evernote file cannot hold (0.6.1)', () => {
    expect(quoteSourceTitle('a\ud800b')).toBe('ab');
    expect(quoteSourceTitle('a\udc00b')).toBe('ab');
    expect(quoteSourceTitle('\udc00\ud800 back to front')).toBe('back to front');
    expect(quoteSourceTitle('a\ufffeb\uffffc')).toBe('abc');
    expect(quoteSourceTitle('\ud800\ufffe')).toBeNull();
    // A whole pair is a letter and stays.
    expect(quoteSourceTitle('ok 😀 \ud83d\ude00 done')).toBe('ok 😀 😀 done');
  });

  it('a title that passed the rule is unchanged by the exporter\'s strip: it reads back the same after a round trip', () => {
    const hostile = ['a\ud800b', '\udc00x', 'x\ud83d', 't\ufffe\uffff', 'a\u0000b\u0008c\u000bd\u001fe', '😀\ud800😀', 'tab\there', `${'a'.repeat(199)}\ud800😀`, 'plain title'];
    for (const raw of hostile) {
      const title = quoteSourceTitle(raw);
      expect(stripIllegal(title), JSON.stringify(raw)).toBe(title);
      expect(quoteSourceTitle(stripIllegal(title)), JSON.stringify(raw)).toBe(title);
      expect(title.isWellFormed(), JSON.stringify(raw)).toBe(true);
    }
  });

  it('never splits a surrogate pair at the cut', () => {
    const cut = quoteSourceTitle(`${'a'.repeat(199)}😀 tail`);
    expect(cut).toBe('a'.repeat(199));
    expect(cut.isWellFormed()).toBe(true);
    expect(quoteSourceTitle(`${'a'.repeat(198)}😀 tail`)).toBe(`${'a'.repeat(198)}😀`);
  });
});

describe('quoteSourcePassage / quoteSourceExact: the passage, spaces evened out, at most 1,000 units', () => {
  it('evens out whitespace', () => {
    expect(quoteSourcePassage('  Small teams\n\nplan   in pairs. ')).toEqual({ exact: 'Small teams plan in pairs.', cut: false });
    expect(quoteSourceExact('ఉదయం  ఆరు\nగంటలకు')).toBe('ఉదయం ఆరు గంటలకు');
  });

  it('is null when blank or not a string', () => {
    for (const bad of ['', '  \n ', ...HOSTILE]) {
      expect(quoteSourcePassage(bad)).toBeNull();
      expect(quoteSourceExact(bad)).toBeNull();
    }
  });

  it('keeps 1,000 units whole', () => {
    const whole = 'a'.repeat(1000);
    expect(quoteSourcePassage(whole)).toEqual({ exact: whole, cut: false });
  });

  it('a longer passage keeps its first 500 and its last 500, and says it was cut', () => {
    const { exact, cut } = quoteSourcePassage('a'.repeat(600) + 'b'.repeat(600));
    expect(cut).toBe(true);
    expect(exact).toBe('a'.repeat(500) + 'b'.repeat(500));
    expect(quoteSourcePassage('a'.repeat(1001)).cut).toBe(true);
  });

  it('never splits a surrogate pair at either side of the cut', () => {
    const head = quoteSourcePassage(`${'x'.repeat(499)}😀${'y'.repeat(700)}`).exact;
    expect(head).toBe('x'.repeat(499) + 'y'.repeat(500));
    const tail = quoteSourcePassage(`${'x'.repeat(700)}😀${'y'.repeat(499)}`).exact;
    expect(tail).toBe('x'.repeat(500) + 'y'.repeat(499));
    expect(head.isWellFormed() && tail.isWellFormed()).toBe(true);
  });

  it('a cut passage read again is unchanged (the rule runs on the way in and out)', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const once = quoteSourcePassage(long);
    expect(once.cut).toBe(true);
    expect(once.exact.length).toBeLessThanOrEqual(SOURCE_EXACT_MAX);
    expect(once.exact.length).toBeGreaterThanOrEqual(SOURCE_EXACT_MAX - 4);
    expect(quoteSourcePassage(once.exact)).toEqual({ exact: once.exact, cut: false });
  });

  it('holds a 1,000,000-character passage to 1,000', () => {
    expect(quoteSourceExact('ab '.repeat(350_000))).toHaveLength(1000);
  });
});

describe('quoteSourceCut: true only beside a length that says the passage was longer than the limit', () => {
  const cutExact = quoteSourceExact('a'.repeat(600) + 'b'.repeat(600));

  it('is true for the flag beside a length over 1,000, as a boolean or as the attribute text', () => {
    expect(quoteSourceCut(true, cutExact, 1200)).toBe(true);
    expect(quoteSourceCut('true', cutExact, '1200')).toBe(true);
    expect(quoteSourceCut(true, cutExact, 1001)).toBe(true);
  });

  it('is true when the passage itself had to be cut just now, beside such a length', () => {
    expect(quoteSourceCut(null, 'a'.repeat(1001), 1001)).toBe(true);
  });

  it('is null without a valid length: a cut passage with no length cannot be placed', () => {
    for (const length of [undefined, null, '', 'x', '5e3', -1200, 1200.5, 1_000_001]) {
      expect(quoteSourceCut(true, cutExact, length), String(length)).toBeNull();
      expect(quoteSourceCut(null, 'a'.repeat(1001), length), String(length)).toBeNull();
    }
  });

  it('is null beside a length of 1,000 or less: that passage was stored whole', () => {
    expect(quoteSourceCut(true, cutExact, 1000)).toBeNull();
    expect(quoteSourceCut(true, 'two words', 9)).toBeNull();
  });

  it('is null beside a passage too short to be the two ends of a cut one, whatever the length says', () => {
    // A real cut keeps 500 + 500 units, less at most one each side for a surrogate pair and one each for a
    // space at the cut: 996 to 1,000. A shorter passage with the flag would match with anything between.
    expect(quoteSourceCut(true, 'hello world', 1011)).toBeNull();
    expect(quoteSourceCut(true, 'x'.repeat(995), 1200)).toBeNull();
    expect(quoteSourceCut(true, 'x'.repeat(996), 1200)).toBe(true);
    expect(quoteSourceCut(true, 'x'.repeat(1000), 1200)).toBe(true);
  });

  it('is null for any other flag, and with no passage', () => {
    for (const flag of [null, undefined, false, 'false', 'yes', '1', 1, {}, []]) expect(quoteSourceCut(flag, cutExact, 1200)).toBeNull();
    expect(quoteSourceCut(true, null, 1200)).toBeNull();
    expect(quoteSourceCut(true, {}, 1200)).toBeNull();
  });
});

describe('quoteSourcePrefix / quoteSourceSuffix: up to 32 units of the words around the passage', () => {
  it('keeps short text, a single space at either end included', () => {
    expect(quoteSourcePrefix('the end. ')).toBe('the end. ');
    expect(quoteSourceSuffix(' Then they')).toBe(' Then they');
    expect(quoteSourcePrefix('a \n b')).toBe('a b');
  });

  it('a prefix keeps the 32 units nearest the passage: its last', () => {
    const long = `${'x'.repeat(40)}0123456789abcdef0123456789abcdef`;
    expect(quoteSourcePrefix(long)).toBe('0123456789abcdef0123456789abcdef');
  });

  it('a suffix keeps the 32 units nearest the passage: its first', () => {
    const long = `0123456789abcdef0123456789abcdef${'x'.repeat(40)}`;
    expect(quoteSourceSuffix(long)).toBe('0123456789abcdef0123456789abcdef');
  });

  it('never keeps half a surrogate pair', () => {
    const prefix = quoteSourcePrefix(`😀${'a'.repeat(31)}`);
    expect(prefix).toBe('a'.repeat(31));
    const suffix = quoteSourceSuffix(`${'a'.repeat(31)}😀`);
    expect(suffix).toBe('a'.repeat(31));
  });

  it('is null when empty or not a string', () => {
    for (const bad of ['', ...HOSTILE]) {
      expect(quoteSourcePrefix(bad)).toBeNull();
      expect(quoteSourceSuffix(bad)).toBeNull();
    }
  });
});

describe('quoteSourceStart and quoteSourcePage: bounded whole numbers', () => {
  it('start: 0 to 10,000,000, from a number or digits', () => {
    expect(quoteSourceStart(0)).toBe(0);
    expect(quoteSourceStart(1280)).toBe(1280);
    expect(quoteSourceStart('1280')).toBe(1280);
    expect(quoteSourceStart('0')).toBe(0);
    expect(quoteSourceStart(SOURCE_START_MAX)).toBe(10_000_000);
    expect(quoteSourceStart('10000000')).toBe(10_000_000);
    expect(Object.is(quoteSourceStart(-0), 0)).toBe(true);
  });

  it('page: 1 to 100,000, from a number or digits', () => {
    expect(quoteSourcePage(1)).toBe(1);
    expect(quoteSourcePage('12')).toBe(12);
    expect(quoteSourcePage(SOURCE_PAGE_MAX)).toBe(100_000);
  });

  const NOT_NUMBERS = ['5e1', '0x32', '-3', '+3', '1.0', '1.5', ' 5', '5 ', '', '007', '5px', '٥', '１２', 1.5, -1, NaN, Infinity, -Infinity, true, null, undefined, [5], {}, { valueOf: () => 5 }, 5n];

  it('start refuses everything else', () => {
    for (const bad of [...NOT_NUMBERS, 10_000_001, '10000001', '99999999999999999999']) expect(quoteSourceStart(bad), String(bad)).toBeNull();
  });

  it('length: 1 to 1,000,000, from a number or digits, and nothing else', () => {
    expect(quoteSourceLength(1)).toBe(1);
    expect(quoteSourceLength('26')).toBe(26);
    expect(quoteSourceLength(SOURCE_LENGTH_MAX)).toBe(1_000_000);
    for (const bad of [...NOT_NUMBERS, 0, '0', 1_000_001, '1000001']) expect(quoteSourceLength(bad), String(bad)).toBeNull();
  });

  it('page refuses everything else, and 0', () => {
    for (const bad of [...NOT_NUMBERS, 0, '0', 100_001, '100001']) expect(quoteSourcePage(bad), String(bad)).toBeNull();
  });
});
