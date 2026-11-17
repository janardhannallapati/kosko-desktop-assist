// Reading Kosko's own blocks back from an Evernote file (Kosko 726, the schema contract).
//
// Kosko's export marks a callout, a toggle, a contents block and a caption with a custom CSS property, as
// Evernote marks its code block with `--en-codeblock`: ENML allows `style` and nothing like `data-*`. If
// Evernote or another tool strips a marker, the block arrives as ordinary lines of text, which is the floor.
//
// THE FILE IS NOT TRUSTED. A marker's value is matched to a fixed list (`calloutKind`), a width is digits
// parsed to a number, a cell colour is matched to a shade NAME. No value from the file is copied into the
// note as a style, and a marker can only produce a node the schema defines.
import { calloutKind, imageAlign, imageCaption, imageDisplayWidth, DISPLAY_WIDTH_MIN } from '../leaves/block-values.js';
import { cellShadeOfColour } from '../leaves/cell-shade.js';
import { styleMap } from './enml-evernote-styles.js';

export const KOSKO_ENML = Object.freeze({
  callout: '--kosko-callout',
  calloutLabel: '--kosko-callout-label',
  toggle: '--kosko-toggle',
  toggleSummary: '--kosko-toggle-summary',
  toggleBody: '--kosko-toggle-body',
  contents: '--kosko-contents',
  caption: '--kosko-caption',
  // On an <en-media>: the picture's display width as a whole percentage, exactly as the note stores it.
  width: '--kosko-width',
  // 0.6.0 (Kosko 742): on a <blockquote>, the saved item it quotes, the PDF page, the position hint and the passage's length; and on
  // the quote's last line, the cite line. Read by enml-quote-source.js.
  quoteSource: '--kosko-quote-source',
  quotePage: '--kosko-quote-page',
  quoteStart: '--kosko-quote-start',
  quoteLength: '--kosko-quote-length',
  quoteCite: '--kosko-quote-cite'
});

// The column an exported pixel width is written against, and read against.
export const ENML_COLUMN_PX = 720;

const isBlank = (n) => (n.nodeType === 3 || n.nodeType === 4) && !n.data.trim();
const elementsOf = (xml) => Array.from(xml.childNodes).filter((c) => c.nodeType === 1);
const marked = (xml, name) => xml?.nodeType === 1 && styleMap(xml).has(name);

// A pixel width -> a whole percentage of the column, or null for "the column or wider".
export function displayWidthOfPixels(px) {
  if (!Number.isInteger(px) || px <= 0 || px >= ENML_COLUMN_PX) return null;
  return Math.max(DISPLAY_WIDTH_MIN, Math.round((px * 100) / ENML_COLUMN_PX));
}

// A picture's display width, from the strongest evidence the file gives:
//   1. Kosko's own marker, the stored percentage itself;
//   2. Evernote's: a `width` narrower than the `--en-naturalWidth` it wrote beside it, so the user resized it;
//   3. otherwise null. A bare `width` is the picture's own size, and a small picture was not "made small".
export function displayWidthOfMedia(mediaXml, px) {
  const map = styleMap(mediaXml);
  const own = imageDisplayWidth(map.get(KOSKO_ENML.width));
  if (own !== null) return own;
  const natural = /^\d{1,6}$/.test(map.get('--en-naturalwidth') || '') ? Number(map.get('--en-naturalwidth')) : null;
  return natural !== null && Number.isInteger(px) && px < natural ? displayWidthOfPixels(px) : null;
}

// The picture's own pixel size, when Kosko's export wrote it. With a display width set, the `width` and
// `height` attributes are the SHOWN size (what Evernote draws), so the export keeps the real size in Evernote's
// own `--en-naturalWidth` / `--en-naturalHeight`. Read only beside Kosko's marker: an Evernote note's size
// attributes mean what they always have.
export function naturalSizeOfMedia(mediaXml) {
  const map = styleMap(mediaXml);
  if (imageDisplayWidth(map.get(KOSKO_ENML.width)) === null) return null;
  const read = (name) => (/^\d{1,6}$/.test(map.get(name) || '') ? Number(map.get(name)) : null);
  const width = read('--en-naturalwidth');
  const height = read('--en-naturalheight');
  return width && height ? { width, height } : null;
}

// The element a picture's alignment and caption hang on: the div or p that holds the picture and nothing else.
function wrapperOf(mediaXml) {
  const parent = mediaXml.parentNode;
  if (!parent || parent.nodeType !== 1 || !['div', 'p', 'center'].includes(parent.localName)) return null;
  return Array.from(parent.childNodes).every((c) => c === mediaXml || isBlank(c)) ? parent : null;
}

export function alignOfMedia(mediaXml) {
  const wrapper = wrapperOf(mediaXml);
  if (!wrapper) return null;
  if (wrapper.localName === 'center') return 'center';
  return imageAlign((styleMap(wrapper).get('text-align') || wrapper.getAttribute('align') || '').toLowerCase());
}

// The picture a marked caption line belongs to: the one directly before it. `isImage` is the converter's own
// test of the resource type, so a caption never attaches to a PDF.
function captionOwner(captionXml, isImage) {
  const before = captionXml.previousElementSibling;
  if (!before) return null;
  const candidates = before.localName === 'en-media' ? [before] : elementsOf(before).filter((c) => c.localName === 'en-media');
  const [only] = candidates;
  if (candidates.length !== 1 || !isImage(only)) return null;
  return before === only || wrapperOf(only) === before ? only : null;
}

