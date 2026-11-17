// Kosko 742 / 743: a passage longer than 1,000 units is stored CUT: its first 500, its last 500, and its
// length (`sourceLength`, owner 2026-11-17). It is found where its beginning stands and its ending stands
// exactly where the length says. What stood between them was not stored and is not compared, but it must be
// exactly as long as it was.
import { describe, it, expect } from 'vitest';
import { anchorText, makeAnchor, findPassage } from '../src/index.js';

const NOT_FOUND = { found: false };
const long = Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ');
const text = anchorText(`An opening line.\n${long}\nA closing line.`);
const start = text.indexOf(long);
const end = start + long.length;
const anchor = makeAnchor(text, start, end);
const head = long.slice(0, 500).trimEnd();
const tail = long.slice(-500).trimStart();

describe('a cut passage is found whole, at its own length', () => {
  it('the anchor is cut and carries its length', () => {
    expect(anchor).toMatchObject({ sourceCut: true, sourceLength: long.length, sourceExact: head + tail });
    expect(anchor.sourceExact.length).toBeLessThanOrEqual(1000);
  });

  it('is found at the hint', () => {
    expect(findPassage(text, anchor)).toEqual({ found: true, start, end, by: 'hint' });
  });

  it('is found after text was added before it', () => {
    expect(findPassage(`More.\n${text}`, anchor)).toEqual({ found: true, start: start + 6, end: end + 6, by: 'search' });
  });

  it('an ending that also stands earlier is not taken for the real one', () => {
    const repeating = 'ab cd ef gh. '.repeat(400).trim();
    const source = anchorText(`Start.\n${repeating}\nEnd.`);
    const at = source.indexOf(repeating);
    const made = makeAnchor(source, at, at + repeating.length);
    expect(made.sourceCut).toBe(true);
    expect(findPassage(source, made)).toEqual({ found: true, start: at, end: at + repeating.length, by: 'hint' });
    expect(findPassage(`New.\n${source}`, made)).toEqual({ found: true, start: at + 5, end: at + 5 + repeating.length, by: 'search' });
  });

  it('evening-out inside the kept ends may change their length; the place is still the source\'s own span', () => {
    const quoted = anchorText(`Intro.\nWait... ${long} — done.\nOutro.`);
    const from = quoted.indexOf('Wait');
    const made = makeAnchor(quoted, from, quoted.indexOf('\nOutro.'));
    const now = quoted.replace('Wait...', 'WAIT…').replace('— done.', '- DONE.');
    expect(now.length).toBe(quoted.length - 2);
    const found = findPassage(now, made);
    expect(found).toEqual({ found: true, start: from, end: now.indexOf('\nOutro.'), by: 'hint' });
    // And the other way: quoted with the single character, found where three dots stand now.
    const back = makeAnchor(now, from, now.indexOf('\nOutro.'));
    expect(findPassage(quoted, back)).toEqual({ found: true, start: from, end: quoted.indexOf('\nOutro.'), by: 'hint' });
  });
});

