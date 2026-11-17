// Kosko 742 / 743: the text an anchor is measured against, and making an anchor from a selection.
//
// One pure rule, used by the web app, the phone and tests: one text block after another joined by a line
// break, Unicode NFC, runs of whitespace made one space. A block with no text adds nothing, so adding a
// picture or an empty line to a source does not move any passage.
import { describe, it, expect } from 'vitest';
import { anchorText, makeAnchor, findPassage, SOURCE_CONTEXT_MAX } from '../src/index.js';

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', content });

describe('anchorText of a document', () => {
  it('joins text blocks with one line break', () => {
    expect(anchorText(doc(para(text('First block.')), para(text('Second block.'))))).toBe('First block.\nSecond block.');
  });

  it('joins the runs of one block with nothing between them, marks ignored', () => {
    expect(anchorText(doc(para(text('Small '), text('teams', [{ type: 'bold' }]), text(' plan'))))).toBe('Small teams plan');
  });

  it('makes runs of whitespace one space, and trims each block', () => {
    expect(anchorText(doc(para(text('  a \t b\u00a0\u00a0c\n d  '))))).toBe('a b c d');
  });

  it('is Unicode NFC', () => {
    expect(anchorText(doc(para(text('cafe\u0301'))))).toBe('caf\u00e9');
    expect(anchorText('cafe\u0301')).toBe('caf\u00e9');
  });

  it('a hard break is one space', () => {
    expect(anchorText(doc(para(text('line one'), { type: 'hardBreak' }, text('line two'))))).toBe('line one line two');
  });

  it('a block with no text adds nothing: a picture, a rule, a contents block, a formula, an empty line', () => {
    const blocks = doc(
      para(text('Before.')),
      { type: 'noteImage', attrs: { caption: 'a caption is not source text', alt: 'nor is alt' } },
      { type: 'horizontalRule' },
      { type: 'tableOfContents' },
      { type: 'blockMath', attrs: { latex: 'x^2' } },
      { type: 'noteAttachment', attrs: { filename: 'a.pdf' } },
      { type: 'rawHtml', attrs: { html: '<b>raw</b>' } },
      para(),
      para(text('   ')),
      para(text('After.'))
    );
    expect(anchorText(blocks)).toBe('Before.\nAfter.');
  });

  it('an inline formula adds nothing; the words either side stay as written', () => {
    expect(anchorText(doc(para(text('Energy '), { type: 'inlineMath', attrs: { latex: 'E=mc^2' } }, text(' is conserved'))))).toBe('Energy is conserved');
  });

  it('a list, a quote, a callout and a toggle give their text blocks in document order', () => {
    const blocks = doc(
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one'))] }, { type: 'listItem', content: [para(text('two'))] }] },
      { type: 'blockquote', content: [para(text('quoted'))] },
      { type: 'callout', attrs: { kind: 'tip' }, content: [para(text('tip'))] },
      { type: 'details', content: [{ type: 'detailsSummary', content: [text('summary')] }, { type: 'detailsContent', content: [para(text('body'))] }] }
    );
    expect(anchorText(blocks)).toBe('one\ntwo\nquoted\ntip\nsummary\nbody');
  });

  it('a table gives each cell\'s blocks, row by row', () => {
    const cell = (t) => ({ type: 'tableCell', content: [para(text(t))] });
    const table = { type: 'table', content: [{ type: 'tableRow', content: [cell('a1'), cell('b1')] }, { type: 'tableRow', content: [cell('a2'), cell('b2')] }] };
    expect(anchorText(doc(table))).toBe('a1\nb1\na2\nb2');
  });

  it('a code block is one block; its line breaks are spaces', () => {
    expect(anchorText(doc({ type: 'codeBlock', content: [text('let a = 1;\nlet b = 2;')] }))).toBe('let a = 1; let b = 2;');
  });

  it('Telugu, Hindi and Kannada text is kept as written', () => {
    expect(anchorText(doc(para(text('ఉదయం ఆరు గంటలకు')), para(text('बारिश में फिसलन')), para(text('ಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ')))))
      .toBe('ఉదయం ఆరు గంటలకు\nबारिश में फिसलन\nಮಳೆಯಲ್ಲಿ ಜಾರುತ್ತದೆ');
  });
});

describe('anchorText of plain text (one PDF page)', () => {
  it('each line is a block; empty lines add nothing', () => {
    expect(anchorText('  Page  title \r\n\r\nFirst   line\nSecond line\u2029Third')).toBe('Page title\nFirst line\nSecond line\nThird');
  });

  it('its own output is unchanged by it', () => {
    const once = anchorText(doc(para(text('a  b')), para(text('c'))));
    expect(anchorText(once)).toBe(once);
  });
});

