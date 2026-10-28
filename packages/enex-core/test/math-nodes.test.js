// @vitest-environment jsdom
//
// Kosko 655 — inlineMath / blockMath, schema only. The JSON and HTML shape is @tiptap/extension-mathematics
// 3.30.5's, so a note written here is a note that extension reads; katex is never a dependency of this package.
import { describe, it, expect } from 'vitest';
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import { noteSchema } from '../src/index.js';

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

// Every node of a type, depth first.
function nodesOf(json, type) {
  const out = [];
  (function walk(n) {
    if (n.type === type) out.push(n);
    (n.content || []).forEach(walk);
  })(json);
  return out;
}

const textOf = (json) => nodesOf(json, 'text').map((t) => t.text).join('');

// KaTeX's real nesting (ChatGPT, claude.ai): the MathML copy carrying the source, then the visible HTML copy.
const katex = (tex, glyph) =>
  `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>` +
  `<mrow><mi>${glyph}</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>` +
  `<span class="katex-html" aria-hidden="true"><span class="base"><span class="mord mathnormal">${glyph}</span></span></span></span>`;

describe('655 maths nodes: schema', () => {
  it('noteSchema() has inlineMath (inline, atom, group inline) and blockMath (atom, group block)', () => {
    const inline = schema.nodes.inlineMath;
    const block = schema.nodes.blockMath;
    expect(inline.isInline).toBe(true);
    expect(inline.isAtom).toBe(true);
    expect(inline.spec.group).toBe('inline');
    expect(block.isBlock).toBe(true);
    expect(block.isAtom).toBe(true);
    expect(block.spec.group).toBe('block');
  });

  it('latex is a string attribute defaulting to an empty string', () => {
    expect(schema.nodes.inlineMath.create().attrs).toEqual({ latex: '' });
    expect(schema.nodes.blockMath.create().attrs).toEqual({ latex: '' });
  });

  it('inlineMath accepts marks (a bold formula stays bold)', () => {
    const bold = schema.marks.bold.create();
    const node = schema.nodes.inlineMath.create({ latex: 'Q' }, null, [bold]);
    const para = schema.nodes.paragraph.create(null, [node]);
    expect(() => para.check()).not.toThrow();
    expect(para.toJSON().content[0].marks).toEqual([{ type: 'bold' }]);
  });
});

describe('655 maths nodes: the extension\'s HTML shape', () => {
  it('parses span[data-type="inline-math"][data-latex] and renders it back unchanged', () => {
    const html = '<p>a <span data-latex="\\theta" data-type="inline-math"></span> b</p>';
    const doc = parse(html);
    expect(nodesOf(doc, 'inlineMath').map((n) => n.attrs.latex)).toEqual(['\\theta']);
    expect(render(doc)).toBe(html);
  });

  it('parses div[data-type="block-math"][data-latex] and renders it back unchanged', () => {
    const html = '<div data-latex="Y = X \\cdot W + B" data-type="block-math"></div>';
    const doc = parse(html);
    expect(doc.content).toEqual([{ type: 'blockMath', attrs: { latex: 'Y = X \\cdot W + B' } }]);
    expect(render(doc)).toBe(html);
  });

  it('keeps data-latex="0123" as the string "0123", never the number 123 (248 fromString coercion)', () => {
    const doc = parse('<p><span data-type="inline-math" data-latex="0123"></span></p>');
    expect(nodesOf(doc, 'inlineMath')[0].attrs.latex).toBe('0123');
    const block = parse('<div data-type="block-math" data-latex="true"></div>');
    expect(block.content[0].attrs.latex).toBe('true');
  });
});

describe('655 maths nodes: rendered maths in pasted HTML (BR2)', () => {
  it('span.katex → one inlineMath holding the annotation\'s TeX, and none of KaTeX\'s duplicate text', () => {
    const doc = parse(`<p>angle ${katex('\\theta', 'θ')} here</p>`);
    expect(nodesOf(doc, 'inlineMath').map((n) => n.attrs.latex)).toEqual(['\\theta']);
    expect(textOf(doc)).toBe('angle  here');
  });

  it('span.katex-display → blockMath', () => {
    const doc = parse(`<p>before</p><span class="katex-display">${katex('Y = XW', 'Y')}</span><p>after</p>`);
    expect(nodesOf(doc, 'blockMath').map((n) => n.attrs.latex)).toEqual(['Y = XW']);
    expect(nodesOf(doc, 'inlineMath')).toEqual([]);
    expect(textOf(doc)).toBe('beforeafter');
  });

  it('a MathML <math> with an x-tex annotation → inlineMath; display="block" → blockMath', () => {
    const math = (display) =>
      `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><semantics><mi>x</mi>` +
      `<annotation encoding="application/x-tex">{\\displaystyle x^2}</annotation></semantics></math>`;
    const inline = parse(`<p>is ${math(false)} now</p>`);
    expect(nodesOf(inline, 'inlineMath').map((n) => n.attrs.latex)).toEqual(['{\\displaystyle x^2}']);
    const block = parse(`<div>${math(true)}</div>`);
    expect(nodesOf(block, 'blockMath').map((n) => n.attrs.latex)).toEqual(['{\\displaystyle x^2}']);
    expect(nodesOf(block, 'inlineMath')).toEqual([]);
  });

  it('mjx-container[data-latex] → inlineMath; display="true" → blockMath', () => {
    const inline = parse('<p>so <mjx-container class="MathJax" jax="CHTML" data-latex="a+b"><mjx-math>a+b</mjx-math></mjx-container></p>');
    expect(nodesOf(inline, 'inlineMath').map((n) => n.attrs.latex)).toEqual(['a+b']);
    expect(textOf(inline)).toBe('so ');
    const block = parse('<mjx-container display="true" data-latex="\\sum_i x_i"><mjx-math>Σ</mjx-math></mjx-container>');
    expect(nodesOf(block, 'blockMath').map((n) => n.attrs.latex)).toEqual(['\\sum_i x_i']);
  });

  it('benign: a plain <span> and a span.katex with no annotation stay text', () => {
    const plain = parse('<p>a <span>b</span> c</p>');
    expect(nodesOf(plain, 'inlineMath')).toEqual([]);
    expect(textOf(plain)).toBe('a b c');
    const bare = parse('<p><span class="katex"><span class="katex-html">θ</span></span></p>');
    expect(nodesOf(bare, 'inlineMath')).toEqual([]);
    expect(textOf(bare)).toBe('θ');
    const noSource = parse('<p><mjx-container><mjx-math>x</mjx-math></mjx-container></p>');
    expect(nodesOf(noSource, 'inlineMath')).toEqual([]);
  });
});
