// @vitest-environment jsdom
//
// Kosko 743, security review: rebuilding a quote's passage on Evernote import is LINEAR in the note's size.
//
// It used to walk a quote's whole subtree, and build its whole text, once for every sourced quote, so quotes
// nested inside each other cost (depth x size) in time and in memory. Now each quote's passage is read once,
// bottom-up, an outer quote reusing its inner quotes' results; and a passage is held as its first and last
// 2,000 units and its length, never as the subtree's text. What is stored must not change by one unit.
import { describe, it, expect } from 'vitest';
import { conv, nodesOf } from './support/convert-harness.js';
import { DROPPED, quoteSourcePassage, quoteSourceItem, KOSKO_ENML } from '../src/index.js';
import { quotePassageText, citeOf } from '../src/enml/enml-quote-source.js';
import { newPassage, addText, addPassage, passageText, PASSAGE_KEEP } from '../src/enml/enml-passage-text.js';
import { styleMap } from '../src/enml/enml-evernote-styles.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';
const BLOCK = new Set(['div', 'p', 'center', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'dt', 'dd', 'li', 'table', 'pre', 'blockquote', 'hr', 'address', 'en-crypt', 'map', 'form', 'fieldset']);
const H = { block: BLOCK, dropped: DROPPED };
const SOURCED = `<blockquote style="--kosko-quote-source:${ID}">`;
const CITE = '<div style="--kosko-quote-cite:1">— <a href="https://example.com/t">Title</a></div>';
const parse = (enml) => new window.DOMParser().parseFromString(`<en-note>${enml}</en-note>`, 'application/xml').documentElement;
const isSourced = (xml) => quoteSourceItem(styleMap(xml).get(KOSKO_ENML.quoteSource)) !== null;

// THE REFERENCE: the 0.6.0 code as first reviewed. One walk of the whole subtree per quote, the whole text
// built, then the rule. Kept here so the fast version is held to the slow one's every answer.
function referenceText(quoteXml) {
  let out = '';
  const cites = new Set([citeOf(quoteXml)?.xml]);
  const stack = [quoteXml];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === 'string') out += node;
    else if (node.nodeType === 3 || node.nodeType === 4) out += node.data;
    else if (node.nodeType === 1 && !cites.has(node) && !DROPPED.has(node.localName)) {
      if (node !== quoteXml && node.localName === 'blockquote' && isSourced(node)) cites.add(citeOf(node)?.xml);
      if (BLOCK.has(node.localName) || node.localName === 'br') stack.push(' ');
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) stack.push(node.childNodes[i]);
    }
  }
  return out;
}

const sourcedQuotes = (root) => Array.from(root.getElementsByTagName('blockquote')).filter(isSourced);

