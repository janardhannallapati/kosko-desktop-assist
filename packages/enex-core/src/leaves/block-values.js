// The value rules of the 0.5.0 blocks (Kosko 726, the schema contract).
//
// Every value these blocks store is one of a fixed list or a bounded whole number. The rule is applied where
// a value ENTERS (HTML parse, the ENML converter) and again where it LEAVES (HTML render), because a stored
// note is JSON a client wrote: nothing between the database and `renderHTML` checks an attribute. A value
// that fails a rule is never repaired from its own text; it becomes the default.
export const CALLOUT_KINDS = Object.freeze(['note', 'info', 'tip', 'warning', 'danger']);
export const CELL_SHADES = Object.freeze(['grey', 'red', 'orange', 'yellow', 'green', 'blue', 'purple']);
export const IMAGE_ALIGNS = Object.freeze(['left', 'center', 'right']);
export const DISPLAY_WIDTH_MIN = 10;
export const DISPLAY_WIDTH_MAX = 100;
export const CAPTION_MAX = 500;

// `includes` on a frozen array, never a lookup on an object: "constructor" is not a callout kind.
const oneOf = (list, value) => (typeof value === 'string' && list.includes(value) ? value : null);

// An unknown kind reads as a plain note: the block and its words matter more than its colour.
export const calloutKind = (value) => oneOf(CALLOUT_KINDS, value) ?? 'note';

export const cellShade = (value) => oneOf(CELL_SHADES, value);

export const imageAlign = (value) => oneOf(IMAGE_ALIGNS, value);

// A whole percentage of the text column. Digits only: "50%", "5e1" and "0x32" are not widths.
export function imageDisplayWidth(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= DISPLAY_WIDTH_MIN && n <= DISPLAY_WIDTH_MAX ? n : null;
}

// One line of plain text. Cut by UTF-16 unit, stepping back one when the cut would split a surrogate pair.
export function imageCaption(value) {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  if (line.length <= CAPTION_MAX) return line;
  const last = line.charCodeAt(CAPTION_MAX - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? CAPTION_MAX - 1 : CAPTION_MAX;
  return line.slice(0, end).trimEnd();
}
