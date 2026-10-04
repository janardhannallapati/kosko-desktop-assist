// 252 — an ENML string, turned into a DOM tree the pre-pass can walk. One of the few places in this
// converter that can refuse a note outright, and the reason it does is in the parse itself.
//
// WHY XML AND NOT THE HTML PARSER. ENML is XHTML: `<en-media .../>` is self-closing. The HTML parser does
// not know that for an unknown element, so every sibling after an `<en-media/>` would become its CHILD —
// and the pre-pass decides per element, so a misattributed tree is a wrong decision, not a cosmetic one.
//
// WHY ENTITIES ARE TRANSLATED FIRST. ENML's DTD declares the XHTML entity set and no parser fetches it, so
// `a&nbsp;b` fails an XML parse outright (measured 2026-09-14: "undefined entity"). Older Evernote clients
// write `&nbsp;` constantly; the owner's 11.32.5 corpus writes characters directly, which is exactly the
// one-account blind spot the program's finding 3 warns about.

// The five an XML parser already knows; everything else is translated to a numeric reference.
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

// An internal DTD subset is how an entity gets declared, and a declared entity is how a billion-laughs
// document costs its victim: the expansion happens INSIDE the parser, before any code of ours runs
// (`243` measured 9.4 s for an SVG). Evernote never writes one, so the only safe answer is to refuse the
// note before a parser sees it. Case-insensitive: XML is not, but a lenient parser might be.
const ENTITY_DECLARATION = /<!ENTITY/i;

// A DOCTYPE, with an optional internal subset. The subset case is already refused above; this strips the
// ordinary `<!DOCTYPE en-note SYSTEM "…enml2.dtd">` so no parser is invited to think about a DTD at all.
const DOCTYPE = /<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i;
const XML_DECLARATION = /^\s*<\?xml[\s\S]*?\?>/;
const NAMED_ENTITY = /&([A-Za-z][A-Za-z0-9]{1,31});/g;
const CDATA = /(<!\[CDATA\[[\s\S]*?\]\]>)/;

// Decoded by the browser's OWN entity table, through an RCDATA element in a detached document: a
// `<textarea>`'s content is parsed as text, so no element is ever created and nothing can load or run.
// Restating the ~250-name XHTML table here would be a second copy of something the platform already has.
function entityDecoder(window) {
  const doc = window.document.implementation.createHTMLDocument('');
  const area = doc.createElement('textarea');
  const cache = new Map();
  return (name) => {
    if (!cache.has(name)) {
      area.innerHTML = `&${name};`;
      const value = area.value;
      // Not a name the browser knows: keep the characters the author's note actually contained. The HTML
      // table also matches LEGACY names without a semicolon, so `&notarealentity;` decodes as `&not` +
      // "arealentity;" (measured) — a real full-name match never leaves the `;` behind, except `&semi;`.
      const unknown = value === `&${name};` || (value.endsWith(';') && name !== 'semi');
      cache.set(name, unknown ? `&amp;${name};` : Array.from(value, (ch) => `&#${ch.codePointAt(0)};`).join(''));
    }
    return cache.get(name);
  };
}

function translateEntities(source, window) {
  const decode = entityDecoder(window);
  // CDATA sections are literal text; an `&nbsp;` inside one is six characters, not a space.
  return source
    .split(CDATA)
    .map((part) => (part.startsWith('<![CDATA[') ? part : part.replace(NAMED_ENTITY, (whole, name) => (XML_ENTITIES.has(name) ? whole : decode(name)))))
    .join('');
}

// { ok: false, reason } — refused; nothing may be converted.
// { ok: true, malformed: true } — not well-formed XML; the caller keeps the note verbatim.
// { ok: true, malformed: false, root } — the root element (normally en-note).
export function prepareEnml(enml, { window }) {
  if (typeof enml !== 'string') return { ok: false, reason: 'not-a-string' };
  if (ENTITY_DECLARATION.test(enml)) return { ok: false, reason: 'entity-declaration' };

  const source = translateEntities(enml.replace(/^\uFEFF/, '').replace(XML_DECLARATION, '').replace(DOCTYPE, ''), window);
  const xml = new window.DOMParser().parseFromString(source, 'application/xml');
  // Engines disagree on WHERE they put the error (Firefox: as the root; Chrome: inside it), but both use an
  // element named parsererror, and ENML's DTD has no such element for a real note to contain.
  if (xml.getElementsByTagName('parsererror').length > 0) return { ok: true, malformed: true };
  return { ok: true, malformed: false, root: xml.documentElement };
}
