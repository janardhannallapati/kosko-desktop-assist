// @vitest-environment jsdom
//
// Kosko 726 (the contract) and 728 (this release): the 0.5.0 blocks, schema only. A callout, a toggle, a
// contents block, a picture's display width, alignment and caption, and a table cell's shade.
import { describe, it, expect } from 'vitest';
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import {
  noteSchema, CALLOUT_KINDS, CELL_SHADES, calloutKind, cellShade, imageDisplayWidth, imageAlign, imageCaption,
  CAPTION_MAX
} from '../src/index.js';

const schema = noteSchema();

function parse(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return DOMParser.fromSchema(schema).parse(host).toJSON();
}

function render(json) {
  const host = document.createElement('div');
  host.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(schema.nodeFromJSON(json).content));
  return host.innerHTML;
}

function nodesOf(json, type) {
  const out = [];
  (function walk(n) {
    if (n.type === type) out.push(n);
    (n.content || []).forEach(walk);
  })(json);
  return out;
}

const para = (text) => ({ type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text }] });
const roundTrip = (json) => parse(render(json));

describe('value rules: a stored value is one of a fixed list, or a bounded number', () => {
  it('names five callout kinds and seven cell shades', () => {
    expect(CALLOUT_KINDS).toEqual(['note', 'info', 'tip', 'warning', 'danger']);
    expect(CELL_SHADES).toEqual(['grey', 'red', 'orange', 'yellow', 'green', 'blue', 'purple']);
  });

  it('calloutKind: a known kind is kept, anything else reads as note', () => {
    for (const kind of CALLOUT_KINDS) expect(calloutKind(kind)).toBe(kind);
    for (const bad of ['TIP', 'success', '', null, undefined, 7, 'tip;color:red', '__proto__', 'constructor']) expect(calloutKind(bad)).toBe('note');
  });

  it('cellShade: a known shade is kept, anything else is null', () => {
    for (const shade of CELL_SHADES) expect(cellShade(shade)).toBe(shade);
    for (const bad of ['Red', '#ff0000', 'red; background:url(x)', '', null, undefined, 1, 'toString']) expect(cellShade(bad)).toBeNull();
  });

  it('imageDisplayWidth: an integer from 10 to 100, or null', () => {
    expect(imageDisplayWidth(50)).toBe(50);
    expect(imageDisplayWidth('33')).toBe(33);
    expect(imageDisplayWidth(10)).toBe(10);
    expect(imageDisplayWidth(100)).toBe(100);
    for (const bad of [9, 101, 0, -5, 33.5, '33.5', '50%', '5e1', 'abc', '', null, undefined, NaN, Infinity, true, '0x32']) expect(imageDisplayWidth(bad)).toBeNull();
  });

  it('imageAlign: left, center or right, or null', () => {
    for (const ok of ['left', 'center', 'right']) expect(imageAlign(ok)).toBe(ok);
    for (const bad of ['justify', 'centre', 'LEFT', 'left;float:left', '', null, undefined]) expect(imageAlign(bad)).toBeNull();
  });

  it('imageCaption: a plain string of at most 500 characters, or null', () => {
    expect(CAPTION_MAX).toBe(500);
    expect(imageCaption('Araku valley at dawn')).toBe('Araku valley at dawn');
    expect(imageCaption('అరకు లోయ')).toBe('అరకు లోయ');
    expect(imageCaption('  padded  ')).toBe('padded');
    expect(imageCaption('two\nlines\tand tabs')).toBe('two lines and tabs');
    expect(imageCaption('0123')).toBe('0123');
    expect(imageCaption('x'.repeat(600))).toHaveLength(500);
    for (const empty of ['', '   ', null, undefined, 5, {}, []]) expect(imageCaption(empty)).toBeNull();
  });

  it('imageCaption never cuts a surrogate pair in half', () => {
    const cut = imageCaption(`${'x'.repeat(499)}😀tail`);
    expect(cut).toBe('x'.repeat(499));
  });
});

