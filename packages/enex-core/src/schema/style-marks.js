// note-parity Wave 1 (`246`). The presentational half of inline styling — colour, background
// colour, font size, font family and text alignment — wrapped so that two things are true which
// are not true of the stock extensions.
//
// 1. EVERY client-written value passes through `sanitiseStyleValue` before it becomes CSS
//    (`246`:B1). The stock extensions interpolate their attribute straight into a style string:
//    `renderHTML: (attrs) => ({ style: `color: ${attrs.color}` })`. Content JSON carrying
//    `color: "red;background-image:url(https://evil.test/beacon)"` therefore rendered an arbitrary
//    declaration list. See lib/css-style-value.js for why the guard belongs at RENDER.
//
// 2. Legacy ENML survives. Real Evernote HTML is old: 34% of the measured notes use `<font
//    color=...>`, and paragraphs carry `align="center"` rather than a CSS property. The stock
//    extensions read only the CSS property, so both were measured as dropped entirely.
//
// Each wrapper takes the parent's definition and replaces ONLY the dangerous half, keeping the
// library's own `parseHTML` wherever it is already correct — restating a parse rule here would be
// a second statement of it, and this repo keeps getting bitten by exactly that.
import { TextStyle, Color, BackgroundColor, FontFamily, FontSize } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { sanitiseStyleValue } from '../leaves/css-style-value.js';
import { canonicalTextColour } from '../leaves/note-colours.js';

// The legacy `<font size>` scale is 1-7 and is NOT a length — `size="5"` means "x-large", not 5 of
// anything. Mapped to the em ladder browsers have always used for it.
const LEGACY_FONT_SIZES = ['0.63em', '0.82em', '1em', '1.13em', '1.5em', '2em', '3em'];

function legacyFontSize(raw) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  // The array IS the bound: the legacy scale has exactly seven sizes, so anything outside 1-7
  // indexes past it. Normalised to null so the refusal is deliberate rather than incidental.
  // An explicit `n < 1 || n > 7` stood here and was mutation-proven EQUIVALENT — Tiptap falls back
  // to the attribute's `default: null` when parseHTML returns undefined, so no test could ever tell
  // the two apart. Two statements of one bound is the shape this repo keeps getting bitten by.
  return Number.isInteger(n) ? LEGACY_FONT_SIZES[n - 1] ?? null : null;
}

// Replaces one attribute's renderHTML inside an addGlobalAttributes() result, leaving every other
// attribute and the parent's parseHTML untouched. `legacyAttr` optionally widens the PARSE side to
// an old HTML attribute the extension does not know about. `tokenAttr` adds a marker attribute for a
// value this app translates rather than emits verbatim (247) — see below for why it is load-bearing.
// Values the colour sanitiser accepts that are not colours: nothing to clamp, and a relative colour
// built from `inherit` or `currentcolor` is invalid CSS, so they keep plain inline behaviour.
const CSS_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'transparent', 'currentcolor']);

