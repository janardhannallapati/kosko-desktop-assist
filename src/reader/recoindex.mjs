// Evernote stores each attachment's OCR as hex-encoded recoIndex XML:
//   <recoIndex …><item x y w h><t w="87">word</t><t w="50">alternative</t></item>…</recoIndex>
// Each <item> is one recognised region; its <t> elements are candidate readings with a confidence `w`. We keep
// the most confident reading per item, in document order. The format is narrow and fixed, so this is a scanner,
// not a general XML parser — and it never reads the DOCTYPE, so no declared entity can be expanded. Every loop
// moves forward with indexOf, never a lazy regex, so a truncated or hostile record costs linear time.

export class RecoIndexError extends Error {}

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

function decodeEntities(s) {
  return s.replace(ENTITY, (m, ref) => {
    if (ref[0] !== '#') return NAMED[ref] ?? m; // an unknown name (e.g. one declared in a DTD) stays literal
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    // NUL and lone surrogates are not text (Postgres rejects NUL in text); leave the reference literal.
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
    return String.fromCodePoint(code);
  });
}

// CDATA sections are copied verbatim; only the text outside them is entity-decoded. One pass, no re-decoding.
function decode(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = s.indexOf('<![CDATA[', i);
    if (open < 0) return out + decodeEntities(s.slice(i));
    const close = s.indexOf(']]>', open + 9);
    if (close < 0) return out + decodeEntities(s.slice(i)); // unterminated: treat as ordinary text
    out += decodeEntities(s.slice(i, open)) + s.slice(open + 9, close);
    i = close + 3;
  }
}

function confidence(attrs) {
  const m = attrs.match(/\bw\s*=\s*(?:"(\d+)"|'(\d+)')/);
  return m ? Number(m[1] ?? m[2]) : -1;
}

const isNameEnd = (ch) => ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * Yields { attrs, inner } for each <name …>inner</name> in s, in order. A self-closing element yields inner ''.
 * An unterminated element ends the scan (everything after it is incomplete anyway).
 */
function* elements(s, name) {
  const openTag = `<${name}`;
  const closeTag = `</${name}>`;
  let i = 0;
  for (;;) {
    const start = s.indexOf(openTag, i);
    if (start < 0) return;
    if (!isNameEnd(s[start + openTag.length])) { i = start + openTag.length; continue; }
    const gt = s.indexOf('>', start);
    if (gt < 0) return;
    const attrs = s.slice(start + openTag.length, gt);
    if (s[gt - 1] === '/') { yield { attrs, inner: '' }; i = gt + 1; continue; }
    const end = s.indexOf(closeTag, gt + 1);
    if (end < 0) return;
    yield { attrs, inner: s.slice(gt + 1, end) };
    i = end + closeTag.length;
  }
}

/** @returns {{ text: string, wordCount: number }} the top candidate of every recognised item, space-joined. */
export function parseRecoIndex(hex) {
  // Evernote keeps an empty row when it scanned an image and found no text (3,713 of 25,327 on the owner's account).
  if (hex === '') return { text: '', wordCount: 0 };
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new RecoIndexError('OCR record is not valid hex');
  }
  const xml = Buffer.from(hex, 'hex').toString('utf8');
  const start = xml.search(/<recoIndex\b/);
  if (start < 0) throw new RecoIndexError('OCR record is not a recoIndex document');
  const body = xml.slice(start);
  const words = [];
  for (const item of elements(body, 'item')) {
    let best = null;
    let bestW = -Infinity;
    for (const t of elements(item.inner, 't')) {
      const w = confidence(t.attrs);
      if (w > bestW) { best = t.inner; bestW = w; }
    }
    const word = best == null ? '' : decode(best).trim();
    if (word) words.push(word);
  }
  return { text: words.join(' '), wordCount: words.length };
}
