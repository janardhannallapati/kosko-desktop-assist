// Kosko 743, review M1: where one letter ends and the next begins, by ONE hand-written rule on every runtime.
//
// The web has `Intl.Segmenter`; the phone's runtime may not, and the two must give the same answer for the
// same quote. Segmenters also differ by Unicode version (Kannada conjuncts split under ICU 75). So the
// package does not use a segmenter at all. Its rule is deliberately a little STRICTER than the standard
// (it never says "between letters" where the standard says "inside one"), which is the safe side: a passage
// can fail to be found, it cannot be found in half a letter.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isLetterBoundary } from '../src/anchor/letter-boundary.js';
import { findPassage, makeAnchor } from '../src/index.js';

const boundaries = (text) => Array.from({ length: text.length + 1 }, (_, at) => at).filter((at) => isLetterBoundary(text, at));

describe('isLetterBoundary: the rule, case by case', () => {
  it.each([
    ['plain letters', 'abc', [0, 1, 2, 3]],
    ['a surrogate pair', 'a😀b', [0, 1, 3, 4]],
    ['a carriage return and its line feed', 'a\r\nb', [0, 1, 3, 4]],
    ['a letter and a combining accent', 'e\u0301x', [0, 2, 3]],
    ['Telugu: a base letter and its vowel sign', 'కిక', [0, 2, 3]],
    ['Telugu: consonant, virama, consonant (a conjunct)', 'క్ష', [0, 3]],
    ['Telugu: రాక్షసుడు', 'రాక్షసుడు', [0, 2, 5, 7, 9]],
    ['Devanagari: क्ष and a vowel sign', 'क्षि', [0, 4]],
    ['Kannada: ಕ್ಷ', 'ಕ್ಷ', [0, 3]],
    ['Malayalam: ക്ഷ', 'ക്ഷ', [0, 3]],
    ['Bengali: ক্ষ', 'ক্ষ', [0, 3]],
    ['Gujarati: ક્ષ', 'ક્ષ', [0, 3]],
    ['Gurmukhi: ਪ੍ਰ', 'ਪ੍ਰ', [0, 3]],
    ['Odia: କ୍ଷ', 'କ୍ଷ', [0, 3]],
    ['a three-consonant conjunct', 'स्त्र', [0, 5]],
    ['a virama at the end of a word, then a space', 'क् क', [0, 2, 3, 4]],
    ['a virama, then a letter of another script', 'క్a', [0, 2, 3]],
    ['a virama, then a digit of the same script: no conjunct', 'క్౧', [0, 2, 3]],
    ['Tamil: the pulli is a visible mark, the next consonant is its own letter', 'க்க', [0, 2, 3]],
    ['a joiner keeps both sides together', 'క్\u200dష', [0, 4]],
    ['a non-joiner between them changes how it is drawn, not where it may be cut', 'క్\u200cష', [0, 4]],
    ['a joined emoji', '👩\u200d👩\u200d👧', [0, 8]],
    ['an emoji and its variation selector', '❤\ufe0fa', [0, 2, 3]],
    ['an emoji and a skin tone', '👍🏽a', [0, 4, 5]],
    ['one flag (two regional indicators)', '🇮🇳', [0, 4]],
    ['two flags', '🇮🇳🇺🇸', [0, 4, 8]],
    ['three regional indicators: a flag and one left over', '🇮🇳🇺', [0, 4, 6]],
    ['Malayalam dot reph belongs to the letter after it', '\u0d4eക', [0, 2]],
    ['68 regional indicators in a row: flags are whole up to 64 of them; past that, no place in the run is between letters', '🇮'.repeat(68) + 'a', [...Array.from({ length: 33 }, (_, n) => n * 4), 136, 137]],
    ['Thai sara am joins the letter before it', 'นำ', [0, 2]],
    ['a mark after a space or a line break joins nothing useful, and is not a place to begin', 'a \u0301\n\u0301', [0, 1, 3, 5]]
  ])('%s', (_name, text, expected) => {
    expect(boundaries(text)).toEqual(expected);
  });

  it('the ends of the text are always boundaries, and a place outside it is one too (nothing to split)', () => {
    expect(isLetterBoundary('', 0)).toBe(true);
    expect(isLetterBoundary('\u0301', 0)).toBe(true);
    expect(isLetterBoundary('క', 1)).toBe(true);
    expect(isLetterBoundary('abc', -1)).toBe(true);
    expect(isLetterBoundary('abc', 99)).toBe(true);
  });

  it('a very long run of regional indicators is answered without reading all of it', () => {
    const flags = '🇮🇳'.repeat(200_000);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i += 1) isLetterBoundary(flags, flags.length - 4 * i - 2);
    // 2,000 questions near the end of 800,000 units: reading back to the start each time would be 400,000,000 steps.
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(isLetterBoundary(flags, 4)).toBe(true);
    expect(isLetterBoundary(flags, 2)).toBe(false);
  });
});