describe('a cut passage is not found anywhere its words or its length do not hold', () => {
  it('a changed word in its first 500 or its last 500', () => {
    expect(findPassage(text.replace('word3 ', 'word-3 '), anchor)).toEqual(NOT_FOUND);
    expect(findPassage(text.replace(' word697 ', ' word-97 '), anchor)).toEqual(NOT_FOUND);
  });

  it('a changed character right beside the cut, on either side', () => {
    for (const at of [start + 499, end - 500]) {
      const changed = `${text.slice(0, at)}#${text.slice(at + 1)}`;
      expect(findPassage(changed, anchor), String(at)).toEqual(NOT_FOUND);
    }
  });

  it('the last 500 before the first 500', () => {
    const between = 'm'.repeat(long.length - head.length - tail.length);
    expect(findPassage(`${tail}${between}${head}`, anchor)).toEqual(NOT_FOUND);
    expect(findPassage(`${head}${between}${tail}`, anchor)).toEqual({ found: true, start: 0, end: long.length, by: 'search' });
  });

  it('words added to or taken from the part between: the ending no longer stands where the length says', () => {
    expect(findPassage(text.replace(' word350 ', ' word350 and more '), anchor)).toEqual(NOT_FOUND);
    expect(findPassage(text.replace(' word350 ', ' '), anchor)).toEqual(NOT_FOUND);
    expect(findPassage(text.replace(' word350 ', ' word35 '), anchor)).toEqual(NOT_FOUND);
    expect(findPassage(text.replace(' word350 ', ' word3500 '), anchor)).toEqual(NOT_FOUND);
  });

  it('the part between is not stored: changed at the same length, the passage is still found (the stated limit)', () => {
    expect(findPassage(text.replace(' word350 ', ' WORD35# '), anchor)).toEqual({ found: true, start, end, by: 'hint' });
  });

  it('a length that is missing, wrong by one, or not a length', () => {
    for (const length of [null, undefined, long.length - 1, long.length + 1, 1000, 0, -long.length, String(long.length) + 'x', 1_000_001]) {
      expect(findPassage(text, { ...anchor, sourceLength: length }), String(length)).toEqual(NOT_FOUND);
    }
    expect(findPassage(text, { ...anchor, sourceLength: String(long.length) }).found).toBe(true);
  });

  it('without the flag the 1,000 kept units are searched for as one run, and are not there', () => {
    expect(findPassage(text, { ...anchor, sourceCut: null })).toEqual(NOT_FOUND);
  });
});

describe('the flag and the length on other passages', () => {
  it('the flag beside a short passage does not let it match in two pieces', () => {
    const source = 'Small teams and big plans';
    expect(findPassage(source, { sourceExact: 'Small plans', sourceCut: true })).toEqual(NOT_FOUND);
    expect(findPassage(source, { sourceExact: 'Small plans', sourceCut: true, sourceLength: source.length })).toEqual(NOT_FOUND);
  });

  it('a short passage with the flag and a long length is matched whole, never with other words between (review N1)', () => {
    const source = `hello ${'zzzz '.repeat(200)}world`;
    expect(source).toHaveLength(1011);
    expect(findPassage(source, { sourceExact: 'hello world', sourceCut: true, sourceLength: 1011 })).toEqual(NOT_FOUND);
    expect(findPassage(`say hello world now`, { sourceExact: 'hello world', sourceCut: true, sourceLength: 1011 })).toEqual({ found: true, start: 4, end: 15, by: 'search' });
  });

  it('one unit either side of the shortest passage a real cut leaves (996 units)', () => {
    const between = 'x'.repeat(1200);
    const shortest = 'a'.repeat(498) + 'b'.repeat(498);
    expect(findPassage(`${'a'.repeat(498)}${between}${'b'.repeat(498)}`, { sourceExact: shortest, sourceCut: true, sourceLength: 996 + 1200 })).toEqual({ found: true, start: 0, end: 2196, by: 'search' });
    const tooShort = 'a'.repeat(498) + 'b'.repeat(497);
    expect(findPassage(`${'a'.repeat(498)}${between}${'b'.repeat(497)}`, { sourceExact: tooShort, sourceCut: true, sourceLength: 995 + 1200 })).toEqual(NOT_FOUND);
  });

  it('the beginning cannot stop part of the way through a character that was evened out', () => {
    // The stored passage has a full stop as its 499th unit. The text holds an ellipsis there.
    const exact = `${'q'.repeat(498)}.${'r'.repeat(501)}`;
    const anchorOf = { sourceExact: exact, sourceCut: true, sourceLength: 2200 };
    const between = 'x'.repeat(1200);
    expect(findPassage(`${'q'.repeat(498)}\u2026${between}${'r'.repeat(501)}`, anchorOf)).toEqual(NOT_FOUND);
    expect(findPassage(`${'q'.repeat(498)}.${between}${'r'.repeat(501)}`, anchorOf)).toEqual({ found: true, start: 0, end: 2200, by: 'search' });
  });

  it('an uncut passage is found with no length, and a wrong length does not stop it', () => {
    const source = 'Small teams plan in pairs.';
    for (const length of [undefined, null, 5, 999, 'x']) {
      expect(findPassage(source, { sourceExact: 'teams plan', sourceLength: length }), String(length)).toEqual({ found: true, start: 6, end: 16, by: 'search' });
    }
  });
});
