// 0.6.0: a quote's source, as attributes on the existing `blockquote` (Kosko 742, the schema contract).
//
// SCHEMA ONLY. A plain quote and a sourced quote are ONE block, so the Quote control, Markdown paste, the drag
// handle and every exporter keep working, and a reader that does not know the attributes keeps the words.
// Kosko's editor draws the source chip from these attributes; nothing here says how it looks.
//
// LOADED FROM STORED JSON, A NODE'S ATTRIBUTES ARE NOT CHECKED: ProseMirror keeps what the JSON held, and the
// note must still load. Read a quote's source with `readQuoteSource(node)`, never from `node.attrs`.
//
// Each attribute is read and written through `quoteSourceAttrs`, so the two rules of the contract hold in one
// place, on the way in (HTML) and on the way out (stored JSON a client wrote, which nothing else checks):
// every value passes its own rule, and without a valid `sourceItem` there is no other value.
// A plain quote therefore renders exactly as it did before 0.6.0: no attribute at all.
import { Extension } from '@tiptap/core';
import { QUOTE_SOURCE_ATTRS, QUOTE_SOURCE_DATA, quoteSourceAttrs } from '../leaves/quote-source.js';

const fromElement = (element) => Object.fromEntries(QUOTE_SOURCE_ATTRS.map((name) => [name, element.getAttribute(QUOTE_SOURCE_DATA[name])]));

const attribute = (name) => ({
  default: null,
  parseHTML: (element) => quoteSourceAttrs(fromElement(element))[name],
  renderHTML: (attributes) => {
    const value = quoteSourceAttrs(attributes)[name];
    return value === null ? {} : { [QUOTE_SOURCE_DATA[name]]: String(value) };
  }
});

export const QuoteSource = Extension.create({
  name: 'quoteSource',
  addGlobalAttributes() {
    return [{
      types: ['blockquote'],
      attributes: Object.fromEntries(QUOTE_SOURCE_ATTRS.map((name) => [name, attribute(name)]))
    }];
  }
});

export const QUOTE_EXTENSIONS = Object.freeze([QuoteSource]);