describe('never looser than the standard: every boundary of ours is one of Intl.Segmenter\'s', () => {
  const CORPUS = [
    'రాక్షసుడు అరకు లోయకు ఉదయం ఆరు గంటలకు బయలుదేరాలి. కృష్ణా, శ్రీ, స్త్రీ, జ్ఞానం',
    'बारिश में रास्ता फिसलन भरा होता है। क्षत्रिय, ज्ञान, श्री, स्त्री, कि, हूँ, क़',
    'ಮಳೆಯಲ್ಲಿ ದಾರಿ ಜಾರುತ್ತದೆ. ಕ್ಷಮಿಸಿ, ಜ್ಞಾನ, ಸ್ತ್ರೀ, ರಾಷ್ಟ್ರ',
    'தமிழ் பள்ளிக்கூடம் அக்கா ஸ்ரீ', 'മലയാളം ക്ഷമിക്കണം ന്റ', 'বাংলা ক্ষমা স্ত্রী', 'ગુજરાતી ક્ષમા', 'ਪੰਜਾਬੀ ਪ੍ਰੇਮ', 'ଓଡ଼ିଆ କ୍ଷମା',
    'cafe\u0301 e\u0301\u0302 a\r\nb 👩\u200d👩\u200d👧 👍🏽 ❤\ufe0f 🇮🇳🇺🇸 🏴\u{e0067}\u{e0062}\u{e007f}',
    'ภาษาไทย น้ำ กำ', 'క్\u200cష క్\u200dష', 'plain ascii, with punctuation... and “quotes” — dashes'
  ];

  it('holds on Telugu, Hindi, Kannada, Tamil, Malayalam, Bengali, Gujarati, Punjabi, Odia, Thai, accents, emoji and flags', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const text of CORPUS) {
      const standard = new Set([...segmenter.segment(text)].map((s) => s.index).concat(text.length));
      const loose = boundaries(text).filter((at) => !standard.has(at));
      expect(loose, text).toEqual([]);
    }
  });

  it('and is stricter in exactly the places it means to be: a conjunct this ICU splits is kept whole', () => {
    expect(boundaries('ಕ್ಷ')).toEqual([0, 3]);
    expect(boundaries('క్\u200dష')).toEqual([0, 4]);
  });
});

describe('the answer does not depend on Intl.Segmenter being there', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const CASES = [
    ['రాక్షసుడు', 'రాక్'], ['రాక్షసుడు', 'రా'], ['రాక్షసుడు', 'క్ష'], ['क्ष', 'क'], ['क्ष क', 'क'], ['ಕ್ಷ', 'ಕ್'], ['ಕ್ಷ ಕ', 'ಕ'],
    ['🇮🇳', '🇮'], ['🇮🇳🇺🇸', '🇳🇺'], ['🇮🇳🇺🇸', '🇺🇸'], ['👩\u200d👩\u200d👧', '👩'], ['కి కా క', 'క'], ['cafe\u0301 menu', 'cafe'],
    ['అరకు లోయకు ఉదయం', 'లోయకు'], ['बारिश में फिसलन', 'में'], ['ಮಳೆಯಲ್ಲಿ ದಾರಿ', 'ದಾರಿ']
  ];
  const answers = (find, make) => CASES.map(([text, words]) => [find(text, { sourceExact: words }), make(text, 0, 1)]);

  it('the reviewer\'s cases, with the segmenter present', () => {
    expect(findPassage('రాక్షసుడు', { sourceExact: 'రాక్' })).toEqual({ found: false });
    expect(findPassage('क्ष', { sourceExact: 'क' })).toEqual({ found: false });
    expect(findPassage('ಕ್ಷ', { sourceExact: 'ಕ್' })).toEqual({ found: false });
    expect(findPassage('🇮🇳', { sourceExact: '🇮' })).toEqual({ found: false });
    expect(findPassage('రాక్షసుడు', { sourceExact: 'క్ష' })).toEqual({ found: true, start: 2, end: 5, by: 'search' });
  });

  it('with Intl.Segmenter taken away, and with Intl taken away, every answer is identical', async () => {
    const normal = answers(findPassage, makeAnchor);
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    vi.resetModules();
    const without = await import('../src/index.js');
    expect(typeof Intl.Segmenter).toBe('undefined');
    expect(answers(without.findPassage, without.makeAnchor)).toEqual(normal);
    vi.stubGlobal('Intl', undefined);
    vi.resetModules();
    const bare = await import('../src/index.js');
    expect(answers(bare.findPassage, bare.makeAnchor)).toEqual(normal);
  });

  it('no file of the anchor code names a segmenter outside a comment', () => {
    const dir = new URL('../src/anchor/', import.meta.url).pathname;
    for (const file of readdirSync(dir)) {
      const code = readFileSync(dir + file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/Segmenter|\bIntl\b/);
    }
  });
});
