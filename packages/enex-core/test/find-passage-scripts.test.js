// Kosko 742 / 743: finding a passage in Indic text, on whole letters only, and in a very long source.
//
// A match must begin and end where a letter begins and ends (a grapheme boundary), so a Telugu base letter
// is not "found" inside the base letter and its vowel sign. And the search is a linear scan, never a pattern
// built from the words, so a long or hostile source cannot stall it.
import { describe, it, expect } from 'vitest';
import { anchorText, makeAnchor, findPassage, PASSAGE_PLACES_MAX } from '../src/index.js';
import { foldText } from '../src/anchor/passage-fold.js';

const NOT_FOUND = { found: false };

describe('Telugu, Hindi and Kannada passages', () => {
  const source = anchorText([
    'అరకు లోయకు ఉదయం ఆరు గంటలకు బయలుదేరాలి. దారిలో కాఫీ తోటలు కనిపిస్తాయి.',
    'बारिश में रास्ता फिसलन भरा होता है। धीरे चलना चाहिए।',
    'ಮಳೆಯಲ್ಲಿ ದಾರಿ ಜಾರುತ್ತದೆ. ನಿಧಾನವಾಗಿ ನಡೆಯಬೇಕು.'
  ].join('\n'));

  it.each(['ఉదయం ఆరు గంటలకు బయలుదేరాలి', 'रास्ता फिसलन भरा होता है।', 'ದಾರಿ ಜಾರುತ್ತದೆ. ನಿಧಾನವಾಗಿ'])('finds "%s" at its hint and after the source grew', (words) => {
    const start = source.indexOf(words);
    const anchor = makeAnchor(source, start, start + words.length);
    expect(anchor.sourceExact).toBe(words);
    expect(findPassage(source, anchor)).toEqual({ found: true, start, end: start + words.length, by: 'hint' });
    const grown = `కొత్త పేరా.\n${source}`;
    const found = findPassage(grown, anchor);
    expect(found.by).toBe('search');
    expect(grown.slice(found.start, found.end)).toBe(words);
  });

  it('a changed vowel sign is a different word: not found', () => {
    const anchor = { sourceExact: 'ఉదయం ఆరు గంటలకు' };
    expect(findPassage(source, anchor).found).toBe(true);
    expect(findPassage(source.replace('గంటలకు', 'గంటలకి'), anchor)).toEqual(NOT_FOUND);
  });
});

describe('a match begins and ends on a whole letter', () => {
  it('a Telugu base letter is not found inside the letter and its vowel sign', () => {
    const text = 'కి కా క';
    expect(findPassage(text, { sourceExact: 'క' })).toEqual({ found: true, start: 6, end: 7, by: 'search' });
    expect(findPassage('కి కా', { sourceExact: 'క' })).toEqual(NOT_FOUND);
  });

  it('a hint that points inside a letter is not believed', () => {
    expect(findPassage('కి కా క', { sourceExact: 'క', sourceStart: 0 })).toEqual({ found: true, start: 6, end: 7, by: 'search' });
  });

  it('a vowel sign alone is not found after its base letter', () => {
    expect(findPassage('కి', { sourceExact: '\u0c3f' })).toEqual(NOT_FOUND);
  });

  it('Hindi and Kannada: the same rule', () => {
    expect(findPassage('कि', { sourceExact: 'क' })).toEqual(NOT_FOUND);
    expect(findPassage('ಕಿ', { sourceExact: 'ಕ' })).toEqual(NOT_FOUND);
    expect(findPassage('कि क', { sourceExact: 'क' }).start).toBe(3);
  });

  it('an accent written as a separate mark, and one person of a joined emoji, are not found alone', () => {
    expect(findPassage('cafe\u0301 menu', { sourceExact: 'cafe' })).toEqual(NOT_FOUND);
    expect(findPassage('a 👩\u200d👩\u200d👧 b', { sourceExact: '👩' })).toEqual(NOT_FOUND);
    expect(findPassage('a 👩\u200d👩\u200d👧 b', { sourceExact: '👩\u200d👩\u200d👧' })).toEqual({ found: true, start: 2, end: 10, by: 'search' });
  });

  it('whole letters are found (benign path)', () => {
    expect(findPassage('కి కా క', { sourceExact: 'కి' })).toEqual({ found: true, start: 0, end: 2, by: 'search' });
    expect(findPassage('Windows\r\nlines', { sourceExact: 'lines' })).toEqual({ found: true, start: 9, end: 14, by: 'search' });
  });
});

describe('what it answers always holds the quoted words', () => {
  it('for 300 passages picked from a changing text, the place found folds to the same words', () => {
    let seed = 42;
    const next = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const WORDS = ['Small', 'teams', 'plan', '—', 'in', 'pairs…', '“ship”', 'it’s', 'ఉదయం', 'గంటలకు', 'कि', 'रास्ता', 'ಕಿ', 'ದಾರಿ', 'on', 'Friday.', '😀', 'x'];
    const text = anchorText(Array.from({ length: 4000 }, () => WORDS[next(WORDS.length)]).join(' '));
    for (let i = 0; i < 300; i += 1) {
      const start = 200 + next(text.length - 300);
      const anchor = makeAnchor(text, start, start + 1 + next(70));
      if (!anchor) continue;
      const changed = text.slice(next(200));
      const found = findPassage(changed, i % 2 ? anchor : { ...anchor, sourcePrefix: null, sourceSuffix: null, sourceStart: null });
      expect(found.found, anchor.sourceExact).toBe(true);
      expect(foldText(changed.slice(found.start, found.end)).folded).toBe(foldText(anchor.sourceExact).folded);
    }
  });
});

