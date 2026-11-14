// A colour from somewhere else -> the NAME of the nearest cell shade, or null (Kosko 726).
//
// The colour is never kept. A cell stores a name from CELL_SHADES and Kosko's stylesheet gives that name a
// light and a dark value, each measured for contrast; an arbitrary colour would be neither theme-aware nor
// checked. Only two written forms are read, `#rgb`/`#rrggbb` and `rgb()`/`rgba()` with plain numbers: what
// Evernote writes and what a browser's CSSOM rewrites a hex to. Anything else is no shade.
import { NOTE_PALETTE } from './note-palette.js';
import { CELL_SHADES } from './block-values.js';

// The hue of each shade's own colour family, in degrees. A colour maps to the family whose hue is nearest.
const HUES = Object.freeze({ red: 0, orange: 25, yellow: 48, green: 142, blue: 221, purple: 262 });

function rgbOf(value) {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d(?:\.\d+)?|\.\d+)\s*)?\)$/.exec(text);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((c) => c > 255)) return null;
  // Fully transparent is no colour at all.
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
  return channels;
}

const hexOf = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const OWN = new Map(CELL_SHADES.map((shade) => [NOTE_PALETTE.cellLight[shade], shade]));

export function cellShadeOfColour(value) {
  if (typeof value !== 'string') return null;
  const rgb = rgbOf(value);
  if (!rgb) return null;
  // Kosko's own export first, so a shade survives the round trip exactly (its tints are near-white).
  const own = OWN.get(hexOf(rgb));
  if (own) return own;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const light = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  if (saturation < 0.15) return light > 0.93 ? null : 'grey';
  if (light >= 0.985) return null;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  const hue = (sector * 60 + 360) % 360;
  let best = null;
  let bestDistance = Infinity;
  for (const [shade, at] of Object.entries(HUES)) {
    const distance = Math.min(Math.abs(hue - at), 360 - Math.abs(hue - at));
    if (distance < bestDistance) {
      best = shade;
      bestDistance = distance;
    }
  }
  return best;
}
