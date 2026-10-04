# @kosko-app/enex-core

The part of [Kosko](https://kosko.app) that has to give the same answer everywhere it runs:

- **`convertEnml(enml, { schema, window })`** turns one Evernote note body (ENML) into Tiptap JSON. Nothing is
  summarised or rewritten. Whatever cannot be mapped is kept verbatim in a `rawHtml` node, and the result
  reports any text it could not keep.
- **`fingerprintNote(note)` / `assignFingerprints(notes)`** compute the `fp1` key that identifies an Evernote
  note across exports, since ENEX carries no note id.
- **`NOTE_SCHEMA_EXTENSIONS` / `noteSchema()`** are the note schema the converter targets. A Tiptap schema is an
  allowlist: anything it does not name is deleted. So the converter and the editor must share one.

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

## Development

```sh
npm install   # npm 11 or later: npm 10.9 crashes resolving vitest's peers
npm test      # vitest; the package's own tests plus a boundary scan of its imports
```

Licensed under Apache-2.0.
