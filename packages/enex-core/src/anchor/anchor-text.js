// The text an anchor is measured against, and the anchor of a selection in it (Kosko 742, the schema contract).
//
//   anchorText(source) -> string
//     source   a note-schema document (JSON), or plain text (one PDF page's text content)
//
// THE RULE, one statement for the web app, the phone and tests: one text block after another, joined by a
// line break; Unicode NFC; every run of whitespace made one space; each block trimmed.
//
// WHAT COUNTS, for a document:
//   - A TEXT BLOCK is a node that holds text directly: a paragraph, a heading, a code block, a toggle's
//     summary. Its text is its text runs joined with nothing between them; marks are ignored.
//   - A hard break inside a block is one space. A line break inside a code block is one space.
//   - Containers (a list, a quote, a callout, a toggle, a table, its rows and cells) add nothing of their own:
//     their text blocks follow in document order, a table cell by cell, row by row.
//   - Everything with no text adds NOTHING, not even an empty line: a picture (its caption and alt text are
//     attributes, not source text), an attached file, a rule, a contents block, a formula (block or inline),
//     a verbatim HTML block, a locked block, an empty paragraph. So adding or removing one moves no passage's
//     words, only the position hint, which is checked before it is believed.
// For plain text each line is a block.
//
// A line break therefore appears ONLY between blocks, and a passage that runs across blocks holds one.
// `findPassage` treats it as the space it folds to.
//
// PURE and not recursive: a stored document is JSON a client wrote and can nest deeper than the stack.
import { quoteSourcePassage, quoteSourcePrefix, quoteSourceSuffix, quoteSourceStart, quoteSourceLength, quoteSourceCut, SOURCE_CONTEXT_MAX } from '../leaves/quote-source.js';
import { isSpaceCode } from './passage-fold.js';
import { isLetterBoundary } from './letter-boundary.js';

const isNode = (n) => n !== null && typeof n === 'object' && !Array.isArray(n);
const childrenOf = (n) => (Array.isArray(n.content) ? n.content.filter(isNode) : []);
const LINE_BREAK = /\r\n?|[\n\u2028\u2029]/;

// One text block's text: every text run under it, in order.
function runsOf(block) {
  let out = '';
  const stack = childrenOf(block).reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'text') out += typeof node.text === 'string' ? node.text : '';
    else if (node.type === 'hardBreak') out += ' ';
    else {
      const kids = childrenOf(node);
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
  }
  return out;
}

function blocksOf(doc) {
  const blocks = [];
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop();
    const kids = childrenOf(node);
    if (kids.some((kid) => kid.type === 'text')) blocks.push(runsOf(node));
    else for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return blocks;
}

export function anchorText(source) {
  const blocks = typeof source === 'string' ? source.split(LINE_BREAK) : isNode(source) ? blocksOf(source) : [];
  return blocks.map((block) => block.normalize('NFC').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// The stored values for the selection [start, end) of `text` (which `anchorText` gave), or null when that is
// not a selection of any words. Whitespace at either end is left out, and an end that falls inside a letter
// (a base letter without its vowel sign, half an emoji) is widened to the whole letter, because a passage
// that ends inside a letter could never be found again. A selection that begins on a mark with no letter
// before it (after a space, at the start of a block) cannot be widened to a letter: null. So every anchor
// this gives is found by `findPassage` in the same text, in the same place.
// `sourceLength` is the passage's length in this text's units; a cut passage is found by it.
export function makeAnchor(text, start, end) {
  if (typeof text !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > text.length || start >= end) return null;
  let from = start;
  let to = end;
  while (from < to && isSpaceCode(text.charCodeAt(from))) from += 1;
  while (to > from && isSpaceCode(text.charCodeAt(to - 1))) to -= 1;
  if (from === to) return null;
  while (!isLetterBoundary(text, from)) from -= 1;
  while (!isLetterBoundary(text, to)) to += 1;
  if (isSpaceCode(text.charCodeAt(from)) || isSpaceCode(text.charCodeAt(to - 1))) return null;
  const passage = quoteSourcePassage(text.slice(from, to));
  // One unit more than the limit is handed over, so the rule can see a surrogate pair the limit would split.
  const reach = SOURCE_CONTEXT_MAX + 1;
  return {
    sourceExact: passage.exact,
    sourceCut: quoteSourceCut(passage.cut, passage.exact, to - from),
    sourcePrefix: quoteSourcePrefix(text.slice(Math.max(0, from - reach), from)),
    sourceSuffix: quoteSourceSuffix(text.slice(to, to + reach)),
    sourceStart: quoteSourceStart(from),
    sourceLength: quoteSourceLength(to - from)
  };
}