describe('anchorText never throws on a document a client wrote', () => {
  it('answers the empty string for anything that is not a document or text', () => {
    for (const bad of [null, undefined, 5, true, [], {}, { type: 'doc' }, { type: 'doc', content: 'x' }, () => 'x']) expect(anchorText(bad)).toBe('');
  });

  it('skips a child that is not a node and text that is not a string', () => {
    const odd = doc(null, 'x', 7, [para(text('in an array'))], para({ type: 'text', text: 9 }, { type: 'text' }, text('kept')), { type: 'paragraph', content: 'x' });
    expect(anchorText(odd)).toBe('kept');
  });

  it('reads a document nested deeper than the stack', () => {
    let node = para(text('deep words'));
    for (let i = 0; i < 20000; i += 1) node = { type: 'blockquote', content: [node] };
    expect(anchorText(doc(node))).toBe('deep words');
  });
});

describe('makeAnchor: the stored values for a selection in that text', () => {
  const source = anchorText(doc(
    para(text('Planning is hard when a team is large, and the end is never in sight.')),
    para(text('Small teams plan in pairs. Then they review on Friday, as one group.'))
  ));
  const start = source.indexOf('Small teams');
  const end = start + 'Small teams plan in pairs.'.length;

  it('gives the passage, its start and up to 32 units either side', () => {
    const anchor = makeAnchor(source, start, end);
    expect(anchor).toEqual({
      sourceExact: 'Small teams plan in pairs.', sourceCut: null,
      sourcePrefix: source.slice(start - SOURCE_CONTEXT_MAX, start).replace('\n', ' '), sourceSuffix: source.slice(end, end + SOURCE_CONTEXT_MAX),
      sourceStart: start, sourceLength: 26
    });
    expect(anchor.sourcePrefix).toHaveLength(32);
    expect(anchor.sourcePrefix.endsWith('never in sight. ')).toBe(true);
    expect(anchor.sourceSuffix).toBe(' Then they review on Friday, as ');
  });

  it('the anchor it makes is found where it was made', () => {
    expect(findPassage(source, makeAnchor(source, start, end))).toEqual({ found: true, start, end, by: 'hint' });
  });

  it('leaves out whitespace at either end of the selection', () => {
    expect(makeAnchor(source, start - 1, end + 1)).toEqual(makeAnchor(source, start, end));
  });

  it('at the very start and end of the text the context is null', () => {
    const anchor = makeAnchor(source, 0, source.length);
    expect(anchor).toMatchObject({ sourcePrefix: null, sourceSuffix: null, sourceStart: 0, sourceLength: source.length });
  });

  it('widens a selection that ends inside a letter to the whole letter', () => {
    const telugu = 'అది కిటికీ దగ్గర';
    const at = telugu.indexOf('కి');
    // The selection holds the base letter and not its vowel sign.
    expect(makeAnchor(telugu, at, at + 1).sourceExact).toBe('కి');
    const emoji = 'ok 😀 done';
    expect(makeAnchor(emoji, 3, 4).sourceExact).toBe('😀');
  });

  it('a passage longer than the limit is cut, and flagged', () => {
    const long = anchorText(Array.from({ length: 600 }, (_, i) => `word${i}`).join(' '));
    const anchor = makeAnchor(long, 0, long.length);
    expect(anchor.sourceCut).toBe(true);
    expect(anchor.sourceLength).toBe(long.length);
    expect(anchor.sourceExact.length).toBeLessThanOrEqual(1000);
    expect(anchor.sourceExact.startsWith('word0 word1 ')).toBe(true);
    expect(anchor.sourceExact.endsWith(' word598 word599')).toBe(true);
  });

  it('a start past the limit of the hint is no hint; the passage is still stored', () => {
    const big = `${'a '.repeat(5_000_001)}the passage`;
    const anchor = makeAnchor(big, big.length - 11, big.length);
    expect(anchor).toMatchObject({ sourceExact: 'the passage', sourceStart: null });
  });

  it('the length is the selection\'s own, in units of the text, after it was trimmed and widened', () => {
    const telugu = 'అది కిటికీ దగ్గర';
    const at = telugu.indexOf('కి');
    expect(makeAnchor(telugu, at - 1, at + 1)).toMatchObject({ sourceExact: 'కి', sourceStart: at, sourceLength: 2 });
  });

  it('a selection that begins on a mark with no letter before it is not a passage: null, never an anchor that cannot be found', () => {
    for (const text of ['a \u0301b c', 'first\n\u0c3fsecond', 'x \u200dy']) {
      const at = text.search(/[\u0301\u0c3f\u200d]/);
      const anchor = makeAnchor(text, at, at + 2);
      expect(anchor, JSON.stringify(text)).toBeNull();
    }
    // At the very start of the text there is nothing to join to, and it is found again.
    const lead = '\u0301abc def';
    const anchor = makeAnchor(lead, 0, 4);
    expect(findPassage(lead, anchor)).toEqual({ found: true, start: 0, end: 4, by: 'hint' });
  });

  it('is null for a selection that is not one', () => {
    const bad = [[source, 5, 5], [source, 9, 5], [source, -1, 5], [source, 0, source.length + 1], [source, 1.5, 5], [source, '1', 5], [source, 0, NaN], [null, 0, 5], [{}, 0, 5], ['a   b', 1, 4]];
    for (const [t, s, e] of bad) expect(makeAnchor(t, s, e), `${s}-${e}`).toBeNull();
  });
});
