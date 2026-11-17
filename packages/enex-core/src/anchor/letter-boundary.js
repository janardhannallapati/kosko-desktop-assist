// Where one letter ends and the next begins, by ONE hand-written rule on every runtime (Kosko 743, review M1).
//
// A letter as a reader sees it can be several code points: a Telugu base letter and its vowel sign, a
// consonant joined to the next by a virama, a letter and a combining accent, a joined emoji, a flag. A quoted
// passage must begin and end between letters, and the web app and the phone must agree where that is.
//
// NO SEGMENTER IS USED. `Intl.Segmenter` is missing on some phone runtimes, and where it exists its answer
// depends on the Unicode version it was built with (ICU 75 splits a Kannada conjunct that it keeps whole in
// Telugu). So the rule is written out here. It is deliberately a little STRICTER than Unicode's (UAX #29):
// it never answers "between letters" where the standard says "inside one" (a test holds it to that on a
// corpus), and in a few places it keeps together what the standard would split. The stricter side is the
// safe one: a passage can fail to be found, it cannot be found in half a letter.
//
// `at` is NOT between letters when:
//   1. it falls inside a surrogate pair, or between a carriage return and its line feed;
//   2. what follows is a mark (any `M` category), a joiner or non-joiner, a variation selector, an emoji
//      skin tone, a tag character, or Thai/Lao sara am: these continue the letter before them, whatever it
//      is. (So a mark after a space or a line break is not a place to begin either.)
//   3. what stands before is a zero-width joiner (it joins what follows: an emoji sequence, a conjunct) or
//      Malayalam's dot reph, which belongs to the letter after it;
//   4. what stands before, joiners aside, is the virama of Devanagari, Bengali, Gurmukhi, Gujarati, Odia,
//      Telugu, Kannada or Malayalam, and a letter of the SAME script follows: a conjunct. Tamil is left out
//      on purpose: its pulli is a visible mark and the next consonant is its own letter.
//   5. it falls between two regional indicators that are the two halves of one flag (an odd number of them
//      stand before it). Only the 64 before it are counted; in a longer run the answer is "not between".
// Everything else is between letters. Conjoining Hangul jamo are not handled: `anchorText` is NFC, which
// composes them into whole syllables.
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const DOT_REPH = 0x0d4e;
const CONTINUES = /^[\p{M}\u200c\u200d\ufe00-\ufe0f\u0e33\u0eb3\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]/u;
const LETTER = /^\p{L}/u;
const TAMIL = 0x0b80;
const FLAG_RUN_MAX = 64;

const isRegional = (point) => point >= 0x1f1e6 && point <= 0x1f1ff;
// The Indic blocks from Devanagari to Malayalam are 128 code points each, with the virama at the same place.
const blockOf = (code) => code & ~0x7f;
const isVirama = (code) => code >= 0x0900 && code <= 0x0d7f && (code & 0x7f) === 0x4d && blockOf(code) !== TAMIL;

// Whether an even number of regional indicators stands directly before `at`. Past the limit the answer is no.
function evenRegionalsBefore(text, at) {
  let count = 0;
  for (let i = at; i >= 2 && isRegional(text.codePointAt(i - 2)); i -= 2) {
    count += 1;
    if (count > FLAG_RUN_MAX) return false;
  }
  return count % 2 === 0;
}

// Rule 4: a virama before `at` (joiners between skipped) and a letter of its script after.
function insideConjunct(text, at, next) {
  let i = at - 1;
  while (i > 0 && at - i <= 4 && (text.charCodeAt(i) === ZWJ || text.charCodeAt(i) === ZWNJ)) i -= 1;
  const before = text.charCodeAt(i);
  return isVirama(before) && blockOf(next) === blockOf(before) && LETTER.test(String.fromCharCode(next));
}

export function isLetterBoundary(text, at) {
  if (at <= 0 || at >= text.length) return true;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  if (isHigh(before) && isLow(after)) return false;
  // Below U+0300 nothing joins to its neighbour, apart from a carriage return and its line feed.
  if (before < 0x300 && after < 0x300) return !(before === 0x0d && after === 0x0a);
  if (before === ZWJ || before === DOT_REPH || CONTINUES.test(text.slice(at, at + 2))) return false;
  if (insideConjunct(text, at, after)) return false;
  return !(isHigh(after) && isRegional(text.codePointAt(at))) || evenRegionalsBefore(text, at);
}
