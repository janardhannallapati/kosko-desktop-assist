// The two maths nodes: a formula inside a line, and a formula on its own line (Kosko 655).
//
// SCHEMA ONLY, and no katex. The names, the one attribute and the HTML shape are @tiptap/extension-mathematics
// 3.30.5's (`span[data-type="inline-math"][data-latex]`, `div[data-type="block-math"][data-latex]`), so a note
// written here is a note that extension reads. That extension imports katex at module top; this package must
// keep exactly its two runtime dependencies, and the desktop tool never renders a formula. Kosko's editor draws
// them with `.extend({ addNodeView })`, loading katex only when a note shows one.
//
// `latex` is the formula's source and the only thing stored. Rendered maths pasted from elsewhere is read back
// to its source:
//   KaTeX (ChatGPT, claude.ai) keeps the source in `annotation[encoding="application/x-tex"]` inside
//     `.katex-mathml`; `span.katex-display` is a display formula.
//   MathML with the same annotation (Wikipedia); `display="block"` is a display formula.
//   MathJax `mjx-container` carrying `data-latex`; `display="true"` is a display formula.
// Rendered maths with no recoverable source is left to the schema's other rules (its visible text), because
// guessing TeX from glyphs would store a formula nobody wrote. Each node is an atom, so the parser never
// descends into the rendering and KaTeX's duplicate MathML text never reaches the note.
import { Node, mergeAttributes } from '@tiptap/core';

const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';
// Above the style marks' `span` rules, so a KaTeX span is a formula and not a styled run.
const RENDERED_PRIORITY = 100;

// The formula's source from any shape above, or null. A string always: Tiptap's `fromString` would turn a
// formula "0123" into the number 123 (Kosko 248), so this attribute never takes the default parse.
function sourceOf(element) {
  const own = element.getAttribute?.('data-latex');
  if (typeof own === 'string') return own;
  const annotation = element.querySelector?.(TEX_ANNOTATION);
  const tex = annotation?.textContent;
  return typeof tex === 'string' ? tex.trim() : null;
}

// A rendered formula is only a formula when its source came with it.
const hasSource = (element) => (sourceOf(element) ? null : false);

const latexAttribute = () => ({
  latex: {
    default: '',
    parseHTML: (element) => sourceOf(element) ?? '',
    renderHTML: (attributes) => ({ 'data-latex': attributes.latex })
  }
});

export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: latexAttribute,
  parseHTML() {
    return [
      { tag: 'span[data-type="inline-math"]' },
      { tag: 'span.katex', priority: RENDERED_PRIORITY, getAttrs: hasSource },
      { tag: 'math', priority: RENDERED_PRIORITY, getAttrs: (el) => (el.getAttribute('display') === 'block' ? false : hasSource(el)) },
      { tag: 'mjx-container', priority: RENDERED_PRIORITY, getAttrs: (el) => (el.getAttribute('display') === 'true' ? false : hasSource(el)) }
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'inline-math' })];
  }
});

export const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,
  addAttributes: latexAttribute,
  parseHTML() {
    return [
      { tag: 'div[data-type="block-math"]' },
      { tag: 'span.katex-display', priority: RENDERED_PRIORITY, getAttrs: hasSource },
      { tag: 'math[display="block"]', priority: RENDERED_PRIORITY + 1, getAttrs: hasSource },
      { tag: 'mjx-container[display="true"]', priority: RENDERED_PRIORITY + 1, getAttrs: hasSource }
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'block-math' })];
  }
});

export const MATH_EXTENSIONS = Object.freeze([InlineMath, BlockMath]);
