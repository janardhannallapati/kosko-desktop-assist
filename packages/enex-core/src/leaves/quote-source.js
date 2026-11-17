// The value rules of a quote's source (Kosko 742, the schema contract; released as 0.6.0).
//
// A quote may say which saved item it was taken from, and where. Each of the ten values is read through one
// rule here, which returns the cleaned value or null. A rule never throws and never repairs a value from its
// own text: an upper-case uuid is not lower-cased, "5e1" is not a number, a `javascript:` address is not an
// address. The rules run where a value ENTERS (HTML parse, the Evernote converter) and again where it LEAVES
// (HTML render, export), because a stored note is JSON a client wrote.
//
// WITHOUT AN ITEM THERE IS NO SOURCE. `quoteSourceAttrs` is the one statement of that: when `sourceItem`
// fails its rule, every other value is null.
export const QUOTE_SOURCE_ATTRS = Object.freeze(['sourceItem', 'sourceTitle', 'sourceUrl', 'sourceExact', 'sourceCut', 'sourcePrefix', 'sourceSuffix', 'sourceStart', 'sourcePage', 'sourceLength']);
export const QUOTE_SOURCE_DATA = Object.freeze({
  sourceItem: 'data-source-item',
  sourceTitle: 'data-source-title',
  sourceUrl: 'data-source-url',
  sourceExact: 'data-source-exact',
  sourceCut: 'data-source-cut',
  sourcePrefix: 'data-source-prefix',
  sourceSuffix: 'data-source-suffix',
  sourceStart: 'data-source-start',
  sourcePage: 'data-source-page',
  sourceLength: 'data-source-length'
});

// Lengths are UTF-16 units, as `String.length` counts them; a cut never splits a surrogate pair.
export const SOURCE_TITLE_MAX = 200;
export const SOURCE_URL_MAX = 2000;
export const SOURCE_EXACT_MAX = 1000;
export const SOURCE_EXACT_HALF = 500;
export const SOURCE_CONTEXT_MAX = 32;
export const SOURCE_START_MAX = 10_000_000;
export const SOURCE_PAGE_MAX = 100_000;
export const SOURCE_LENGTH_MAX = 1_000_000;

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;
const evened = (value) => value.replace(/\s+/g, ' ');

// The first `max` units, one fewer when the cut would leave half a surrogate pair.
function firstUnits(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, isHigh(text.charCodeAt(max - 1)) ? max - 1 : max);
}

// The last `max` units, one fewer when the cut would leave half a surrogate pair.
function lastUnits(text, max) {
  if (text.length <= max) return text;
  const from = text.length - max;
  return text.slice(isLow(text.charCodeAt(from)) ? from + 1 : from);
}

// The saved item's id: a lower-case uuid in the RFC 4122 layout (a version digit 1 to 8, a variant digit 8,
// 9, a or b). The id is only ever looked up through the caller's own session, so a made-up one finds nothing.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const quoteSourceItem = (value) => (typeof value === 'string' && UUID.test(value) ? value : null);

