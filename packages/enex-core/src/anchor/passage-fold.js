// What "the same words" means when a quoted passage is looked for in a source (Kosko 742, decision 4: strict).
//
// Two texts hold the same words when they are equal after FOLDING: whitespace runs become one space, letters
// become lower case, and the typographic forms of a quote mark, a dash and the ellipsis become their plain
// form. Nothing else is evened out: a letter, digit or mark added, removed or changed is a different passage.
//
// `foldText` also remembers, for every unit of the folded text, where it came from, so a match found in the
// folded text is answered as a place in the text the caller gave.
//
// Folding is done one code point at a time and never looks at its neighbours (apart from joining whitespace),
// so the fold of a text is the fold of its pieces joined: a passage folds the same wherever it stands.
const PLAIN_FORMS = new Map([
  ...['‘', '’', '‚', '‛', '′', '`', '´'].map((mark) => [mark, "'"]),
  ...['“', '”', '„', '‟', '″', '«', '»'].map((mark) => [mark, '"']),
  ...['‐', '‑', '‒', '–', '—', '―', '−'].map((mark) => [mark, '-']),
  ['…', '...']
]);

// The characters JavaScript's `\s` matches, so this agrees with the whitespace rule of `anchorText`.
export function isSpaceCode(code) {
  if (code < 0x80) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code === 0xa0 || code === 0x1680 || code === 0x3000 || code === 0xfeff) return true;
  return (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f;
}

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

// One code point -> its folded form (one to three units).
function foldPoint(text, at, code, size) {
  if (code < 0x80) {
    if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 32);
    return code === 0x60 ? "'" : text[at];
  }
  const point = size === 1 ? text[at] : text.slice(at, at + 2);
  return PLAIN_FORMS.get(point) ?? point.toLowerCase();
}

// text -> { folded, starts, ends }: `starts[i]` and `ends[i]` are the place in `text` of the character that
// gave folded unit `i`. A whitespace run gives one space, from the run's first unit to its last.
export function foldText(text) {
  const parts = [];
  const starts = [];
  const ends = [];
  let inSpace = false;
  for (let at = 0; at < text.length;) {
    const code = text.charCodeAt(at);
    const size = isHigh(code) && isLow(text.charCodeAt(at + 1)) ? 2 : 1;
    if (isSpaceCode(code)) {
      if (inSpace) ends[ends.length - 1] = at + 1;
      else {
        parts.push(' ');
        starts.push(at);
        ends.push(at + 1);
      }
    } else {
      const out = foldPoint(text, at, code, size);
      parts.push(out);
      for (let unit = 0; unit < out.length; unit += 1) {
        starts.push(at);
        ends.push(at + size);
      }
    }
    inSpace = isSpaceCode(code);
    at += size;
  }
  return { folded: parts.join(''), starts, ends };
}

// The folded words alone, for the passage being looked for.
export const foldWords = (text) => foldText(text).folded;
