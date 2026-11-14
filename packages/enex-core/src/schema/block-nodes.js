// The 0.5.0 blocks: a callout, a toggle, a contents block, and a table cell's shade (Kosko 726).
//
// SCHEMA ONLY. Kosko's editor draws each with `.extend({ addNodeView })` and adds its keys; the desktop tool
// only converts. The stored shape is permanent once a real note holds one, so each node says here exactly
// what it stores and nothing about how it looks.
//
// THE TOGGLE keeps the names and the HTML of @tiptap/extension-details 3.30.5 (`details`, `detailsSummary`,
// `detailsContent`; `details > summary + div[data-type="detailsContent"]`), so a note written here is a note
// that extension reads. The code is ours: the extension's summary is text only, and its behaviour was
// measured short on keyboard and screen-reader support (726, "Dependency verdict").
import { Node, Extension, mergeAttributes } from '@tiptap/core';
import { calloutKind, cellShade } from '../leaves/block-values.js';

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  // Paragraphs and lists only: a callout is a short aside, and a heading or table inside one has no
  // Evernote or Markdown form that reads sensibly.
  content: '(paragraph | bulletList | orderedList | taskList)+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => calloutKind(element.getAttribute('data-kind')),
        renderHTML: (attributes) => ({ 'data-kind': calloutKind(attributes.kind) })
      }
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0];
  }
});

export const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      // Stored, so a note reopens the way it was left. In HTML the attribute's presence opens it.
      open: {
        default: false,
        parseHTML: (element) => element.hasAttribute('open'),
        renderHTML: (attributes) => (attributes.open === true ? { open: '' } : {})
      }
    };
  },
  parseHTML() {
    return [{ tag: 'details' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['details', HTMLAttributes, 0];
  }
});

export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  // Marks and inline formulas, where the extension allows text only.
  content: 'inline*',
  defining: true,
  isolating: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'summary' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['summary', HTMLAttributes, 0];
  }
});

export const DetailsContent = Node.create({
  name: 'detailsContent',
  content: 'block+',
  defining: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'div[data-type="detailsContent"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'detailsContent' }), 0];
  }
});

// The contents block stores NOTHING: no attributes and no heading text. The editor draws the list from the
// note's headings every time, so it cannot go stale. An atom, so the parser never reads what is inside the
// element (an Evernote export carries the list as plain text for Evernote's reader).
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  parseHTML() {
    return [{ tag: 'div[data-type="tableOfContents"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'tableOfContents' })];
  }
});

// A cell's shade is a NAME from the fixed list. The colour itself is a design token Kosko's stylesheet owns,
// with a light and a dark value; a colour from a file is matched to a name by the converter and never stored.
export const CellBackground = Extension.create({
  name: 'cellBackground',
  addGlobalAttributes() {
    return [{
      types: ['tableCell', 'tableHeader'],
      attributes: {
        background: {
          default: null,
          parseHTML: (element) => cellShade(element.getAttribute('data-background')),
          renderHTML: (attributes) => {
            const shade = cellShade(attributes.background);
            return shade ? { 'data-background': shade } : {};
          }
        }
      }
    }];
  }
});

export const BLOCK_EXTENSIONS = Object.freeze([Callout, Details, DetailsSummary, DetailsContent, TableOfContents, CellBackground]);