export function captionOfMedia(mediaXml, isImage) {
  const line = (wrapperOf(mediaXml) ?? mediaXml).nextElementSibling;
  if (!marked(line, KOSKO_ENML.caption) || captionOwner(line, isImage) !== mediaXml) return null;
  // A line a caption cannot hold whole (longer than the limit) stays an ordinary line: nothing is cut off.
  const caption = imageCaption(line.textContent);
  return caption !== null && caption === line.textContent.replace(/\s+/g, ' ').trim() ? caption : null;
}

export function shadeOfCell(xml) {
  const map = styleMap(xml);
  return cellShadeOfColour(map.get('background-color') ?? map.get('background') ?? xml.getAttribute('bgcolor'));
}

// The markers are Kosko's, but the file may be anyone's. A marked line is consumed only when it has the shape
// Kosko writes; anything else is converted as the ordinary line it is, so no text is dropped unseen.
const LABEL_MAX = 40;
const inked = (text) => text.replace(/\s+/g, '');
// A callout's label: a few words and no element inside.
const isLabel = (xml) => elementsOf(xml).length === 0 && xml.textContent.trim().length <= LABEL_MAX;
// A contents list: every line of it is the text of a heading in the same note, which is all Kosko writes there.
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const headingsByDoc = new WeakMap();
function headingTexts(doc) {
  let set = headingsByDoc.get(doc);
  if (!set) {
    set = new Set();
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      for (const h of doc.getElementsByTagName(tag)) set.add(oneLine(h.textContent));
    }
    headingsByDoc.set(doc, set);
  }
  return set;
}
function isHeadingList(xml) {
  const headings = headingTexts(xml.ownerDocument);
  let inLines = 0;
  for (const el of xml.getElementsByTagName('*')) {
    if (elementsOf(el).length) continue;
    const line = oneLine(el.textContent);
    if (line && !headings.has(line)) return false;
    inLines += inked(line).length;
  }
  // Text sitting outside every line is not something Kosko wrote either.
  return inked(xml.textContent).length === inLines;
}

// A div that is one of Kosko's blocks -> its HTML in the schema's dialect; `null` for a line that is consumed
// (a callout's label, a claimed caption); `undefined` when the div is nothing of Kosko's.
//   h: { childrenInto, appendAll, isImage } from the pre-pass, passed in so this file imports nothing from it.
export function koskoBlockHtml(xml, map, ctx, depth, h) {
  // A sourced quote's cite line, already read into the quote's attributes (enml-quote-source.js).
  if (ctx.quoteCites?.has(xml)) return null;
  return ownBlockHtml(xml, map, ctx, depth, h);
}

function ownBlockHtml(xml, map, ctx, depth, h) {
  if (map.has(KOSKO_ENML.calloutLabel) && marked(xml.parentNode, KOSKO_ENML.callout) && isLabel(xml)) {
    ctx.skip.add(xml);
    return null;
  }
  if (map.has(KOSKO_ENML.caption) && captionOwner(xml, h.isImage) && captionOfMedia(captionOwner(xml, h.isImage), h.isImage) !== null) {
    ctx.skip.add(xml);
    return null;
  }
  if (map.has(KOSKO_ENML.callout)) {
    const el = ctx.doc.createElement('div');
    el.setAttribute('data-type', 'callout');
    el.setAttribute('data-kind', calloutKind(map.get(KOSKO_ENML.callout)));
    if (elementsOf(xml).length) h.childrenInto(el, xml, ctx, depth + 1);
    else {
      const p = ctx.doc.createElement('p');
      h.appendAll(p, xml.childNodes, ctx, depth + 1);
      el.appendChild(p);
    }
    return el;
  }
  if (map.get(KOSKO_ENML.contents) === '1' && isHeadingList(xml)) {
    // The list inside was written for Evernote's reader. Kosko draws its own from the headings.
    ctx.skip.add(xml);
    const el = ctx.doc.createElement('div');
    el.setAttribute('data-type', 'tableOfContents');
    return el;
  }
  if (map.has(KOSKO_ENML.toggle)) {
    const parts = elementsOf(xml);
    const summaryXml = parts.find((c) => marked(c, KOSKO_ENML.toggleSummary));
    if (!summaryXml) return undefined;
    const bodyXml = parts.find((c) => marked(c, KOSKO_ENML.toggleBody));
    const details = ctx.doc.createElement('details');
    if (map.get(KOSKO_ENML.toggle) === 'open') details.setAttribute('open', '');
    const summary = ctx.doc.createElement('summary');
    h.appendAll(summary, summaryXml.childNodes, ctx, depth + 1);
    const body = ctx.doc.createElement('div');
    body.setAttribute('data-type', 'detailsContent');
    if (bodyXml) h.childrenInto(body, bodyXml, ctx, depth + 1);
    // Lines that are neither the summary nor the marked body still belong to the toggle: nothing is dropped.
    for (const other of parts) {
      if (other !== summaryXml && other !== bodyXml) h.appendAll(body, [other], ctx, depth + 1);
    }
    if (!body.hasChildNodes()) body.appendChild(ctx.doc.createElement('p'));
    details.appendChild(summary);
    details.appendChild(body);
    return details;
  }
  return undefined;
}
