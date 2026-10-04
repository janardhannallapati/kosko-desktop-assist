// The seven colour values the schema and the converter need.
//
// Kosko's design tokens (design/tokens.json, generated into lib/design-tokens.js) are the design source.
// This package cannot read that generated file, so it carries these values, and Kosko's
// lib/__tests__/note-palette-parity.test.js fails if any of them differs from the tokens.
export const NOTE_PALETTE = Object.freeze({
  // The light-theme shade of each note text colour: the fallback inside `var(--note-fg-*, <shade>)`.
  textLight: Object.freeze({
    'note-fg-red': '#b91c1c',
    'note-fg-orange': '#c2410c',
    'note-fg-green': '#15803d',
    'note-fg-blue': '#2563eb',
    'note-fg-purple': '#7c3aed',
    'note-fg-grey': '#4b5563'
  }),
  // The highlight an imported `--en-highlight` gets when Evernote did not say which colour.
  highlightImportDefault: 'yellow'
});