describe('the bounded passage: the same answer as the whole text, from its two ends and its length', () => {
  const viaPieces = (pieces) => {
    const p = newPassage();
    for (const piece of pieces) addText(p, piece);
    return p;
  };

  it.each([0, 1, 2, 499, 500, 501, 998, 999, 1000, 1001, 1002, 1003, 1500, 1998, 1999, 2000, 2001, 2002, 2003, 2500, 4000, 9000])('a text of %i units, whole and in pieces of 1, 7 and 333', (size) => {
    const full = Array.from({ length: size }, (_, i) => (i % 11 === 10 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
    const want = quoteSourcePassage(full);
    for (const step of [size || 1, 1, 7, 333]) {
      const pieces = [];
      for (let at = 0; at < full.length; at += step) pieces.push(full.slice(at, at + step));
      expect(quoteSourcePassage(passageText(viaPieces(pieces))), `${size}/${step}`).toEqual(want);
    }
  });

  it('whitespace of every kind, at the joins between pieces and at both ends', () => {
    const cases = [[' ', ' a ', ' ', '\n', 'b', '  ', '\u00a0c\t'], ['a ', ' b'], ['a', ' ', ' ', 'b'], [' ', ' ', ' '], ['\n\n'], ['x'.repeat(1200), ' ', ' ', 'y'.repeat(1200), ' ']];
    for (const pieces of cases) expect(quoteSourcePassage(passageText(viaPieces(pieces))), JSON.stringify(pieces).slice(0, 60)).toEqual(quoteSourcePassage(pieces.join('')));
  });

  it('thousands of empty lines between a few words do not push the words out of what is kept', () => {
    const gap = Array.from({ length: 3000 }, () => ' ');
    const pieces = ['a'.repeat(10), ...gap, 'c'.repeat(10), ...gap, 'b'.repeat(10)];
    expect(quoteSourcePassage(passageText(viaPieces(pieces)))).toEqual({ exact: `${'a'.repeat(10)} ${'c'.repeat(10)} ${'b'.repeat(10)}`, cut: false });
    const enml = `${SOURCED}<div>first</div>${'<br/>'.repeat(3000)}<div>middle</div>${'<div> </div>'.repeat(3000)}<div>last</div></blockquote>`;
    expect(quoteSourcePassage(quotePassageText(sourcedQuotes(parse(enml))[0], {}, H))).toEqual({ exact: 'first middle last', cut: false });
  });

  it('a surrogate pair or a space exactly at either cut', () => {
    for (const at of [498, 499, 500, 501]) {
      for (const mark of ['😀', ' ']) {
        const front = `${'x'.repeat(at)}${mark}${'y'.repeat(3000)}`;
        const back = `${'x'.repeat(3000)}${mark}${'y'.repeat(at)}`;
        for (const full of [front, back]) {
          expect(quoteSourcePassage(passageText(viaPieces([full.slice(0, 700), full.slice(700)]))), `${at}${mark}`).toEqual(quoteSourcePassage(full));
        }
      }
    }
  });

  it('one passage added to another gives what their texts joined would give', () => {
    let seed = 99;
    const next = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const text = () => Array.from({ length: [0, 1, 3, 40, 990, 1010, 1990, 2010, 5000][next(9)] + next(5) }, () => 'ab c😀\n'[next(7)] ?? 'd').join('');
    for (let i = 0; i < 400; i += 1) {
      const [a, b, c] = [text(), text(), text()];
      const outer = viaPieces([a]);
      addPassage(outer, viaPieces([b]));
      addText(outer, c);
      expect(quoteSourcePassage(passageText(outer)), String(i)).toEqual(quoteSourcePassage(a + b + c));
    }
  });

  it('holds two ends and a length, however much text goes in: 5,000,000 units in, a few thousand kept', () => {
    const p = newPassage();
    for (let i = 0; i < 50_000; i += 1) addText(p, 'word and more words here and there and everywhere again and again and once more for luck... ');
    addText(p, 'z'.repeat(500_000));
    expect(p.length).toBeGreaterThan(5_000_000);
    expect(p.head.length).toBeLessThanOrEqual(PASSAGE_KEEP);
    expect(p.tail.length).toBeLessThanOrEqual(PASSAGE_KEEP * 4);
    expect(passageText(p).length).toBeLessThan(PASSAGE_KEEP);
  });
});

describe('every sourced quote of a random nested note gets the passage the reference gives', () => {
  it('for 300 notes: nested sourced and plain quotes, cite lines, dropped elements, inline elements, breaks', () => {
    let seed = 2026;
    const next = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const words = () => {
      const size = [0, 1, 5, 30, 200, 480, 520, 990, 1010, 1995, 2005, 3000][next(12)];
      return Array.from({ length: size }, () => ['a', 'b', ' ', ' ', 'క', '😀', '\n', 'é'][next(8)]).join('');
    };
    const build = (depth) => {
      let out = '';
      for (let i = 0, n = 1 + next(4); i < n; i += 1) {
        const kind = next(depth > 5 ? 6 : 10);
        if (kind === 0) out += words();
        else if (kind === 1) out += `<div>${words()}</div>`;
        else if (kind === 2) out += `<b>${words()}</b>`;
        else if (kind === 3) out += '<br/>';
        else if (kind === 4) out += `<script>${words()}</script><style>x</style>`;
        else if (kind === 5) out += `<ul><li>${words()}</li></ul>`;
        else if (kind < 8) out += `${SOURCED}${build(depth + 1)}${next(2) ? CITE : ''}</blockquote>`;
        else out += `<blockquote>${build(depth + 1)}${next(2) ? CITE : ''}</blockquote>`;
      }
      return out;
    };
    let checked = 0;
    for (let i = 0; i < 300; i += 1) {
      const root = parse(`${SOURCED}${build(0)}${next(2) ? CITE : ''}</blockquote>`);
      // Outermost first, as the converter reaches them; then again, in reverse, from a fresh conversion.
      for (const order of [(list) => list, (list) => [...list].reverse()]) {
        const fresh = {};
        for (const quote of order(sourcedQuotes(root))) {
          expect(quoteSourcePassage(quotePassageText(quote, fresh, H)), `note ${i}`).toEqual(quoteSourcePassage(referenceText(quote)));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(600);
  }, 60000);

  it('through the converter: the stored passage and cut flag of each quote of a nested note', () => {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
    const enml = `${SOURCED}<div>outer ${long}</div>${SOURCED}<div>inner one</div>${CITE}</blockquote><blockquote><div>plain</div>${CITE}</blockquote>${SOURCED}<div>${long} inner two</div><script>no</script></blockquote>${CITE}</blockquote>`;
    const root = parse(enml);
    const stored = nodesOf(conv(enml).doc, 'blockquote').filter((q) => q.attrs.sourceItem).map((q) => q.attrs.sourceExact);
    expect(stored).toEqual(sourcedQuotes(root).map((q) => quoteSourcePassage(referenceText(q)).exact));
    expect(stored[1]).toBe('inner one');
    expect(stored[0].startsWith('outer w0 w1')).toBe(true);
  });
});

// No wall-clock limits. Each case is timed against the same file at a quarter of the size, and against the
// same file with plain quotes. Four times the note must not cost much more than four times as long (the old
// code took sixteen times and more), and a sourced quote must not cost much more than a plain one (it took
// 18 to 85 times).
describe('nested sourced quotes: the work grows with the note, not with depth times size', () => {
  const nested = (depth, perLevel, sourced) => {
    const open = sourced ? SOURCED : '<blockquote>';
    return `${`${open}<div>${'w '.repeat(perLevel / 2)}</div>`.repeat(depth)}${'</blockquote>'.repeat(depth)}`;
  };
  const best = (enml) => Math.min(...[0, 1].map(() => {
    const t0 = performance.now();
    expect(conv(enml).ok).toBe(true);
    return performance.now() - t0;
  }));

  it.each([
    ['four times as deep, the same text at each level', [100, 2000], [400, 2000]],
    ['the same depth, four times the text at each level', [150, 2000], [150, 8000]],
    ['deeper than the converter keeps structure (400 levels), four times the text', [400, 500], [400, 2000]]
  ])('%s', (_name, small, big) => {
    const smallMs = best(nested(...small, true));
    const bigMs = best(nested(...big, true));
    const plainMs = best(nested(...big, false));
    expect(bigMs, `sourced ${bigMs.toFixed(0)}ms, a quarter of the note ${smallMs.toFixed(0)}ms`).toBeLessThan(Math.max(smallMs, 30) * 10);
    expect(bigMs, `sourced ${bigMs.toFixed(0)}ms, plain ${plainMs.toFixed(0)}ms`).toBeLessThan(Math.max(plainMs, 30) * 4);
  }, 120000);

  it('every level of 150 nested sourced quotes still gets its own passage', () => {
    const { doc } = conv(nested(150, 20, true));
    const quotes = nodesOf(doc, 'blockquote');
    expect(quotes).toHaveLength(150);
    expect(quotes[149].attrs.sourceExact).toBe('w w w w w w w w w w');
    expect(quotes[0].attrs.sourceExact).toBe(quoteSourcePassage('w '.repeat(1500)).exact);
    expect(quotes[0].attrs.sourceCut).toBeNull();
  });
});
