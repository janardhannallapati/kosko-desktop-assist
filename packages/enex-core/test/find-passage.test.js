// Kosko 742 decision 4 (strict finding) and 743: finding a quoted passage in a source's text.
//
// The same words must be there, after whitespace, case and the typographic forms of quotes, dashes and the
// ellipsis are evened out. The position hint is tried first; then the words are searched for; several places
// are told apart by the words around them, then by nearness to the hint. Anything else is "not found": the
// function never answers with a place whose words differ.
import { describe, it, expect } from 'vitest';
import { anchorText, makeAnchor, findPassage } from '../src/index.js';

const NOT_FOUND = { found: false };
const SOURCE = anchorText([
  'Planning is hard when a team is large, and the end is never in sight.',
  'Small teams plan in pairs. Then they review on Friday, as one group.',
  'The plan is simple. We ship on Friday.',
  'The plan is risky. We ship on Friday.'
].join('\n'));

const span = (text, words, from = 0) => {
  const start = text.indexOf(words, from);
  return [start, start + words.length];
};
const anchorOf = (text, words, from) => makeAnchor(text, ...span(text, words, from));

describe('the hint is tried first', () => {
  it('finds the passage where it was quoted', () => {
    const [start, end] = span(SOURCE, 'Small teams plan in pairs.');
    expect(findPassage(SOURCE, anchorOf(SOURCE, 'Small teams plan in pairs.'))).toEqual({ found: true, start, end, by: 'hint' });
  });

  it('a hint whose words do not match is not believed', () => {
    const anchor = { ...anchorOf(SOURCE, 'Small teams plan in pairs.'), sourceStart: 3 };
    const [start, end] = span(SOURCE, 'Small teams plan in pairs.');
    expect(findPassage(SOURCE, anchor)).toEqual({ found: true, start, end, by: 'search' });
  });

  it('a hint past the end, or one that is not a number, is ignored', () => {
    const [start, end] = span(SOURCE, 'Small teams plan in pairs.');
    for (const hint of [9_999_999, '5e1', -4, null, {}, 1.5]) {
      expect(findPassage(SOURCE, { sourceExact: 'Small teams plan in pairs.', sourceStart: hint })).toEqual({ found: true, start, end, by: 'search' });
    }
  });
});

describe('the words are searched for when the source changed', () => {
  it('finds the passage after text was added before it', () => {
    const anchor = anchorOf(SOURCE, 'Then they review on Friday');
    const changed = `A new opening paragraph.\n${SOURCE}`;
    const [start, end] = span(changed, 'Then they review on Friday');
    expect(findPassage(changed, anchor)).toEqual({ found: true, start, end, by: 'search' });
  });

  it('finds it after text before it was removed', () => {
    const anchor = anchorOf(SOURCE, 'Then they review on Friday');
    const changed = SOURCE.slice(SOURCE.indexOf('\n') + 1);
    const [start, end] = span(changed, 'Then they review on Friday');
    expect(findPassage(changed, anchor)).toEqual({ found: true, start, end, by: 'search' });
  });

  it('a deleted passage is not found', () => {
    const anchor = anchorOf(SOURCE, 'Small teams plan in pairs.');
    expect(findPassage(SOURCE.replace('Small teams plan in pairs. ', ''), anchor)).toEqual(NOT_FOUND);
  });

  it('strict: one changed word is not found', () => {
    const anchor = anchorOf(SOURCE, 'Small teams plan in pairs.');
    expect(findPassage(SOURCE.replace('plan in pairs', 'plan in threes'), anchor)).toEqual(NOT_FOUND);
    expect(findPassage(SOURCE.replace('Small teams', 'Small team'), anchor)).toEqual(NOT_FOUND);
  });

  it('strict: one added or removed letter, digit or symbol is not found', () => {
    const text = 'It cost $1,200 in 2024 (about 4% more).';
    const anchor = { sourceExact: 'cost $1,200 in 2024' };
    expect(findPassage(text, anchor).found).toBe(true);
    for (const other of ['cost $1,300 in 2024', 'cost 1,200 in 2024', 'cost $1200 in 2024', 'cost $1,200 in 2025', 'costs $1,200 in 2024']) {
      expect(findPassage(text, { sourceExact: other }), other).toEqual(NOT_FOUND);
    }
  });
});