function sanitisedGlobalAttribute(extension, { attrName, cssProperty, legacyAttr, mapLegacy, tokenAttr, tokenOf, literalAttr }) {
  return extension.extend({
    addGlobalAttributes() {
      const groups = this.parent?.() || [];
      return groups.map((group) => {
        const spec = group.attributes?.[attrName];
        if (!spec) return group;
        const parentParse = spec.parseHTML;
        return {
          ...group,
          attributes: {
            ...group.attributes,
            [attrName]: {
              ...spec,
              parseHTML: (element) => {
                // 247: the marker is read BEFORE the CSS property, and that order is the whole
                // point. What renderHTML wrote into `style` for a themed colour is
                // `var(--note-fg-red, #dc2626)` — this app's shade for the CURRENT theme, not the
                // author's choice — so reading the style back would store a var() that the
                // sanitiser then refuses, losing the colour. Measured: before this, a paste of our
                // own output round-tripped to `<p><span>x</span></p>`.
                if (tokenAttr && element.getAttribute) {
                  const token = element.getAttribute(tokenAttr);
                  if (token) return token;
                }
                const fromCss = parentParse?.(element);
                if (fromCss) return fromCss;
                if (!legacyAttr || !element.getAttribute) return fromCss;
                const legacy = element.getAttribute(legacyAttr);
                if (!legacy) return fromCss;
                return mapLegacy ? mapLegacy(legacy) : legacy;
              },
              // THE guard. A refused value emits no declaration at all rather than a partial or
              // guessed one, so the text survives and only the styling is lost.
              renderHTML: (attributes) => {
                const raw = attributes[attrName];
                const safe = sanitiseStyleValue(cssProperty, raw);
                if (safe === null) return {};
                const out = { style: `${cssProperty}: ${safe}` };
                // A legacy literal from this palette gains the marker here, so a note canonicalises
                // itself the moment someone copies or edits it. Nothing stored is rewritten —
                // 214's import bypass exists so a restamp of thousands of rows is impossible, and a
                // JSONB migration would have been exactly that.
                const token = tokenAttr ? tokenOf?.(raw) : null;
                if (token) out[tokenAttr] = token;
                // 247:B1: a colour from OUTSIDE the palette is stored exactly as authored, and its
                // rendered lightness is clamped by globals.css into the band that clears 4.5:1 on
                // both note surfaces in the current theme. The stylesheet needs the value, so it is
                // handed over as a custom property holding `safe` — the SAME sanitised string already
                // in the declaration, so no new path from content to CSS exists. The inline `color`
                // stays first, as the fallback wherever that rule does not apply (a mail client).
                else if (literalAttr && !CSS_KEYWORDS.has(safe.toLowerCase())) {
                  out.style = `${cssProperty}: ${safe}; --note-literal-fg: ${safe}`;
                  out[literalAttr] = '';
                }
                return out;
              }
            }
          }
        };
      });
    }
  });
}

// `<font color|face|size>` carries no `style`, so TextStyle's own parse rule (which requires one)
// rejects it outright. This adds the element as a second rule; the attribute-level parseHTML
// widenings below are what actually read its attributes.
export const NoteTextStyle = TextStyle.extend({
  parseHTML() {
    return [
      ...(this.parent?.() || []),
      {
        tag: 'font',
        consuming: false,
        getAttrs: (element) =>
          element.hasAttribute('color') || element.hasAttribute('face') || element.hasAttribute('size')
            ? {}
            : false
      }
    ];
  }
});

export const NoteColor = sanitisedGlobalAttribute(Color, {
  attrName: 'color',
  cssProperty: 'color',
  legacyAttr: 'color',
  tokenAttr: 'data-note-color',
  literalAttr: 'data-note-literal-color',
  tokenOf: canonicalTextColour
});

export const NoteBackgroundColor = sanitisedGlobalAttribute(BackgroundColor, {
  attrName: 'backgroundColor',
  cssProperty: 'background-color',
  legacyAttr: 'bgcolor'
});

export const NoteFontFamily = sanitisedGlobalAttribute(FontFamily, {
  attrName: 'fontFamily',
  cssProperty: 'font-family',
  legacyAttr: 'face'
});

export const NoteFontSize = sanitisedGlobalAttribute(FontSize, {
  attrName: 'fontSize',
  cssProperty: 'font-size',
  legacyAttr: 'size',
  mapLegacy: legacyFontSize
});

// `align="center"` on a paragraph or heading predates the CSS property and is all over real ENML.
export const NoteTextAlign = sanitisedGlobalAttribute(
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  { attrName: 'textAlign', cssProperty: 'text-align', legacyAttr: 'align' }
);

// Highlight keeps its value in BOTH a style and a `data-color` attribute, and the attribute is what
// parseHTML reads back on the next load — so sanitising only the style would let the refused value
// return through the front door.
export const NoteHighlight = Highlight.configure({ multicolor: true }).extend({
  addAttributes() {
    const parent = this.parent?.() || {};
    const spec = parent.color || {};
    return {
      ...parent,
      color: {
        ...spec,
        renderHTML: (attributes) => {
          const safe = sanitiseStyleValue('background-color', attributes.color);
          if (safe === null) return {};
          // Deliberately NO `color: inherit` (which the stock extension emits): an inline
          // declaration beats any stylesheet, and in dark mode `inherit` resolves to the light
          // --ink, giving light text on an author-chosen light highlight. The foreground is left
          // to globals.css, which can state the one rule that holds in both themes.
          return { 'data-color': safe, style: `background-color: ${safe}` };
        }
      }
    };
  }
});

export const STYLE_EXTENSIONS = [
  NoteTextStyle,
  NoteColor,
  NoteBackgroundColor,
  NoteFontFamily,
  NoteFontSize,
  NoteTextAlign,
  NoteHighlight
];
