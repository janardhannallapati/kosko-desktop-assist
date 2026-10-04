import { NOTE_PALETTE } from './note-palette.js';
// 247 — the note text-colour vocabulary, and the one place it is written down.
//
// WHY A VOCABULARY AT ALL, rather than the literal hex `246` shipped. Measured in a real browser:
// the six Wave 1 swatches give 4.83/3.56/5.02/5.17/5.70/4.83 against the light editor panel
// (#ffffff) and 3.67/4.98/3.54/3.43/3.11/3.67 against the dark one (#17181c) — so all but one fail
// AA 4.5:1 for body text in dark mode, and orange fails it in LIGHT mode. That is not a
// palette-picking error and no re-pick fixes it: a brute force over the whole sRGB cube returns
// ZERO colours clearing 4.5:1 against both grounds, because AA on #ffffff needs relative luminance
// <= 0.183 while AA on #17181c needs >= 0.223. Best achievable min-of-both is 4.21:1.
//
// So author-chosen colour is either theme-aware or knowingly AA-on-one-theme, and the only way out
// is to store the SEMANTIC choice and render a per-theme shade (what Notion does). A note stores
// `note-red`; `lib/css-style-value.js` answers it with `var(--note-fg-red, #dc2626)`; `globals.css`
// gives that property a light value and a dark one.
//
// THE SECURITY SHAPE, because this is the one thing not to get wrong. `246`:B1 exists because a
// client-written attribute was interpolated into a `style` attribute. Widening the sanitiser to
// accept `var(--x)` from a client would have been the convenient way to do this and is a real
// loosening — content could then name any custom property the app defines. Instead the client
// supplies a KEY into the closed map below and the sanitiser emits a value of its OWN making, so
// the allowlist is not widened at all: a client-written `var()` is still refused.
//
// WHY THE LIGHT SHADE IS ALSO HERE IN JS: it is the `var()` fallback, which is what keeps a note
// readable where the tokens are not defined (a note copied into a mail client). A test asserts it
// equals the light value declared in globals.css, so the two cannot drift.

// `legacy` is the literal hex the `246` toolbar wrote into content for this colour. It is read as
// the semantic choice it was, at RENDER time — no stored content is rewritten.
//
// Three of the six light shades ARE the legacy hex, so existing light-mode notes are pixel-identical;
// red, orange and grey are darkened, each for a measured AA failure rather than taste. Note text sits
// on TWO surfaces — the editor panel (--panel) and a table header cell's fill (--panel2) — and the
// bar is 4.5:1 against both, which is the standard `246` set for --warn. Measured on white / --panel2:
// orange #ea580c failed outright (3.56 / 3.24), and red #dc2626 and grey #6b7280 passed on white and
// failed on the header fill (4.83 / 4.40). Their replacements are the next step down the same ramp:
// 6.47/5.89, 5.18/4.71 and 7.56/6.88.
export const TEXT_COLOURS = [
  { token: 'note-red', label: 'Red', cssVar: '--note-fg-red', light: NOTE_PALETTE.textLight['note-fg-red'], legacy: '#dc2626' },
  { token: 'note-orange', label: 'Orange', cssVar: '--note-fg-orange', light: NOTE_PALETTE.textLight['note-fg-orange'], legacy: '#ea580c' },
  { token: 'note-green', label: 'Green', cssVar: '--note-fg-green', light: NOTE_PALETTE.textLight['note-fg-green'], legacy: '#15803d' },
  { token: 'note-blue', label: 'Blue', cssVar: '--note-fg-blue', light: NOTE_PALETTE.textLight['note-fg-blue'], legacy: '#2563eb' },
  { token: 'note-purple', label: 'Purple', cssVar: '--note-fg-purple', light: NOTE_PALETTE.textLight['note-fg-purple'], legacy: '#7c3aed' },
  { token: 'note-grey', label: 'Grey', cssVar: '--note-fg-grey', light: NOTE_PALETTE.textLight['note-fg-grey'], legacy: '#6b7280' }
];

// token -> entry. Case-SENSITIVE, matching the `text-align` enum in the sanitiser rather than the
// hex rules: a token is this app's own identifier, not a CSS value, so there is no reason to accept
// a second spelling of it.
const BY_TOKEN = new Map(TEXT_COLOURS.map((c) => [c.token, c]));

// legacy colour -> entry, keyed on the NUMBERS rather than the spelling. A hex is a CSS value with
// more than one written form, and which form arrives depends on the environment: jsdom hands back
// the authored `#dc2626`, while a real browser's CSSOM normalises a parsed style attribute to
// `rgb(220, 38, 38)`. Keying on the spelling would make the legacy alias work in the test
// environment and not in the product — the `10`:B4 shape, where the harness could not reproduce the
// realm the bug lived in. `rgb()` with three integers is the only other form in play, because that
// is what a browser emits for an opaque colour; anything else simply is not one of these six.
const rgbOf = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return hex[1].toLowerCase();
  const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
  if (!fn) return null;
  return fn
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('');
};

const BY_LEGACY = new Map(TEXT_COLOURS.map((c) => [rgbOf(c.legacy), c]));

// The semantic identity of a stored `color` value, or null if it has none — i.e. if it is a colour
// the user did not pick from this palette, which must stay exactly as authored.
export function canonicalTextColour(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const entry = BY_TOKEN.get(v) || BY_LEGACY.get(rgbOf(v));
  return entry ? entry.token : null;
}

// The CSS this app emits for a semantic colour, or null. The returned string is authored HERE, from
// a closed map — the client only ever supplied the key.
export function themeTextColourCss(value) {
  const token = canonicalTextColour(value);
  if (!token) return null;
  const { cssVar, light } = BY_TOKEN.get(token);
  return `var(${cssVar}, ${light})`;
}

// Which swatch the toolbar should show as applied. Three distinct answers, and conflating any two of
// them is a lie to the user:
//   null            — no colour is set, so "Default" is the applied one
//   a token         — that swatch is applied
//   NOT_IN_PALETTE  — a colour IS set but this palette does not own it (pasted or imported, and
//                     preserved verbatim on purpose), so NO swatch is applied. Default must not be,
//                     because Default is the control that REMOVES the colour.
//
// This lives here rather than in the toolbar because of a mutation that SURVIVED: collapsing the
// third answer into the first changed nothing any test could see, since app/note-style-toolbar.js is
// JSX and this repo's vitest config does not transform it — the `245` lesson one layer along, where
// the instrument is blind to the layer the line lives in. The repo's answer to that is the split it
// already uses for library-job-state.js and merge-items.js: the decision is pure and testable, the
// JSX is source-scanned.
export const NOT_IN_PALETTE = Symbol('a colour outside this palette');

export function selectedTextSwatch(storedColour) {
  if (!storedColour) return null;
  return canonicalTextColour(storedColour) ?? NOT_IN_PALETTE;
}