// Characters that are never part of a title and can make one read as something else: control characters, and
// the bidi embedding, override and isolate controls (U+202A to U+202E, U+2066 to U+2069).
const SPOOFING = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;
// Anywhere in an address, also: whitespace, a backslash, the zero-width space, direction marks, the word
// joiner and invisible operators, the byte order mark. The zero-width joiner and non-joiner are NOT here:
// Persian and Indic addresses carry them unencoded after the host. In the host they are refused with every
// other character a host cannot hold (below).
const HIDDEN_IN_URL = /[\s\\\p{Cc}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;

// One line of plain text. Control characters and bidi controls are taken out (owner, 2026-11-17): a title is
// shown on the source chip, and a title holding a right-to-left override would be drawn as other words.
export function quoteSourceTitle(value) {
  if (typeof value !== 'string') return null;
  const line = evened(evened(value).replace(SPOOFING, '')).trim();
  return line ? firstUnits(line, SOURCE_TITLE_MAX).trimEnd() : null;
}

// The item's original address, kept exactly as written, or null.
//
// PARSED BY HAND, so the answer is the same on every runtime:
//   scheme     `http` or `https`, then two slashes
//   authority  everything up to the first slash, `?` or `#`. It is a host and an optional `:port`, and
//              nothing else: no `@` (so no name or password), no look-alike of `@`, `:` or `/`.
//       host   letters, digits and marks of any script (an IDN host), `-`, `.` and `_`, with at least one
//              letter or digit; OR one bracketed IPv6 literal: hex digits, colons and dots, two colons or more
//       port   one to five digits, at most 65535
//   anywhere   no whitespace, backslash, control character, bidi control or other invisible character
//              (a joiner or non-joiner is allowed after the host)
// THE RUNTIME'S `URL` IS ONE MORE CHECK, never the only one:
//   no `URL` at all                          the hand rule decides alone
//   `URL` cannot construct the address       refused
//   it constructs, and a getter is missing   the hand rule decides alone (an incomplete `URL` on a phone)
//   it constructs and reads it differently   refused (another scheme, a name or password, no host)
const WEB_ADDRESS = /^https?:\/\/([^/?#]*)/i;
const HOST_NAME = /^[\p{L}\p{N}\p{M}._-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const IPV6_HOST = /^\[(?:[0-9a-f]{0,4}:){2,7}[0-9a-f.]{0,15}\]$/i;
const PORT = /:(\d{1,5})$/;
const PORT_MAX = 65535;

function isHostAndPort(authority) {
  const port = PORT.exec(authority);
  if (port && Number(port[1]) > PORT_MAX) return false;
  const host = port ? authority.slice(0, port.index) : authority;
  if (host.startsWith('[')) return IPV6_HOST.test(host);
  return HOST_NAME.test(host) && HAS_LETTER_OR_DIGIT.test(host);
}

function agreesWithUrl(value) {
  if (typeof URL !== 'function') return true;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  try {
    const { protocol, username, password, hostname } = url;
    if ([protocol, username, password, hostname].some((part) => typeof part !== 'string')) return true;
    return (protocol === 'http:' || protocol === 'https:') && username === '' && password === '' && hostname !== '';
  } catch {
    // A URL whose getters are not implemented: the hand rule has already decided.
    return true;
  }
}

export function quoteSourceUrl(value) {
  if (typeof value !== 'string' || value.length > SOURCE_URL_MAX || HIDDEN_IN_URL.test(value)) return null;
  const authority = WEB_ADDRESS.exec(value)?.[1];
  return authority && isHostAndPort(authority) && agreesWithUrl(value) ? value : null;
}

// The passage's words: whitespace evened out, at most 1,000 units. A longer passage keeps its first 500 and
// its last 500, and `cut` says so. Reading a cut passage again changes nothing.
export function quoteSourcePassage(value) {
  if (typeof value !== 'string') return null;
  const line = evened(value).trim();
  if (!line) return null;
  if (line.length <= SOURCE_EXACT_MAX) return { exact: line, cut: false };
  return { exact: firstUnits(line, SOURCE_EXACT_HALF).trimEnd() + lastUnits(line, SOURCE_EXACT_HALF).trimStart(), cut: true };
}

export const quoteSourceExact = (value) => quoteSourcePassage(value)?.exact ?? null;

// The shortest passage a real cut leaves. `quoteSourcePassage` keeps the first 500 and the last 500 units;
// each side loses at most one unit so that no surrogate pair is split, and at most one more when the cut
// falls on a space (the text has single spaces only, and the end is trimmed). So 996 to 1,000 units.
const CUT_MIN = SOURCE_EXACT_MAX - 4;

// True or null. A passage is CUT only when (a) what is stored has the size of a cut passage's two ends, 996
// to 1,000 units, and (b) its length says it was longer than the limit, so longer than what is stored. Then
// the length says how far apart the two ends stand. A flag beside a shorter passage, or with no such length,
// is refused: it would let two words match with any text between them. The passage is then matched whole.
// The flag itself is `true`, the attribute text "true", or implied by a passage that had to be cut just now.
export function quoteSourceCut(flag, exact, length) {
  const passage = quoteSourcePassage(exact);
  const units = quoteSourceLength(length);
  if (!passage || passage.exact.length < CUT_MIN) return null;
  if (units === null || units <= SOURCE_EXACT_MAX) return null;
  return passage.cut || flag === true || flag === 'true' ? true : null;
}

// The words before and after the passage, used to tell two places apart. A space at either end is kept: it is
// part of what stands next to the passage. A prefix keeps the units nearest the passage (its last), a suffix
// its first.
const context = (value, keep) => (typeof value === 'string' && value ? keep(evened(value), SOURCE_CONTEXT_MAX) || null : null);
export const quoteSourcePrefix = (value) => context(value, lastUnits);
export const quoteSourceSuffix = (value) => context(value, firstUnits);

// A whole number in a range, from a number or from digits. "5e1", "0x32", "007", "-3" and "1.0" are not.
function wholeNumber(value, min, max) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d{0,8})$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n + 0 : null;
}

// Where the passage began in the source's text (`anchorText`). A hint only.
export const quoteSourceStart = (value) => wholeNumber(value, 0, SOURCE_START_MAX);

// A PDF's page, counted from 1. Null for an article or a post.
export const quoteSourcePage = (value) => wholeNumber(value, 1, SOURCE_PAGE_MAX);

// How long the passage was when it was quoted, in units of the anchor text (the units `sourceStart` counts).
// A cut passage is found by it: its ending must stand where the length says.
export function quoteSourceLength(value) {
  return wholeNumber(value, 1, SOURCE_LENGTH_MAX);
}

const isAttrs = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A node's attributes, or the attributes themselves. Something with a `type` or an `attrs` is a node, and
// only its `attrs` are read: a value set on the node itself is not an attribute. Only OWN values are read
// anywhere below: attributes are JSON a client wrote, and a prototype must not be able to supply one.
function attrsOf(nodeOrAttrs) {
  if (!isAttrs(nodeOrAttrs)) return {};
  const isNode = Object.hasOwn(nodeOrAttrs, 'type') || Object.hasOwn(nodeOrAttrs, 'attrs');
  if (!isNode) return nodeOrAttrs;
  return Object.hasOwn(nodeOrAttrs, 'attrs') && isAttrs(nodeOrAttrs.attrs) ? nodeOrAttrs.attrs : {};
}

// The type name of a JSON node or a ProseMirror node, or null for bare attributes.
function typeOf(nodeOrAttrs) {
  if (!isAttrs(nodeOrAttrs) || !Object.hasOwn(nodeOrAttrs, 'type')) return null;
  const { type } = nodeOrAttrs;
  return typeof type === 'string' ? type : isAttrs(type) && typeof type.name === 'string' ? type.name : null;
}

const ownOf = (given) => (name) => (Object.hasOwn(given, name) ? given[name] : null);

// The seven values that say where a passage is, each through its rule.
function anchorOf(own) {
  return {
    sourceExact: quoteSourceExact(own('sourceExact')),
    sourceCut: quoteSourceCut(own('sourceCut'), own('sourceExact'), own('sourceLength')),
    sourcePrefix: quoteSourcePrefix(own('sourcePrefix')),
    sourceSuffix: quoteSourceSuffix(own('sourceSuffix')),
    sourceStart: quoteSourceStart(own('sourceStart')),
    sourcePage: quoteSourcePage(own('sourcePage')),
    sourceLength: quoteSourceLength(own('sourceLength'))
  };
}

// THE ANCHOR ALONE, or null when it holds no passage. For a highlight, which has no quote and no item, and
// for `findPassage`. Takes a node or attributes.
export function readSourceAnchor(nodeOrAttrs) {
  const anchor = anchorOf(ownOf(attrsOf(nodeOrAttrs)));
  return anchor.sourceExact === null ? null : anchor;
}

// All ten values through their rules, always under the ten names. Without an item every one is null.
export function quoteSourceAttrs(attrs) {
  const own = ownOf(isAttrs(attrs) ? attrs : {});
  const out = Object.fromEntries(QUOTE_SOURCE_ATTRS.map((name) => [name, null]));
  out.sourceItem = quoteSourceItem(own('sourceItem'));
  if (out.sourceItem === null) return out;
  out.sourceTitle = quoteSourceTitle(own('sourceTitle'));
  out.sourceUrl = quoteSourceUrl(own('sourceUrl'));
  return Object.assign(out, anchorOf(own));
}

// THE ONE WAY TO READ A QUOTE'S SOURCE. Takes a ProseMirror node, a JSON node or bare attributes, and gives
// the ten cleaned values, or null when the quote has no source (no valid item) or the node is not a quote.
//
// Never read a node's own source attributes directly. The rules run when HTML is parsed and when HTML is
// rendered, but a note loaded from stored JSON passes through neither, so a node's attributes are whatever a
// client wrote: a `javascript:` address, a title of any length, a title beside no item.
export function readQuoteSource(nodeOrAttrs) {
  const type = typeOf(nodeOrAttrs);
  if (type !== null && type !== 'blockquote') return null;
  const source = quoteSourceAttrs(attrsOf(nodeOrAttrs));
  return source.sourceItem === null ? null : source;
}
