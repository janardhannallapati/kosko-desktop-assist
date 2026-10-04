// 252 — the leaf work of the pre-pass: resources, verbatim blocks, remote images, code-block text, the
// flattening beyond MAX_DEPTH, and copying an element's attributes. Split out of enml-prepass.js along the
// seam of "one element in, one output out" — nothing here recurses back into the pre-pass, which is what
// lets it live apart from it.
import { NOTE_UPLOADABLE_MIME, CONVERTED_MIME } from '../leaves/note-mime.js';

// The image types the library stores as images, derived from the one allowlist (`222`: two lists for one
// concept drift) — the UPLOADABLE set, so an SVG never becomes an image node while W2 has not made it
// safe to serve — plus HEIC/HEIF, which the upload path converts. Everything else is an attachment.
const IMAGE_NODE_MIME = new Set([...[...NOTE_UPLOADABLE_MIME].filter((m) => m.startsWith('image/')), ...CONVERTED_MIME]);

export const bump = (bag, key) => {
  bag[key] = (bag[key] || 0) + 1;
};

const isBlank = (n) => (n.nodeType === 3 || n.nodeType === 4) && !n.data.trim();

export function mediaHtml(xml, ctx) {
  const mime = (xml.getAttribute('type') || '').toLowerCase();
  const hash = (xml.getAttribute('hash') || '').toLowerCase();
  const size = (name) => {
    const m = /^(\d+)(px)?$/.exec((xml.getAttribute(name) || '').trim());
    return m ? Number(m[1]) : null;
  };
  const node = IMAGE_NODE_MIME.has(mime) ? 'noteImage' : 'noteAttachment';
  const index = ctx.media.length;
  ctx.media.push({ hash, mime, node, width: size('width'), height: size('height'), alt: xml.getAttribute('alt') });
  // A sentinel `src` the post-pass swaps for the real attributes, so no value passes through Tiptap's
  // attribute coercion (`fromString`, 129:B1/248) on its way into the document.
  if (node === 'noteImage') {
    const img = ctx.doc.createElement('img');
    img.setAttribute('src', `enex-media:${index}`);
    return img;
  }
  const div = ctx.doc.createElement('div');
  div.setAttribute('data-note-attachment', '');
  div.setAttribute('src', `enex-media:${index}`);
  return div;
}

export function rawHtmlBlock(xml, ctx) {
  const div = ctx.doc.createElement('div');
  div.setAttribute('data-note-raw-html', new ctx.window.XMLSerializer().serializeToString(xml));
  return div;
}

// A remote image becomes a link to it. An <img> would be a beacon on every render, and a `noteImage`
// without a Storage path is removed by stripPendingMedia on the next save (measured) — so the only way to
// keep the reference is as a reference.
export function remoteImageHtml(xml, ctx) {
  const src = xml.getAttribute('src');
  const a = ctx.doc.createElement('a');
  a.setAttribute('href', src);
  let label = (xml.getAttribute('alt') || '').trim();
  if (!label) {
    try {
      label = decodeURIComponent(new URL(src).pathname.split('/').filter(Boolean).pop() || '') || src;
    } catch {
      label = src;
    }
  }
  a.textContent = label;
  ctx.stats.remoteImages += 1;
  return a;
}

export function codeLines(xml, BLOCK) {
  const lines = [];
  let current = '';
  const textWithBreaks = (node) => {
    let s = '';
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 3 || n.nodeType === 4) s += n.data;
      else if (n.nodeType === 1 && n.localName === 'br') s += '\n';
      else if (n.nodeType === 1) for (let i = n.childNodes.length - 1; i >= 0; i -= 1) stack.push(n.childNodes[i]);
    }
    return s;
  };
  for (const child of xml.childNodes) {
    if (child.nodeType === 1 && BLOCK.has(child.localName)) {
      if (current) lines.push(current);
      current = '';
      lines.push(textWithBreaks(child).replace(/\n$/, ''));
    } else if (child.nodeType === 1 && child.localName === 'br') {
      lines.push(current);
      current = '';
    } else if (!(isBlank(child) && child.data.includes('\n'))) {
      current += textWithBreaks(child);
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

// Beyond MAX_DEPTH: the leaves of a subtree, in document order, found without recursion.
export function flattenedLeaves(xml, DROPPED) {
  const leaves = [];
  const stack = Array.from(xml.childNodes).reverse();
  const ATOMS = new Set(['en-media', 'en-todo', 'en-crypt', 'img', 'br', 'map', 'hr']);
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeType === 3 || n.nodeType === 4 || (n.nodeType === 1 && ATOMS.has(n.localName))) leaves.push(n);
    else if (n.nodeType === 1 && !DROPPED.has(n.localName)) for (let i = n.childNodes.length - 1; i >= 0; i -= 1) stack.push(n.childNodes[i]);
  }
  return leaves;
}

// Attributes the schema reads. Everything else — id, class, on*, data-*, Evernote's own — is not copied.
const KEEP_ATTRS = new Set(['style', 'align', 'href', 'colspan', 'rowspan', 'color', 'face', 'size', 'bgcolor', 'start', 'cipher', 'length', 'hint']);

// A DOM implementation may refuse a valid style: jsdom 29.1.1 THROWS on
// `background:none repeat scroll 0% 0% transparent; background-attachment:scroll; background-color:transparent`
// (found by the corpus run — one real note crashed it). A browser never throws here, but this module also
// runs under jsdom, and a note must never crash an import. The declarations the DOM accepts are kept and
// only the refused ones are lost; the count says so, because a silent catch is how a loss goes unseen.
// Probes run on throwaway elements, and the element that threw is replaced rather than reused: measured, a
// jsdom element whose style setter threw ignores later assignments (text-align came back null).
function acceptedStyle(value, name, ctx) {
  const accepts = (candidate) => {
    try {
      ctx.doc.createElement(name).setAttribute('style', candidate);
      return true;
    } catch {
      return false;
    }
  };
  const kept = [];
  for (const declaration of value.split(';')) {
    if (accepts([...kept, declaration].join(';'))) kept.push(declaration);
  }
  return kept.join(';');
}

export function copyElement(xml, name, ctx) {
  const build = (style) => {
    const el = ctx.doc.createElement(name);
    for (const attr of Array.from(xml.attributes)) {
      if (KEEP_ATTRS.has(attr.name) && attr.name !== 'style') el.setAttribute(attr.name, attr.value);
    }
    if (style !== null) el.setAttribute('style', style);
    return el;
  };
  const style = xml.getAttribute('style');
  let el;
  try {
    el = build(style);
  } catch {
    ctx.stats.degraded.style = (ctx.stats.degraded.style || 0) + 1;
    el = build(acceptedStyle(style, name, ctx));
  }
  if (xml.hasAttribute('title') && xml.localName !== 'a') bump(ctx.stats.degraded, 'title');
  if (xml.localName === 'a' && xml.hasAttribute('title')) el.setAttribute('title', xml.getAttribute('title'));
  if (xml.hasAttribute('dir')) bump(ctx.stats.degraded, 'dir');
  if (xml.hasAttribute('lang') || xml.hasAttribute('xml:lang')) bump(ctx.stats.degraded, 'lang');
  return el;
}
