// Reading a sourced quote back from an Evernote file (Kosko 742, the schema contract; 0.6.0).
//
// Kosko's export writes
//   <blockquote style="--kosko-quote-source:<uuid>; --kosko-quote-page:<n>; --kosko-quote-start:<n>;
//                      --kosko-quote-length:<n>">
//     …the quote's own blocks…
//     <div style="--kosko-quote-cite:1">— <a href="sourceUrl">sourceTitle</a></div>
//   </blockquote>
//
// THE FILE IS NOT TRUSTED. The uuid, the three numbers, the link's text and its address are each read through
// the rule the schema uses (leaves/quote-source.js); nothing from the file is copied into a style, and the
// address passes the scheme rule before it is kept. The passage (`sourceExact`) is rebuilt from the quote's
// own text; the words around it are not in the file, so they are empty.
//
// NO WORD IS LOST. A quote whose marker is not a uuid is converted as the plain quote it is. The cite line is
// taken out of the quote's text only when it is the quote's last line and has exactly the shape above; a line
// of any other shape stays an ordinary line of the quote.
import { QUOTE_SOURCE_DATA, quoteSourceAttrs, quoteSourceItem, quoteSourceTitle, quoteSourceUrl } from '../leaves/quote-source.js';
import { styleMap } from './enml-evernote-styles.js';
import { KOSKO_ENML } from './enml-kosko-blocks.js';

const DASH = '—';
const isText = (n) => n.nodeType === 3 || n.nodeType === 4;
const isBlank = (n) => isText(n) && !n.data.trim();
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

// The quote's last line, when nothing but blank space follows it.
function lastLine(quoteXml) {
  const kids = Array.from(quoteXml.childNodes).filter((n) => !isBlank(n));
  const last = kids[kids.length - 1];
  return last?.nodeType === 1 ? last : null;
}

// { xml, title, url } for a last line that is exactly Kosko's cite line: a div marked `1` holding a dash and
// then one link, the link holding text only, its text a whole title and its address a web address.
function citeOf(quoteXml) {
  const xml = lastLine(quoteXml);
  if (xml?.localName !== 'div' || styleMap(xml).get(KOSKO_ENML.quoteCite) !== '1') return null;
  const parts = Array.from(xml.childNodes).filter((n) => !isBlank(n));
  const [dash, link] = parts;
  if (parts.length !== 2 || !isText(dash) || dash.data.trim() !== DASH) return null;
  if (link.nodeType !== 1 || link.localName !== 'a' || link.children.length) return null;
  const title = quoteSourceTitle(link.textContent);
  const url = quoteSourceUrl(link.getAttribute('href'));
  // A title the limit would cut stays a line of the quote: nothing is cut off unseen.
  return title !== null && title === oneLine(link.textContent) && url !== null ? { xml, title, url } : null;
}

const isSourced = (xml) => quoteSourceItem(styleMap(xml).get(KOSKO_ENML.quoteSource)) !== null;

// The quote's own text, one space between its lines, without what the converter drops (a script, a style)
// and without any cite line that is consumed: its own, and that of every sourced quote inside it, whose cite
// line becomes that quote's title and is not text of the note either.
function passageOf(quoteXml, citeXml, h) {
  let out = '';
  const cites = new Set([citeXml]);
  const stack = [quoteXml];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === 'string') out += node;
    else if (isText(node)) out += node.data;
    else if (node.nodeType === 1 && !cites.has(node) && !h.dropped.has(node.localName)) {
      if (node !== quoteXml && node.localName === 'blockquote' && isSourced(node)) cites.add(citeOf(node)?.xml);
      if (h.block.has(node.localName) || node.localName === 'br') stack.push(' ');
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) stack.push(node.childNodes[i]);
    }
  }
  return out;
}

// A <blockquote> -> the schema's blockquote. One that Kosko marked as sourced carries the source as the
// schema's own data attributes; any other is copied exactly as the pre-pass has always copied a quote.
//   h: { childrenInto, copyElement, block, dropped } from the pre-pass, passed in so this file imports
//   nothing from it.
export function quoteHtml(xml, ctx, depth, h) {
  const map = styleMap(xml);
  if (!isSourced(xml)) {
    const plain = h.copyElement(xml, 'blockquote', ctx);
    h.childrenInto(plain, xml, ctx, depth + 1);
    return plain;
  }
  const cite = citeOf(xml);
  const attrs = quoteSourceAttrs({
    sourceItem: map.get(KOSKO_ENML.quoteSource),
    sourceTitle: cite?.title,
    sourceUrl: cite?.url,
    sourceExact: passageOf(xml, cite?.xml, h),
    sourceStart: map.get(KOSKO_ENML.quoteStart),
    sourceLength: map.get(KOSKO_ENML.quoteLength),
    sourcePage: map.get(KOSKO_ENML.quotePage)
  });
  // A new element, never a copy: the file's own style and attributes are not carried over.
  const el = ctx.doc.createElement('blockquote');
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== null) el.setAttribute(QUOTE_SOURCE_DATA[name], String(value));
  }
  if (cite) {
    // The cite line is now the quote's title and address. It is skipped for THIS conversion only: if the
    // audit rejects the quote and its lines are converted one by one, the line is ordinary text again.
    ctx.skip.add(cite.xml);
    (ctx.quoteCites ??= new Set()).add(cite.xml);
  }
  h.childrenInto(el, xml, ctx, depth + 1);
  return el;
}
