// THE NOTE SCHEMA: what a Kosko note may contain.
//
// A Tiptap schema is an ALLOWLIST. It does not degrade what it cannot name, it silently DELETES it, so every
// entry here is the difference between a construct surviving a paste or an Evernote import and being
// destroyed with no error. Kosko measured this before adding tables, h4-h6 and sub/sup (Kosko 245): a pasted
// table arrived as `<p>alphabeta</p>`.
//
// SCHEMA ONLY: no node view and no editor behaviour. Kosko's editor builds its EXTENSIONS from this list and
// adds its views with `.extend()`; Kosko's parity test fails if the two schemas ever differ. The desktop tool
// uses `noteSchema()` directly, so both convert ENML against the same schema.
import { Extension, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import Superscript from '@tiptap/extension-superscript';
import Subscript from '@tiptap/extension-subscript';
import { STYLE_EXTENSIONS } from './style-marks.js';
import { OPAQUE_EXTENSIONS } from './opaque-nodes.js';
import { TASK_EXTENSIONS } from './task-items.js';
import { NoteImage, NoteAttachment } from './media-nodes.js';
import { isAllowedNoteLink, isAppLinkScheme } from '../leaves/note-link-schemes.js';

// A link the Evernote import rewrote to a Kosko note keeps the `evernote:` address it replaced, so a link
// whose note never arrived is recoverable. Only an `evernote:` value is kept; anything else parses to null.
export const EvernoteLinkOrigin = Extension.create({
  name: 'evernoteLinkOrigin',
  addGlobalAttributes() {
    return [{
      types: ['link'],
      attributes: {
        evernoteHref: {
          default: null,
          parseHTML: (el) => {
            const v = el.getAttribute('data-evernote-href');
            return v && isAppLinkScheme(v) && /^evernote:/i.test(v.trim()) ? v : null;
          },
          renderHTML: (attrs) => (attrs.evernoteHref ? { 'data-evernote-href': attrs.evernoteHref } : {})
        }
      }
    }];
  }
});

export const NOTE_SCHEMA_EXTENSIONS = Object.freeze([
  // `link.isAllowedUri`: Tiptap's web-only scheme list would strip `evernote:///` links. Widened by exactly
  // three schemes (leaves/note-link-schemes.js); javascript: and data: stay refused.
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { isAllowedUri: isAllowedNoteLink } }),
  EvernoteLinkOrigin,
  // `resizable` gives a dragged column border a handle; `renderWrapper` lets a wide table scroll inside the
  // note. Both are display options, kept here so Kosko's editor can use this entry as it is.
  Table.configure({ resizable: true, renderWrapper: true }),
  TableRow,
  TableCell,
  TableHeader,
  Superscript,
  Subscript,
  // Colour, background colour, font size, font family, text align and highlight, each sanitised before it
  // becomes CSS, with legacy `<font>` and `align=` kept.
  ...STYLE_EXTENSIONS,
  // `rawHtml` (what the converter could not map) and `noteLocked` (Evernote's `<en-crypt>`).
  ...OPAQUE_EXTENSIONS,
  // Checklists with real checkboxes.
  ...TASK_EXTENSIONS,
  NoteImage,
  NoteAttachment
]);

let cached;
// The ProseMirror schema built from NOTE_SCHEMA_EXTENSIONS. Built once: a schema is immutable, and
// ProseMirror compares node types by identity, so every caller must share one.
export function noteSchema() {
  cached ??= getSchema([...NOTE_SCHEMA_EXTENSIONS]);
  return cached;
}
