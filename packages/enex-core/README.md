# @kosko-app/enex-core

The part of [Kosko](https://kosko.app) that has to give the same answer everywhere it runs:

- **`convertEnml(enml, { schema, window })`** turns one Evernote note body (ENML) into Tiptap JSON. Nothing is
  summarised or rewritten. Whatever cannot be mapped is kept verbatim in a `rawHtml` node, and the result
  reports any text it could not keep.
- **`fingerprintNote(note)` / `assignFingerprints(notes)`** compute the `fp1` key that identifies an Evernote
  note across exports, since ENEX carries no note id.
  Since 0.3.0 a note's version is computed over **canonical ENML** (`canonicalEnml`), so the same unchanged note has
  one version whether it came from an ENEX export or Evernote's MCP server.
- **`parseEvernoteNoteLink(href)`** (0.3.0) returns the note GUID an `evernote:///view/…` link names, or `null`.
- **`NOTE_SCHEMA_EXTENSIONS` / `noteSchema()`** are the note schema the converter targets. A Tiptap schema is an
  allowlist: anything it does not name is deleted. So the converter and the editor must share one.

- **0.5.0 adds five things a note can store** (the contract is Kosko's doc 726): a `callout` (five kinds), a toggle
  (`details`, `detailsSummary`, `detailsContent`, the names and HTML of `@tiptap/extension-details`), a
  `tableOfContents` block that stores nothing, a picture's `displayWidth`, `align` and `caption`, and a table
  cell's `background` shade. Each value is one of a fixed list or a bounded whole number (`calloutKind`,
  `cellShade`, `imageDisplayWidth`, `imageAlign`, `imageCaption`); a colour or a style from a file is never stored.
  `convertEnml` reads them back from the markers Kosko's Evernote export writes (`KOSKO_ENML`), reads a picture's
  display width from Kosko's marker or from an Evernote resize (a share of a 720 px column), and maps a cell's colour to the nearest shade name.
- **`degradeDoc(doc, schema)`** (0.5.0) is what a reader runs before loading a note: a block its schema does not
  know becomes one it does (a callout becomes a quote, a toggle becomes its summary in bold and then its body, a
  caption becomes a paragraph), and no text is dropped. Without it Tiptap loads an **empty document** for a note
  holding an unknown block. `schemaVersionNeeded(doc)` and `NOTE_SCHEMA_VERSION` let a server refuse a save from
  a client too old to have read the stored note.

- **0.6.0 adds a quote's source** (the contract is Kosko's doc 742): ten attributes on the existing `blockquote`
  (`sourceItem`, `sourceTitle`, `sourceUrl`, `sourceExact`, `sourceCut`, `sourcePrefix`, `sourceSuffix`,
  `sourceStart`, `sourcePage`, `sourceLength`), added by the `QuoteSource` extension. Each is read through one
  rule on the way in and again on the way out (`quoteSourceItem`, `quoteSourceTitle`, `quoteSourceUrl`,
  `quoteSourceExact`, `quoteSourceCut`, `quoteSourcePrefix`, `quoteSourceSuffix`, `quoteSourceStart`,
  `quoteSourcePage`, `quoteSourceLength`): an id only as a lower-case uuid; an address only as `http:` or
  `https:` with no credentials, parsed by hand so the answer does not depend on the runtime's `URL`; a title
  with control and bidi-override characters taken out; text and whole numbers within the exported bounds.
  Without a valid `sourceItem` no other value is kept, and a plain quote renders exactly as before.
  `convertEnml` reads a sourced quote back from the five `--kosko-quote-*` markers in `KOSKO_ENML`; the cite
  line is consumed only in the exact shape Kosko writes, so no word of a file is lost.
- **`anchorText(source)`, `makeAnchor(text, start, end)` and `findPassage(text, anchor)`** (0.6.0) are the one
  rule for where a quoted passage is. `anchorText` gives the text a passage is measured against (text blocks
  joined by a line break, NFC, whitespace runs made one space; a block with no text adds nothing). `findPassage`
  is strict: the hint is believed only if the words stand there; otherwise the words are searched for after
  whitespace, case and the typographic forms of quotes, dashes and the ellipsis are evened out; several places
  are told apart by the words around them, then by nearness to the hint; anything else is `{ found: false }`.
  A passage longer than 1,000 units is stored cut (its first 500, its last 500 and `sourceLength`) and is found
  only where its ending stands exactly where the length says. The search is a linear scan and builds no
  pattern from its input.
- **`NOTE_SCHEMA_VERSION` is 3** (0.6.0). A note holding a quote with a valid `sourceItem` needs version 3, and
  `degradeDoc` against an older schema keeps the quote and its words and counts the attributes it dropped.

- **0.6.1** makes a stored source equal to what an Evernote file can carry back. A cite line whose link text is
  its own address (whole, or cut to 200 units) reads as a source with no title. `quoteSourceTitle` also takes
  out half a surrogate pair, U+FFFE and U+FFFF, and `quoteSourceUrl` refuses an address holding one: XML 1.0
  cannot hold them, and Kosko's exporter strips them.

### Reading a quote's source: `readQuoteSource(node)`, never `node.attrs`

```js
import { readQuoteSource } from '@kosko-app/enex-core';

const source = readQuoteSource(node); // a ProseMirror node, a JSON node, or its attributes
if (source) link.href = source.sourceUrl ?? '#';
```

