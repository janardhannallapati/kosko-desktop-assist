// Kosko 726 "The old-reader guard" and 728: a reader whose schema lacks a block must still show every word.
//
// Tiptap answers an unknown node type by loading an EMPTY document (a console warning, no error), and the
// next autosave would then store that. `degradeDoc` is the pure function a reader runs first; the server's
// refusal of a too-old save is the other half and lives in Kosko.
import { describe, it, expect } from 'vitest';
import { noteSchema, degradeDoc, schemaVersionNeeded, NOTE_SCHEMA_VERSION } from '../src/index.js';
import { schema040 } from './support/schema-040.js';

const now = noteSchema();
const old = schema040();

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', attrs: { textAlign: null }, content });
const heading = (level, t) => ({ type: 'heading', attrs: { level, textAlign: null }, content: [text(t)] });
const cell = (type, background, t) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, background }, content: [para(text(t))] });
const calloutOf = (kind, ...content) => ({ type: 'callout', attrs: { kind }, content });
const image = (attrs) => ({ type: 'noteImage', attrs: { ...now.nodes.noteImage.create().attrs, src: null, path: 'u/n/pic.png', ...attrs } });
const toggle = (open, summary, body) => ({
  type: 'details', attrs: { open },
  content: [{ type: 'detailsSummary', content: summary }, { type: 'detailsContent', content: body }]
});

function textOf(node) {
  let s = '';
  (function walk(n) {
    if (n.type === 'text') s += n.text;
    (n.content || []).forEach(walk);
  })(node);
  return s;
}

function typesOf(node) {
  const out = new Set();
  (function walk(n) {
    out.add(n.type);
    (n.content || []).forEach(walk);
  })(node);
  return out;
}

// The wave's gate: one note holding all five new blocks, with Telugu, Hindi and Kannada text.
const ALL_FIVE = {
  type: 'doc',
  content: [
    heading(1, 'Araku trip'),
    { type: 'tableOfContents' },
    {
      type: 'callout', attrs: { kind: 'tip' },
      content: [
        para(text('Carry cash: '), text('no ATM after Sunkarametta', [{ type: 'bold' }])),
        { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('ఉదయం ఆరు గంటలకు బయలుదేరాలి'))] }] }
      ]
    },
    heading(2, 'Packing list'),
    toggle(false,
      [text('सामान की सूची '), { type: 'inlineMath', attrs: { latex: 'n=12' } }],
      [
        para(text('Torch, rain cover')),
        toggle(true, [text('ಒಳಗಿನ ಪಟ್ಟಿ')], [para(text('Spare batteries'))]),
        { type: 'callout', attrs: { kind: 'danger' }, content: [para(text('Leeches after rain'))] }
      ]),
    image({ displayWidth: 50, align: 'center', caption: 'అరకు లోయ at dawn', width: 1440, height: 960 }),
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'grey', 'Day'), cell('tableHeader', null, 'Plan')] },
        { type: 'tableRow', content: [cell('tableCell', 'yellow', 'Saturday'), cell('tableCell', 'green', 'Borra caves')] }
      ]
    }
  ]
};

const ALL_WORDS = [
  'Araku trip', 'Carry cash: ', 'no ATM after Sunkarametta', 'ఉదయం ఆరు గంటలకు బయలుదేరాలి', 'Packing list', 'सामान की सूची ',
  'Torch, rain cover', 'ಒಳಗಿನ ಪಟ್ಟಿ', 'Spare batteries', 'Leeches after rain', 'అరకు లోయ at dawn', 'Day', 'Plan', 'Saturday', 'Borra caves'
];

describe('the fixture is a real 0.5.0 note', () => {
  it('passes today\'s schema and fails the 0.4.0 schema', () => {
    expect(() => now.nodeFromJSON(ALL_FIVE).check()).not.toThrow();
    expect(() => old.nodeFromJSON(ALL_FIVE)).toThrow(/Unknown node type/);
  });
});