// No wall-clock limit: a loaded CI runner would fail one for no fault of the code. Each case is run at two
// sizes, and the larger (four times the text) must not take much more than four times as long. A search that
// was quadratic takes sixteen times; the allowance is ten, over a floor that keeps tiny timings from deciding.
describe('a very long source: the work grows with the text, not faster', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog near the river bank. ';
  const passage = 'ఒక్కసారి మాత్రమే కనిపించే వాక్యం, only once in a million characters.';
  const prose = (size) => `${sentence.repeat(Math.ceil(size / sentence.length))}${passage} ${sentence.repeat(20)}`;
  const letters = (size) => 'a'.repeat(size);
  const best = (fn) => Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  }));
  const SMALL = 250_000;
  const BIG = 1_000_000;

  it('finds one passage near the end of 1,000,000 characters, with and without a hint', () => {
    const big = prose(BIG);
    expect(big.length).toBeGreaterThan(BIG);
    const start = big.indexOf(passage);
    expect(findPassage(big, { sourceExact: passage })).toEqual({ found: true, start, end: start + passage.length, by: 'search' });
    expect(findPassage(big, { sourceExact: passage, sourceStart: start }).by).toBe('hint');
  });

  it('chooses the place nearest the hint among 15,000 holding the same words', () => {
    const found = findPassage(prose(BIG), { sourceExact: 'over the lazy dog', sourceStart: 500_000 });
    expect(found.found).toBe(true);
    expect(Math.abs(found.start - 500_000)).toBeLessThan(sentence.length);
  });

  it.each([
    ['one passage in prose', prose, () => ({ sourceExact: passage }), true],
    ['thousands of places holding the same words', prose, () => ({ sourceExact: 'over the lazy dog', sourceStart: 99_999 }), true],
    ['hostile: one repeated letter, and words that almost match everywhere', letters, () => ({ sourceExact: `${'a'.repeat(999)}b` }), false],
    ['hostile: the words stand at every position', letters, () => ({ sourceExact: 'a'.repeat(1000), sourcePrefix: 'a'.repeat(32), sourceSuffix: 'a'.repeat(32) }), true],
    ['hostile: every place ends inside a letter', (size) => 'కి'.repeat(size / 2), () => ({ sourceExact: 'క' }), false],
    ['hostile: a cut anchor whose beginning stands at every position', letters, () => ({ sourceExact: 'a'.repeat(1000), sourceCut: true, sourceLength: 5000 }), true]
  ])('%s', (_name, build, anchor, found) => {
    const small = build(SMALL);
    const big = build(BIG);
    expect(findPassage(big, anchor()).found).toBe(found);
    const smallMs = best(() => findPassage(small, anchor()));
    const bigMs = best(() => findPassage(big, anchor()));
    expect(bigMs).toBeLessThan(Math.max(smallMs, 20) * 10);
  }, 60000);
});

describe('the limit on places tested for whole letters', () => {
  it('is exported, and is 10,000', () => {
    expect(PASSAGE_PLACES_MAX).toBe(10_000);
  });

  it('a place within the limit is found; one past it is not (it fails closed, never to a wrong place)', () => {
    const within = `${'కి '.repeat(PASSAGE_PLACES_MAX - 1)}క`;
    expect(findPassage(within, { sourceExact: 'క' })).toEqual({ found: true, start: within.length - 1, end: within.length, by: 'search' });
    const past = `${'కి '.repeat(PASSAGE_PLACES_MAX)}క`;
    expect(findPassage(past, { sourceExact: 'క' })).toEqual(NOT_FOUND);
  });

  it('the words around the passage or a hint bring the real place inside the limit', () => {
    const past = `${'కి '.repeat(PASSAGE_PLACES_MAX)}క`;
    expect(findPassage(past, { sourceExact: 'క', sourceStart: past.length - 4 }).start).toBe(past.length - 1);
  });
});

describe('every anchor makeAnchor gives is found again, in the same place', () => {
  it('for 2,000 selections over an alphabet of marks, joiners, conjuncts, flags and evened-out characters', () => {
    let seed = 7;
    const next = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const ALPHABET = ['a', 'B', ' ', ' ', '\n', '\u0301', 'క', 'ి', '్', 'ష', '\u200d', '\u200c', '👩', '👧', '🇮', '🇳', '…', '“', '—', 'é', 'ಕ', '್', 'ಷ', 'क', '्', 'ष', 'ि', 'த', '்', '\ufe0f', '.'];
    const text = anchorText(Array.from({ length: 3000 }, () => ALPHABET[next(ALPHABET.length)]).join(''));
    let made = 0;
    for (let i = 0; i < 2000; i += 1) {
      const start = next(text.length - 50);
      const anchor = makeAnchor(text, start, start + 1 + next(40));
      if (!anchor) continue;
      made += 1;
      const found = findPassage(text, anchor);
      expect(found, JSON.stringify([start, anchor.sourceExact])).toEqual({ found: true, start: anchor.sourceStart, end: anchor.sourceStart + anchor.sourceLength, by: 'hint' });
      // And without its hint or its context it is still found somewhere, holding the same words.
      if (i % 10 === 0) expect(findPassage(text, { sourceExact: anchor.sourceExact }).found).toBe(true);
    }
    expect(made).toBeGreaterThan(1200);
  }, 30000);
});