The value rules run when HTML is parsed and when HTML is rendered. A note loaded from stored JSON
(`schema.nodeFromJSON`, the editor's `setContent(json)`) passes through neither: ProseMirror keeps whatever the
JSON held, so `node.attrs.sourceUrl` can be a `javascript:` address, `node.attrs.sourceTitle` can be any length,
and a title can sit beside no item. `readQuoteSource` gives the ten cleaned values, or `null` when the quote has
no source. `readSourceAnchor` gives the anchor alone (for a highlight, which has no item), and `findPassage` reads
its anchor the same way, so a node can be handed to it as it is.

ProseMirror's own attribute `validate` was tried and is **not** used: it makes `nodeFromJSON` throw for the whole
note, and Tiptap answers a note it cannot load by loading an empty one. A bad attribute must never cost the
user the note.

### Where a letter ends: one rule on every runtime

A passage must begin and end between whole letters, so a Telugu base letter is not found inside the letter and
its vowel sign. The package does **not** use `Intl.Segmenter`: it is missing on some phone runtimes, and where
it exists its answer depends on its Unicode version. `isLetterBoundary(text, at)` is a hand-written rule, the
same everywhere: a mark, a joiner, a variation selector, a skin tone or a tag continues the letter before it;
a zero-width joiner joins what follows; a virama followed by a letter of the same script is a conjunct in
Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Telugu, Kannada and Malayalam (not Tamil, whose pulli is a
visible mark); two regional indicators are one flag; a surrogate pair and a CR LF are never split. It is a
little stricter than Unicode's rule (UAX #29) and never looser, which a test holds it to: a passage can fail to
be found, it cannot be found in half a letter.

### Limits that fail closed

- `PASSAGE_PLACES_MAX` (10,000): when the same words stand in more places than this and the best-ranked ones
  all fall inside letters, `findPassage` stops and answers `{ found: false }`. A real place can be missed on a
  hostile text; a wrong one is never given.
- A flag run is read back at most 64 regional indicators; inside a longer run no place counts as between letters.
- A cut passage with no valid `sourceLength` is not found. The cut flag is honoured only beside a stored passage
  of 996 to 1,000 units (what a real cut leaves) and a length over 1,000; beside anything else the flag is read
  as unset and the passage is matched whole.
- An address the runtime's `URL` cannot construct is refused. With no `URL` at all, or one whose getters are
  missing, the hand rule decides alone. The host part may hold only letters, digits and marks of any script,
  `-`, `.` and `_`, or one bracketed IPv6 literal, then an optional port up to 65535. A zero-width joiner or
  non-joiner is allowed after the host and nowhere in it.
- `readQuoteSource` reads a node's `attrs` only; values set on the node object itself are not a source.

Kosko's web import and the [desktop tool](../../README.md) in this repository both use this package, pinned to
one exact version, so the same note always becomes the same Kosko note and the same key.

## Use

```js
import { JSDOM } from 'jsdom';
import { convertEnml, noteSchema, fingerprintNote } from '@kosko-app/enex-core';

const { window } = new JSDOM('');
const result = convertEnml(enmlString, { schema: noteSchema(), window });
// { ok: true, doc, media, report }, or { ok: false, reason } when the ENML declares an entity (refused)
const { identity, version } = await fingerprintNote({ created, title, content: enmlString, tags, resources });
```

Without the editor schema, `@kosko-app/enex-core/enex` reads ENEX (`readEnex`), formats dates (`formatEnexDate`), keys
notes (`fingerprintNote`, `assignFingerprints`) and, since 0.2.1, holds the MIME sets (`STORABLE_MIME`,
`NOTE_UPLOADABLE_MIME`, `CONVERTED_MIME`), and since 0.3.0 `canonicalEnml` and `parseEvernoteNoteLink`. It
needs no Tiptap peer.

`window` is always an argument. In a browser, pass the page's own `window`; in Node, pass any DOM
implementation's. The package never touches a global DOM, makes no network call and reads no environment.

## Requirements

- Node 22 or a current browser (it uses `crypto.subtle`).
- **Tiptap 3.30.5 as peer dependencies**, installed by you: `@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`
  and the extensions listed in `package.json`. They are peers, not dependencies, because ProseMirror compares
  node types by identity, and a second copy of `prosemirror-model` breaks the schema. Check with
  `npm ls prosemirror-model`, which should list one version.
- The package has **no runtime dependencies** of its own.

## What it deliberately leaves out

It holds no node views, no editor behaviour and no HTML sanitiser. Kosko's editor adds those itself. The
`rawHtml` node stores third-party HTML as an attribute and never renders it; showing it safely is the host's job.
Likewise `inlineMath` and `blockMath` store a formula's LaTeX source only: there is no katex here, and rendering
it (safely, with KaTeX's `trust` off) is the host's job.
The 0.5.0 blocks are schema only too: the callout's icon, the toggle's folding, the contents list and the cell
colours are drawn by the host from the stored names.

## Development

```sh
npm install   # npm 11 or later: npm 10.9 crashes resolving vitest's peers
npm test      # vitest; the package's own tests plus a boundary scan of its imports
```

## Releasing

Releases are published by `.github/workflows/publish-enex-core.yml` through npm's trusted publishing: no npm token
exists, and each release carries a provenance attestation tying it to the commit that built it.

1. Bump `version` in `package.json` and commit.
2. Push a tag `enex-core-v<version>`, e.g. `git tag enex-core-v0.1.1 && git push origin enex-core-v0.1.1`.
3. Approve the run in GitHub (the `npm-publish` environment waits for the owner).
4. In each consumer (Kosko, the desktop tool), pin the new version exact and run its full suite.

Licensed under Apache-2.0.