describe('degradeDoc: a note holding all five blocks, read by the 0.4.0 schema (the wave\'s gate)', () => {
  const result = degradeDoc(ALL_FIVE, old);

  it('reports that it degraded, and what', () => {
    expect(result.degraded).toBe(true);
    expect(result.floor).toBe(false);
    expect(result.kinds).toEqual({ tableOfContents: 1, callout: 2, details: 2, 'noteImage.caption': 1, 'noteImage.displayWidth': 1, 'noteImage.align': 1, 'tableHeader.background': 1, 'tableCell.background': 2 });
  });

  it('the result passes the 0.4.0 schema', () => {
    expect(() => old.nodeFromJSON(result.doc).check()).not.toThrow();
    for (const type of typesOf(result.doc)) expect(Object.keys(old.nodes), type).toContain(type);
  });

  it('loses no word: every string of the note is in the result, in order', () => {
    const out = textOf(result.doc);
    let from = 0;
    for (const words of ALL_WORDS) {
      const at = out.indexOf(words, from);
      expect(at, words).toBeGreaterThanOrEqual(0);
      from = at + words.length;
    }
  });

  it('a callout becomes a quote holding the same content, marks kept', () => {
    const quote = result.doc.content[1];
    expect(quote.type).toBe('blockquote');
    expect(quote.content.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(quote.content[0].content[1]).toEqual(text('no ATM after Sunkarametta', [{ type: 'bold' }]));
  });

  it('a toggle becomes its summary as a bold paragraph, then its body, and the formula stays', () => {
    const [summary, first, innerSummary, innerBody, quote] = result.doc.content.slice(3, 8);
    expect(summary.type).toBe('paragraph');
    expect(summary.content[0]).toEqual(text('सामान की सूची ', [{ type: 'bold' }]));
    expect(summary.content[1].type).toBe('inlineMath');
    expect(textOf(first)).toBe('Torch, rain cover');
    expect(innerSummary.content[0]).toEqual(text('ಒಳಗಿನ ಪಟ್ಟಿ', [{ type: 'bold' }]));
    expect(textOf(innerBody)).toBe('Spare batteries');
    expect(quote.type).toBe('blockquote');
  });

  it('the contents block is left out', () => {
    expect(typesOf(result.doc).has('tableOfContents')).toBe(false);
  });

  it('a caption becomes a paragraph after the picture; width and alignment are dropped, the pixel size kept', () => {
    const at = result.doc.content.findIndex((n) => n.type === 'noteImage');
    const picture = result.doc.content[at];
    expect(picture.attrs).not.toHaveProperty('caption');
    expect(picture.attrs).not.toHaveProperty('displayWidth');
    expect(picture.attrs).not.toHaveProperty('align');
    expect(picture.attrs).toMatchObject({ path: 'u/n/pic.png', width: 1440, height: 960 });
    expect(result.doc.content[at + 1].type).toBe('paragraph');
    expect(textOf(result.doc.content[at + 1])).toBe('అరకు లోయ at dawn');
  });

  it('a cell\'s shade is dropped and the cell kept', () => {
    const cells = [];
    (function walk(n) {
      if (n.type === 'tableCell' || n.type === 'tableHeader') cells.push(n);
      (n.content || []).forEach(walk);
    })(result.doc);
    expect(cells).toHaveLength(4);
    for (const c of cells) expect(c.attrs).not.toHaveProperty('background');
  });

  it('never changes the note it was given', () => {
    expect(ALL_FIVE.content[1]).toEqual({ type: 'tableOfContents' });
    expect(ALL_FIVE.content[2].type).toBe('callout');
  });
});

describe('degradeDoc: benign paths', () => {
  it('a note today\'s schema knows comes back as the same object, not degraded', () => {
    const result = degradeDoc(ALL_FIVE, now);
    expect(result.degraded).toBe(false);
    expect(result.doc).toBe(ALL_FIVE);
    expect(result.kinds).toEqual({});
  });

  it('a 0.4.0 note read by the 0.4.0 schema is untouched', () => {
    const plain = { type: 'doc', content: [heading(2, 'Plain'), para(text('words'))] };
    const result = degradeDoc(plain, old);
    expect(result.degraded).toBe(false);
    expect(result.doc).toBe(plain);
  });

  it('a picture with no caption, width or alignment set is not reported as degraded', () => {
    const doc = { type: 'doc', content: [image({})] };
    const result = degradeDoc(doc, old);
    expect(result.kinds).toEqual({});
    expect(() => old.nodeFromJSON(result.doc).check()).not.toThrow();
  });
});

describe('degradeDoc: edges', () => {
  it('a note of known blocks in an invalid arrangement is returned untouched: only an unknown block is a reason to rewrite', () => {
    const odd = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [heading(2, 'first')] }] }] };
    expect(() => old.nodeFromJSON(odd).check()).toThrow();
    const result = degradeDoc(odd, old);
    expect(result.doc).toBe(odd);
    expect(result.degraded).toBe(false);
  });

  it('a note that is only a contents block degrades to one empty paragraph, a valid document', () => {
    const result = degradeDoc({ type: 'doc', content: [{ type: 'tableOfContents' }] }, old);
    expect(result.doc.content).toEqual([{ type: 'paragraph' }]);
    expect(() => old.nodeFromJSON(result.doc).check()).not.toThrow();
  });

  it('a toggle with an empty summary adds no empty line', () => {
    const result = degradeDoc({ type: 'doc', content: [toggle(false, [], [para(text('body only'))])] }, old);
    expect(result.doc.content).toHaveLength(1);
    expect(textOf(result.doc)).toBe('body only');
  });

  it('a callout inside a list item and inside a table cell degrades in place', () => {
    const callout = { type: 'callout', attrs: { kind: 'info' }, content: [para(text('aside'))] };
    const doc = {
      type: 'doc',
      content: [
        { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('item')), callout] }] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [callout] }] }] }
      ]
    };
    const result = degradeDoc(doc, old);
    expect(() => old.nodeFromJSON(result.doc).check()).not.toThrow();
    expect(textOf(result.doc)).toBe('itemasideaside');
  });

  it('a block from a release that does not exist yet keeps its words: block children are lifted, inline children become a paragraph', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'futureColumns', attrs: { count: 2 }, content: [para(text('left')), para(text('right'))] },
        { type: 'futureLabel', content: [text('a label '), text('in bold', [{ type: 'bold' }, { type: 'futureMark' }])] },
        para(text('x '), { type: 'futureChip', content: [text('chip')] }, text(' y'))
      ]
    };
    const result = degradeDoc(doc, old);
    expect(() => old.nodeFromJSON(result.doc).check()).not.toThrow();
    expect(textOf(result.doc)).toBe('leftrighta label in boldx chip y');
    expect(result.doc.content[2].content[1].marks).toEqual([{ type: 'bold' }]);
    expect(result.kinds).toMatchObject({ futureColumns: 1, futureLabel: 1, futureChip: 1, 'mark.futureMark': 1 });
  });

  it('falls to plain paragraphs, and says so, when the rebuilt note still fails the schema', () => {
    // A heading inside a list item's first slot is not valid in any release; the floor keeps the words.
    const doc = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'futureThing', content: [heading(2, 'kept'), para(text('too'))] }] }] }] };
    const result = degradeDoc(doc, old);
    expect(() => old.nodeFromJSON(result.doc).check()).not.toThrow();
    expect(result.floor).toBe(true);
    expect(textOf(result.doc)).toBe('kepttoo');
  });

  it('refuses nothing and throws nothing on junk input', () => {
    for (const junk of [null, undefined, 7, 'doc', [], {}, { type: 'doc' }, { type: 'doc', content: 'x' }, { type: 'doc', content: [null, 5, { content: [] }] }]) {
      const result = degradeDoc(junk, old);
      expect(() => old.nodeFromJSON(result.doc).check(), JSON.stringify(junk)).not.toThrow();
    }
  });

  it('a note nested deeper than the JS stack allows degrades without a stack overflow', () => {
    let node = para(text('deep'));
    for (let i = 0; i < 20000; i += 1) node = { type: 'callout', attrs: { kind: 'note' }, content: [node] };
    const result = degradeDoc({ type: 'doc', content: [node] }, old);
    expect(result.degraded).toBe(true);
    expect(JSON.stringify(result.doc).includes('deep')).toBe(true);
  });

  it('a toggle part found outside a toggle is still reported: the old reader does not know it either', () => {
    for (const type of ['detailsContent', 'detailsSummary']) {
      const kid = type === 'detailsContent' ? para(text('kept words')) : text('kept words');
      const result = degradeDoc({ type: 'doc', content: [{ type, content: [kid] }] }, old);
      expect(result.degraded, type).toBe(true);
      expect(result.kinds[type], type).toBe(1);
      expect(JSON.stringify(result.doc), type).toContain('kept words');
      expect(() => old.nodeFromJSON(result.doc).check(), type).not.toThrow();
    }
  });

  it('a node type named like an Object.prototype key is an unknown block like any other', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const doc = JSON.parse(JSON.stringify({ type: 'doc', content: [{ type: 'X', attrs: {}, content: [para(text('kept words'))] }] }).replace('"X"', JSON.stringify(type)));
      expect(() => schemaVersionNeeded(doc), type).not.toThrow();
      expect(schemaVersionNeeded(doc), type).toBe(1);
      const result = degradeDoc(doc, old);
      expect(result.degraded, type).toBe(true);
      expect(Object.keys(result.kinds), type).toEqual([type]);
      expect(result.kinds[type], type).toBe(1);
      expect(JSON.stringify(result.doc), type).toContain('kept words');
    }
  });

  it('a dropped mark on a block is counted', () => {
    const result = degradeDoc({ type: 'doc', content: [{ ...para(text('a')), marks: [{ type: 'futureBlockMark' }] }, calloutOf('tip', para(text('b')))] }, old);
    expect(result.kinds['mark.futureBlockMark']).toBe(1);
  });

  it('a very long note with one unknown block is degraded in linear time', () => {
    const build = (n) => ({ type: 'doc', content: [...Array.from({ length: n }, () => para(text('p'))), calloutOf('tip', para(text('end')))] });
    const timed = (n) => { const doc = build(n); const t = performance.now(); const r = degradeDoc(doc, old); return { ms: performance.now() - t, r }; };
    timed(1000);
    const small = timed(5000);
    const big = timed(20000);
    expect(big.r.degraded).toBe(true);
    expect(big.r.doc.content).toHaveLength(20001);
    // 4x the blocks. The quadratic version took 16x and more (6.8 s at 20,000 blocks).
    expect(big.ms).toBeLessThan(Math.max(small.ms, 20) * 10);
  }, 30000);
});