describe('callout', () => {
  it('is a block holding paragraphs and lists, with kind defaulting to note', () => {
    const type = schema.nodes.callout;
    expect(type.isBlock).toBe(true);
    expect(type.spec.group).toBe('block');
    expect(type.spec.content).toBe('(paragraph | bulletList | orderedList | taskList)+');
    expect(type.createAndFill().attrs).toEqual({ kind: 'note' });
  });

  it('renders div[data-type="callout"][data-kind] and parses it back unchanged', () => {
    const doc = { type: 'doc', content: [{ type: 'callout', attrs: { kind: 'tip' }, content: [para('Carry cash.')] }] };
    expect(render(doc)).toBe('<div data-kind="tip" data-type="callout"><p>Carry cash.</p></div>');
    expect(roundTrip(doc)).toEqual(doc);
  });

  it('holds a bullet list, an ordered list and a task list', () => {
    const html = '<div data-type="callout" data-kind="warning"><p>Before you go</p><ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol>' +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>c</p></li></ul></div>';
    const [callout] = nodesOf(parse(html), 'callout');
    expect(callout.attrs.kind).toBe('warning');
    expect(callout.content.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'orderedList', 'taskList']);
  });

  it('an unknown or missing kind in HTML reads as note', () => {
    expect(nodesOf(parse('<div data-type="callout" data-kind="party"><p>x</p></div>'), 'callout')[0].attrs.kind).toBe('note');
    expect(nodesOf(parse('<div data-type="callout"><p>x</p></div>'), 'callout')[0].attrs.kind).toBe('note');
  });

  it('an unknown kind in stored JSON renders as note, never as the stored string', () => {
    const doc = { type: 'doc', content: [{ type: 'callout', attrs: { kind: 'x" onmouseover="y' }, content: [para('t')] }] };
    expect(render(doc)).toBe('<div data-kind="note" data-type="callout"><p>t</p></div>');
  });

  it('refuses a heading or a table as a direct child (the schema check throws)', () => {
    const bad = { type: 'doc', content: [{ type: 'callout', attrs: { kind: 'note' }, content: [{ type: 'heading', attrs: { level: 2, textAlign: null }, content: [{ type: 'text', text: 'h' }] }] }] };
    expect(() => schema.nodeFromJSON(bad).check()).toThrow();
  });

  it('benign: a plain div is not a callout', () => {
    expect(nodesOf(parse('<div><p>plain</p></div>'), 'callout')).toEqual([]);
  });
});

describe('toggle: details, detailsSummary, detailsContent', () => {
  const toggle = (open, summary, body) => ({
    type: 'details',
    attrs: { open },
    content: [
      { type: 'detailsSummary', content: summary },
      { type: 'detailsContent', content: body }
    ]
  });

  it('has the three nodes with the contract\'s content', () => {
    expect(schema.nodes.details.spec.content).toBe('detailsSummary detailsContent');
    expect(schema.nodes.details.spec.group).toBe('block');
    expect(schema.nodes.detailsSummary.spec.content).toBe('inline*');
    expect(schema.nodes.detailsContent.spec.content).toBe('block+');
    expect(schema.nodes.details.createAndFill().attrs).toEqual({ open: false });
  });

  it('renders details > summary + div[data-type="detailsContent"] and parses it back unchanged, closed and open', () => {
    const closed = { type: 'doc', content: [toggle(false, [{ type: 'text', text: 'Packing list' }], [para('Torch')])] };
    expect(render(closed)).toBe('<details><summary>Packing list</summary><div data-type="detailsContent"><p>Torch</p></div></details>');
    expect(roundTrip(closed)).toEqual(closed);
    const open = { type: 'doc', content: [toggle(true, [{ type: 'text', text: 'Packing list' }], [para('Torch')])] };
    expect(render(open)).toBe('<details open=""><summary>Packing list</summary><div data-type="detailsContent"><p>Torch</p></div></details>');
    expect(roundTrip(open)).toEqual(open);
  });

  it('the summary keeps marks and an inline formula', () => {
    const summary = [
      { type: 'text', text: 'Why ', marks: [{ type: 'bold' }] },
      { type: 'inlineMath', attrs: { latex: 'E=mc^2' } }
    ];
    const doc = { type: 'doc', content: [toggle(false, summary, [para('x')])] };
    expect(() => schema.nodeFromJSON(doc).check()).not.toThrow();
    expect(roundTrip(doc)).toEqual(doc);
  });

  it('a toggle holds a toggle', () => {
    const inner = toggle(false, [{ type: 'text', text: 'inner' }], [para('deep')]);
    const doc = { type: 'doc', content: [toggle(true, [{ type: 'text', text: 'outer' }], [inner])] };
    expect(() => schema.nodeFromJSON(doc).check()).not.toThrow();
    expect(roundTrip(doc)).toEqual(doc);
  });

  it('a Telugu summary survives', () => {
    const doc = { type: 'doc', content: [toggle(false, [{ type: 'text', text: 'ప్రయాణ జాబితా' }], [para('టార్చ్')])] };
    expect(roundTrip(doc)).toEqual(doc);
  });

  it('open is a boolean whatever the HTML says', () => {
    const [d] = nodesOf(parse('<details open="false"><summary>s</summary><div data-type="detailsContent"><p>b</p></div></details>'), 'details');
    expect(d.attrs.open).toBe(true); // HTML: the attribute's presence is what opens it
  });

  it('a bare <details> pasted from elsewhere keeps its summary and its text', () => {
    const doc = parse('<details><summary>More</summary><p>hidden words</p></details>');
    const [d] = nodesOf(doc, 'details');
    expect(d.content[0].type).toBe('detailsSummary');
    expect(JSON.stringify(doc)).toContain('More');
    expect(JSON.stringify(doc)).toContain('hidden words');
  });
});

