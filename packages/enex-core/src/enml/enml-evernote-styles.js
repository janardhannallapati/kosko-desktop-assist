// 252 — the Evernote 10+ conventions that ride in inline CSS custom properties rather than elements.
// Sources: literal markup in the yarle / Obsidian-importer / Joplin test exports (10.37–10.70), recorded in
// .mdd/docs/252-enml-tiptap-converter.md. None of these occur in the owner's 11.32.5 corpus, which is why
// every one is covered by a synthetic fixture.

// `style` -> Map of lowercased property -> trimmed value. Lowercased because Evernote writes
// `--en-syntaxLanguage` while other writers do not agree on case, and reading a convention is not the
// place to be strict. A value containing `;` inside quotes is not an Evernote convention.
export function styleMap(element) {
  const map = new Map();
  const style = element?.getAttribute?.('style');
  if (!style) return map;
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    if (prop) map.set(prop, declaration.slice(colon + 1).trim());
  }
  return map;
}

// Both dash forms occur: `-en-codeblock:true` from older exports, `--en-codeblock:true` from newer ones.
const either = (map, name) => map.get(`--${name}`) ?? map.get(`-${name}`);

export const isCodeBlock = (map) => either(map, 'en-codeblock') === 'true';

export const codeLanguage = (map) =>
  either(map, 'en-syntaxlanguage') || either(map, 'en-codeblocklanguage') || null;

export const isTodoList = (map) => map.get('--en-todo') === 'true';

export const isChecked = (map) => map.get('--en-checked') === 'true';

// `--en-highlight:<colour>` (any value but false) or the legacy `-evernote-highlight:true`.
export const isHighlight = (map) =>
  (map.has('--en-highlight') && map.get('--en-highlight') !== 'false') || map.get('-evernote-highlight') === 'true';

export const taskGroupId = (map) => (map.get('--en-task-group') === 'true' ? map.get('--en-id') || null : null);

// The style string with some properties removed, for an element whose meaning moved elsewhere (a
// highlight's background moves onto the highlight mark, so it must not ALSO become textStyle).
export function styleWithout(map, names) {
  return [...map].filter(([prop]) => !names.includes(prop)).map(([prop, value]) => `${prop}: ${value}`).join('; ');
}