describe('schemaVersionNeeded: the number a save is checked against', () => {
  it('this release writes schema version 2', () => {
    expect(NOTE_SCHEMA_VERSION).toBe(2);
  });

  it('a note with none of the 0.5.0 blocks needs version 1 (benign: an old tab may still save it)', () => {
    expect(schemaVersionNeeded({ type: 'doc', content: [heading(1, 'x'), para(text('y')), image({}), { type: 'blockMath', attrs: { latex: 'x' } }] })).toBe(1);
    const unshaded = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('tableCell', null, 'c')] }] }] };
    expect(schemaVersionNeeded(unshaded)).toBe(1);
  });

  it.each([
    ['a callout', { type: 'callout', attrs: { kind: 'tip' }, content: [para(text('x'))] }],
    ['a toggle', toggle(false, [text('s')], [para(text('b'))])],
    ['a contents block', { type: 'tableOfContents' }],
    ['a picture with a caption', image({ caption: 'c' })],
    ['a picture with a display width', image({ displayWidth: 33 })],
    ['a picture with an alignment', image({ align: 'right' })],
    ['a shaded cell', { type: 'table', content: [{ type: 'tableRow', content: [cell('tableCell', 'red', 'c')] }] }],
    ['a shaded header cell', { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'blue', 'c')] }] }]
  ])('%s needs version 2, at any depth', (_, node) => {
    expect(schemaVersionNeeded({ type: 'doc', content: [node] })).toBe(2);
    const deep = { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [para(text('i')), node] }] }] }] };
    expect(schemaVersionNeeded(deep)).toBe(2);
  });

  it('junk and deep input answer 1 without throwing', () => {
    for (const junk of [null, undefined, 'x', 5, [], {}, { type: 'doc', content: 'x' }]) expect(schemaVersionNeeded(junk)).toBe(1);
    let node = para(text('deep'));
    for (let i = 0; i < 20000; i += 1) node = { type: 'blockquote', content: [node] };
    expect(schemaVersionNeeded({ type: 'doc', content: [node] })).toBe(1);
  });
});