describe('what is evened out: whitespace, case, and the forms of quotes, dashes and the ellipsis', () => {
  const quoted = 'She said "small teams" plan - in pairs... and it\'s true';

  it.each([
    ['case', 'she SAID "Small Teams" plan - in pairs... and it\'s TRUE'],
    ['whitespace and line breaks', 'She  said\n"small teams"\u00a0plan -   in pairs... and it\'s true'],
    ['curly quotes and apostrophe', 'She said “small teams” plan - in pairs... and it’s true'],
    ['an en dash, an em dash', 'She said "small teams" plan – in pairs... and it\'s true'],
    ['the ellipsis character', 'She said "small teams" plan - in pairs… and it\'s true'],
    ['all of them together', 'SHE said «small  teams» plan — in pairs… and it’s true']
  ])('a source that differs only in %s is found, and the place is the source\'s own words', (_name, now) => {
    const text = `Before. ${now} After.`;
    const found = findPassage(text, { sourceExact: quoted });
    expect(found).toEqual({ found: true, start: 8, end: 8 + now.length, by: 'search' });
    expect(text.slice(found.start, found.end)).toBe(now);
  });

  it('a punctuation mark added or removed is a different passage', () => {
    for (const now of ['She said small teams plan - in pairs... and it\'s true', 'She said "small teams" plan in pairs... and it\'s true', 'She said, "small teams" plan - in pairs... and it\'s true']) {
      expect(findPassage(now, { sourceExact: quoted }), now).toEqual(NOT_FOUND);
    }
  });

  it('a match never ends part of the way through a character that was evened out', () => {
    expect(findPassage('Wait… really', { sourceExact: 'Wait...' })).toEqual({ found: true, start: 0, end: 5, by: 'search' });
    expect(findPassage('Wait… really', { sourceExact: 'Wait..' })).toEqual(NOT_FOUND);
    expect(findPassage('Wait… really', { sourceExact: '.. really' })).toEqual(NOT_FOUND);
  });
});

describe('several places hold the same words', () => {
  const words = 'We ship on Friday.';
  const [first] = span(SOURCE, words);
  const [second] = span(SOURCE, words, first + 1);
  const moved = `Added.\n${SOURCE}`;

  it('the words around the passage choose', () => {
    expect(findPassage(moved, anchorOf(SOURCE, words, first + 1))).toEqual({ found: true, start: second + 7, end: second + 7 + words.length, by: 'search' });
    expect(findPassage(moved, anchorOf(SOURCE, words))).toEqual({ found: true, start: first + 7, end: first + 7 + words.length, by: 'search' });
  });

  it('the words after it choose when the words before are the same', () => {
    const text = 'Note: ship it. Today.\nNote: ship it. Tomorrow.';
    const anchor = { sourceExact: 'ship it.', sourcePrefix: 'Note: ', sourceSuffix: ' Tomorrow.' };
    expect(findPassage(text, anchor).start).toBe(text.lastIndexOf('ship it.'));
  });

  it('with no words around it, the place nearest the hint is chosen', () => {
    expect(findPassage(moved, { sourceExact: words, sourceStart: first }).start).toBe(first + 7);
    expect(findPassage(moved, { sourceExact: words, sourceStart: second + 30 }).start).toBe(second + 7);
  });

  it('with nothing to choose by, the first place is chosen', () => {
    expect(findPassage(SOURCE, { sourceExact: words })).toEqual({ found: true, start: first, end: first + words.length, by: 'search' });
  });

  it('a hint that still holds the words wins without a search', () => {
    expect(findPassage(SOURCE, { sourceExact: words, sourceStart: second })).toEqual({ found: true, start: second, end: second + words.length, by: 'hint' });
  });
});

describe('a hostile or broken anchor is not found, and never throws', () => {
  it.each([null, undefined, 'x', 5, [], {}, { sourceExact: null }, { sourceExact: '' }, { sourceExact: '   ' }, { sourceExact: 7 }, { sourceExact: ['Small'] }, { sourceExact: { toString: () => 'Small' } }])('anchor %j', (anchor) => {
    expect(findPassage(SOURCE, anchor)).toEqual(NOT_FOUND);
  });

  it('a text that is not a string', () => {
    for (const text of [null, undefined, 5, {}, ['Small teams']]) expect(findPassage(text, { sourceExact: 'Small teams' })).toEqual(NOT_FOUND);
  });

  it('the words are matched as text, never as a pattern', () => {
    const text = 'Use (.*)+$ and [a-z]{2,} with \\d in the rule.';
    expect(findPassage(text, { sourceExact: '(.*)+$ and [a-z]{2,} with \\d' })).toEqual({ found: true, start: 4, end: 32, by: 'search' });
    expect(findPassage('aaaa', { sourceExact: 'a.*a' })).toEqual(NOT_FOUND);
  });

  it('words that overlap themselves are found at every place they stand', () => {
    expect(findPassage('aaab', { sourceExact: 'aab' })).toEqual({ found: true, start: 1, end: 4, by: 'search' });
    expect(findPassage('xaaaay', { sourceExact: 'aa', sourcePrefix: 'a', sourceSuffix: 'a' })).toEqual({ found: true, start: 2, end: 4, by: 'search' });
  });

  it('reads only the anchor\'s own values', () => {
    expect(findPassage(SOURCE, Object.create({ sourceExact: 'Small teams' }))).toEqual(NOT_FOUND);
  });
});
