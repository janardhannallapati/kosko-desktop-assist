// Finding a quoted passage in a source's text (Kosko 742, decision 4: STRICT).
//
//   findPassage(text, anchor) -> { found: true, start, end, by: 'hint' | 'search' } | { found: false }
//     text     the source's text as `anchorText` gives it
//     anchor   a quote (a ProseMirror node, a JSON node or its attributes) or a highlight's stored values:
//              sourceExact, and optionally sourceCut, sourceLength, sourcePrefix, sourceSuffix, sourceStart.
//              It is read through `readSourceAnchor`, so raw attributes can be handed over as they are.
//     start, end   the place in `text`, in UTF-16 units, so `text.slice(start, end)` is the passage
//
// THE RULE. The place the hint names is tried first, and believed only if the words there are the quoted
// words. Otherwise every place holding the words is found; several places are told apart by the words
// around them (`sourcePrefix`, `sourceSuffix`), then by nearness to the hint, then the first wins. If no place
// holds the words the answer is "not found". "The same words" is the fold of passage-fold.js and nothing
// looser, and a place must begin and end between whole letters (letter-boundary.js). So the answer is never
// a place whose words differ from the quoted ones.
//
// A CUT PASSAGE (longer than 1,000 units when quoted) is stored as its first 500 units, its last 500, and its
// length. It is found where its beginning stands and its ending stands exactly where the length says:
//
//     the units between the two kept ends, in the text  ===  sourceLength - sourceExact.length
//
// measured in the text's own units, from where the beginning's words end to where the ending's words begin.
// THE TOLERANCE IS ZERO. Evening-out can change a length only inside the kept ends (an ellipsis character is
// one unit, three dots are three), and those are matched unit by unit and measured where they actually end,
// so their change is accounted for exactly and never guessed at. What stood between the ends was not stored:
// it is not compared, but it must be exactly as long as it was. One unit more or fewer is "not found".
// Without a valid length a passage is not treated as cut at all (leaves/quote-source.js, `quoteSourceCut`).
//
// PURE and bounded: no pattern is built from the anchor, the search is one linear scan, and at most
// PASSAGE_PLACES_MAX places are tested for whole letters. Past that the answer is "not found": on a hostile
// text a real place can be missed, a wrong one is never given.
import { readSourceAnchor } from '../leaves/quote-source.js';
import { foldText, foldWords } from './passage-fold.js';
import { occurrences, sharedStart, sharedEnd } from './passage-search.js';
import { isLetterBoundary } from './letter-boundary.js';

// Each end of a cut passage is looked for by this many of its units: fewer than the 500 kept, so the units
// next to the cut (one may be missing for a surrogate pair or a space) are checked afterwards, not assumed.
const PIECE = 498;
// How many places are tested for whole letters before giving up.
export const PASSAGE_PLACES_MAX = 10_000;

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

// The anchor, through its rules, as folded words. `head` is the whole passage. For a cut one it is the
// beginning, `tail` the ending, `mid` the few units next to the cut (they belong partly to each end; where
// they divide is not stored), and `gap` how many units of the text stand between the two kept ends.
function wordsOf(given) {
  const anchor = readSourceAnchor(given);
  if (!anchor) return null;
  const exact = anchor.sourceExact.normalize('NFC');
  const whole = foldWords(exact);
  const around = { hint: anchor.sourceStart, before: foldWords(anchor.sourcePrefix ?? ''), after: foldWords(anchor.sourceSuffix ?? '') };
  if (anchor.sourceCut !== true) return { ...around, head: whole, mid: '', tail: '', gap: null };
  const size = Math.min(PIECE, Math.floor(exact.length / 2));
  const head = foldWords(exact.slice(0, isHigh(exact.charCodeAt(size - 1)) ? size - 1 : size));
  const from = exact.length - size;
  const tail = foldWords(exact.slice(isLow(exact.charCodeAt(from)) ? from + 1 : from));
  return { ...around, head, mid: whole.slice(head.length, whole.length - tail.length), tail, gap: anchor.sourceLength - exact.length };
}

