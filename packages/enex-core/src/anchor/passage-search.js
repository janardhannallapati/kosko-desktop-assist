// The scans `findPassage` is built on: every place some words occur, and how much two texts share.
//
// NO PATTERN IS BUILT FROM THE WORDS. The words come from a note a client wrote and the text from a page
// someone else wrote, so the search is Knuth-Morris-Pratt: one pass, time in proportion to the two lengths
// whatever they hold. (`indexOf` and a RegExp can both be made quadratic or worse by a repeating text.)

// For each unit of `words`, the length of the longest start of `words` that also ends there.
function fallbacks(words) {
  const table = new Int32Array(words.length);
  for (let i = 1, k = 0; i < words.length; i += 1) {
    while (k > 0 && words.charCodeAt(i) !== words.charCodeAt(k)) k = table[k - 1];
    if (words.charCodeAt(i) === words.charCodeAt(k)) k += 1;
    table[i] = k;
  }
  return table;
}

// Every place `words` begins in `text` at or after `from`, overlapping places included, at most `max` of them.
export function occurrences(text, words, from = 0, max = Infinity) {
  const found = [];
  if (!words || words.length > text.length) return found;
  const table = fallbacks(words);
  for (let i = Math.max(0, from), k = 0; i < text.length && found.length < max; i += 1) {
    const code = text.charCodeAt(i);
    while (k > 0 && code !== words.charCodeAt(k)) k = table[k - 1];
    if (code === words.charCodeAt(k)) k += 1;
    if (k === words.length) {
      found.push(i - k + 1);
      k = table[k - 1];
    }
  }
  return found;
}

// How many units `text` from `at` onward shares with the start of `words`.
export function sharedStart(text, at, words) {
  let n = 0;
  while (n < words.length && at + n < text.length && text.charCodeAt(at + n) === words.charCodeAt(n)) n += 1;
  return n;
}

// How many units `text` up to `at` shares with the end of `words`.
export function sharedEnd(text, at, words) {
  let n = 0;
  while (n < words.length && at - 1 - n >= 0 && text.charCodeAt(at - 1 - n) === words.charCodeAt(words.length - 1 - n)) n += 1;
  return n;
}