describe('contents block', () => {
  it('is a block atom with no attributes and no content', () => {
    const type = schema.nodes.tableOfContents;
    expect(type.isAtom).toBe(true);
    expect(type.isBlock).toBe(true);
    expect(type.create().attrs).toEqual({});
  });

  it('renders an empty div[data-type="tableOfContents"] and parses it back', () => {
    const doc = { type: 'doc', content: [{ type: 'tableOfContents' }, para('after')] };
    expect(render(doc)).toBe('<div data-type="tableOfContents"></div><p>after</p>');
    expect(roundTrip(doc)).toEqual(doc);
  });

  it('never stores text written inside it', () => {
    const doc = parse('<div data-type="tableOfContents"><ul><li>Packing list</li></ul></div>');
    expect(doc.content).toEqual([{ type: 'tableOfContents' }]);
  });
});

describe('picture: displayWidth, align, caption', () => {
  const image = (attrs) => ({ type: 'noteImage', attrs: { ...schema.nodes.noteImage.create().attrs, ...attrs } });

  it('the three attributes default to null and the pixel size attributes are still there', () => {
    const attrs = schema.nodes.noteImage.create().attrs;
    expect(attrs).toMatchObject({ displayWidth: null, align: null, caption: null, width: null, height: null, path: null });
  });

  it('round-trips through HTML', () => {
    const doc = { type: 'doc', content: [image({ src: 'x.png', displayWidth: 50, align: 'center', caption: 'Araku valley, 0123' })] };
    const html = render(doc);
    expect(html).toContain('data-display-width="50"');
    expect(html).toContain('data-align="center"');
    expect(html).toContain('data-caption="Araku valley, 0123"');
    expect(nodesOf(roundTrip(doc), 'noteImage')[0].attrs).toMatchObject({ displayWidth: 50, align: 'center', caption: 'Araku valley, 0123' });
  });

  it('a caption of digits stays a string (248 fromString coercion)', () => {
    const [img] = nodesOf(parse('<img src="x.png" data-caption="0123">'), 'noteImage');
    expect(img.attrs.caption).toBe('0123');
    const [t] = nodesOf(parse('<img src="x.png" data-caption="true">'), 'noteImage');
    expect(t.attrs.caption).toBe('true');
  });

  it('an out-of-range or malformed value in HTML reads as null', () => {
    const [img] = nodesOf(parse('<img src="x.png" data-display-width="500" data-align="justify" data-caption="   ">'), 'noteImage');
    expect(img.attrs).toMatchObject({ displayWidth: null, align: null, caption: null });
  });

  it('an out-of-range value in stored JSON is not rendered', () => {
    const html = render({ type: 'doc', content: [image({ src: 'x.png', displayWidth: 9999, align: 'x" onerror="y', caption: 7 })] });
    expect(html).not.toContain('data-display-width');
    expect(html).not.toContain('data-align');
    expect(html).not.toContain('data-caption');
    expect(html).not.toContain('onerror');
  });

  it('benign: a picture with none of the three renders none of them', () => {
    const html = render({ type: 'doc', content: [image({ src: 'x.png' })] });
    expect(html).not.toMatch(/data-(display-width|align|caption)/);
  });
});

describe('table cell shade', () => {
  const table = (cellAttrs, headerAttrs) => ({
    type: 'doc',
    content: [{
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null, ...headerAttrs }, content: [para('h')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, ...cellAttrs }, content: [para('c')] }] }
      ]
    }]
  });

  it('tableCell and tableHeader carry background, default null', () => {
    expect(schema.nodes.tableCell.createAndFill().attrs.background).toBeNull();
    expect(schema.nodes.tableHeader.createAndFill().attrs.background).toBeNull();
  });

  it('round-trips a shade on a cell and on a header through data-background', () => {
    const doc = table({ background: 'yellow' }, { background: 'blue' });
    const html = render(doc);
    expect(html).toContain('data-background="yellow"');
    expect(html).toContain('data-background="blue"');
    const back = roundTrip(doc);
    expect(nodesOf(back, 'tableCell')[0].attrs.background).toBe('yellow');
    expect(nodesOf(back, 'tableHeader')[0].attrs.background).toBe('blue');
  });

  it('never copies a colour: an unknown value reads as null and is not rendered', () => {
    const [cell] = nodesOf(parse('<table><tr><td data-background="#ff0000" style="background-color:#ff0000"><p>c</p></td></tr></table>'), 'tableCell');
    expect(cell.attrs.background).toBeNull();
    const html = render(table({ background: 'red" style="background:url(x)' }, { background: null }));
    expect(html).not.toContain('data-background');
    expect(html).not.toContain('url(');
  });

  it('benign: an unshaded table renders no data-background', () => {
    expect(render(table({ background: null }, { background: null }))).not.toContain('data-background');
  });
});

describe('the whole schema still builds, and names the new nodes', () => {
  it('has the five new node types beside the old ones', () => {
    expect(Object.keys(schema.nodes)).toEqual(expect.arrayContaining([
      'callout', 'details', 'detailsSummary', 'detailsContent', 'tableOfContents', 'noteImage', 'inlineMath', 'table'
    ]));
  });
});
