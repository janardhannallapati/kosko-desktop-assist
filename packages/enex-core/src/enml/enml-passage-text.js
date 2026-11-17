// A quote's passage while it is being read from an Evernote file, held in BOUNDED space (Kosko 743).
//
// The passage stored for a quote is `quoteSourcePassage(text)`: the text with whitespace evened out, whole when
// it is at most 1,000 units, else its first 500 and last 500. So of a quote's text only three things are ever
// needed: how it begins, how it ends, and how long it is. That is what is kept here, and no more: the first
// PASSAGE_KEEP units, the last PASSAGE_KEEP (a little more between trims), and the length. A quote's whole
// text is never built, however large the quote.
//
// It also makes a passage something that can be ADDED TO ANOTHER in constant time, which is what lets an
// outer quote reuse the passage already read for a quote inside it (enml-quote-source.js).
//
// The text kept is in "evened" form: every whitespace run one space, NOT trimmed (a space at either end still
// matters to whatever is joined on next). Where two pieces meet with a space on both sides, one is dropped.
//
// `passageText` gives a short stand-in for the whole text: `quoteSourcePassage(passageText(p))` is exactly
// `quoteSourcePassage(the whole text)`. A test holds it to that against the plain way of doing it.
export const PASSAGE_KEEP = 2000;
// Each end of the stand-in for a long text. More than the 500 the rule reads, with room for a trimmed space
// and a surrogate pair at the cut; two of them are longer than the 1,000 limit, so the rule still cuts.
const STAND_IN = 700;

export const newPassage = () => ({ length: 0, head: '', tail: '' });

// Join `length` evened units on to `p`, given their beginning and their ending (each the whole piece when it
// is shorter than PASSAGE_KEEP).
function append(p, length, head, tail) {
  let [units, first, last] = [length, head, tail];
  if (units && p.length && p.tail.endsWith(' ') && first.startsWith(' ')) {
    if (last.length === units) last = last.slice(1);
    first = first.slice(1);
    units -= 1;
  }
  if (!units) return;
  if (p.head.length < PASSAGE_KEEP) p.head = (p.head + first).slice(0, PASSAGE_KEEP);
  p.tail = last.length >= PASSAGE_KEEP ? last : p.tail + last;
  // Trimmed only now and then, so a quote of many small pieces is not copied once for each of them.
  if (p.tail.length > PASSAGE_KEEP * 4) p.tail = p.tail.slice(-PASSAGE_KEEP);
  p.length += units;
}

export function addText(p, text) {
  const evened = text.replace(/\s+/g, ' ');
  const long = evened.length > PASSAGE_KEEP;
  append(p, evened.length, long ? evened.slice(0, PASSAGE_KEEP) : evened, long ? evened.slice(-PASSAGE_KEEP) : evened);
}

export function addPassage(p, inner) {
  append(p, inner.length, inner.head, inner.tail);
}

export function passageText(p) {
  return p.length <= PASSAGE_KEEP ? p.head : p.head.slice(0, STAND_IN) + p.tail.slice(-STAND_IN);
}