// The first folded unit that comes from `at` in the text, or -1 when `at` is not where a character begins.
function foldedAt(starts, at) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] < at) low = middle + 1;
    else high = middle;
  }
  return low < starts.length && starts[low] === at ? low : -1;
}

// Where the passage that begins at folded unit `begin` ends, or -1. For a cut passage each way of dividing
// the units next to the cut is tried: the beginning takes `taken` of them, the text then runs on for exactly
// `gap` units, and the rest of them and the ending must stand right there.
function endOf(map, begin, words) {
  const { folded, starts, ends } = map;
  const headEnd = begin + words.head.length;
  if (words.gap === null) return headEnd;
  for (let taken = sharedStart(folded, headEnd, words.mid); taken >= 0; taken -= 1) {
    const stop = headEnd + taken;
    // Not part of the way through a character that folded to several units.
    if (stop < starts.length && starts[stop] === starts[stop - 1]) continue;
    const resume = foldedAt(starts, ends[stop - 1] + words.gap);
    const rest = words.mid.slice(taken) + words.tail;
    if (resume >= 0 && folded.startsWith(rest, resume)) return resume + rest.length;
  }
  return -1;
}

// A folded span as a place in the text, or null when it begins or ends inside a character that folded to
// several units (an ellipsis) or inside a letter.
function placeOf(text, map, begin, end) {
  const { starts, ends } = map;
  if (begin > 0 && starts[begin - 1] === starts[begin]) return null;
  if (end < starts.length && starts[end] === starts[end - 1]) return null;
  const place = { start: starts[begin], end: ends[end - 1] };
  return isLetterBoundary(text, place.start) && isLetterBoundary(text, place.end) ? place : null;
}

function atHint(text, map, words) {
  const begin = words.hint === null ? -1 : foldedAt(map.starts, words.hint);
  if (begin < 0 || !map.folded.startsWith(words.head, begin)) return null;
  const end = endOf(map, begin, words);
  return end < 0 ? null : placeOf(text, map, begin, end);
}

// Every folded span that holds the words, in the order they stand.
function spansOf(map, words) {
  const begins = [];
  const finishes = [];
  for (const begin of occurrences(map.folded, words.head)) {
    const end = endOf(map, begin, words);
    if (end < 0) continue;
    begins.push(begin);
    finishes.push(end);
  }
  return { begins, finishes };
}

// The best span that is a real place: most of the words around it, then nearest the hint, then first.
function choose(text, map, spans, words) {
  const { begins, finishes } = spans;
  const count = begins.length;
  if (!count) return null;
  const around = (i) => sharedEnd(map.folded, begins[i], words.before) + sharedStart(map.folded, finishes[i], words.after);
  const scores = Uint16Array.from({ length: count }, (_, i) => around(i));
  const far = (i) => (words.hint === null ? 0 : Math.abs(map.starts[begins[i]] - words.hint));
  const order = (a, b) => scores[b] - scores[a] || far(a) - far(b) || a - b;
  let best = 0;
  for (let i = 1; i < count; i += 1) if (order(i, best) < 0) best = i;
  const first = placeOf(text, map, begins[best], finishes[best]);
  if (first || count === 1) return first;
  // The best span was not a place between letters. The rest are tried in order, up to the limit.
  const ranked = Array.from({ length: count }, (_, i) => i).sort(order);
  for (let k = 1; k < count && k < PASSAGE_PLACES_MAX; k += 1) {
    const place = placeOf(text, map, begins[ranked[k]], finishes[ranked[k]]);
    if (place) return place;
  }
  return null;
}

export function findPassage(text, anchor) {
  const words = wordsOf(anchor);
  if (typeof text !== 'string' || !words) return { found: false };
  const map = foldText(text);
  const hinted = atHint(text, map, words);
  if (hinted) return { found: true, ...hinted, by: 'hint' };
  const place = choose(text, map, spansOf(map, words), words);
  return place ? { found: true, ...place, by: 'search' } : { found: false };
}
