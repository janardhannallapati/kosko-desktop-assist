// The note schema as @kosko-app/enex-core 0.4.0 built it: the reader a tab left open from before 0.5.0 runs.
// Rebuilt here from the 0.4.0 source (note-schema.js and media-nodes.js at that release) so the degrade
// tests check against a real old schema and not against today's with a node deleted by name.
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import Superscript from '@tiptap/extension-superscript';
import Subscript from '@tiptap/extension-subscript';
import { STYLE_EXTENSIONS } from '../../src/schema/style-marks.js';
import { OPAQUE_EXTENSIONS } from '../../src/schema/opaque-nodes.js';
import { TASK_EXTENSIONS } from '../../src/schema/task-items.js';
import { NoteAttachment } from '../../src/schema/media-nodes.js';
import { MATH_EXTENSIONS } from '../../src/schema/math-nodes.js';
import { EvernoteLinkOrigin } from '../../src/schema/note-schema.js';
import { isAllowedNoteLink } from '../../src/leaves/note-link-schemes.js';

const NoteImage040 = Image.extend({
  name: 'noteImage',
  addAttributes() {
    return {
      ...this.parent?.(),
      path: { default: null },
      uploading: { default: false },
      size: { default: null },
      heicPending: { default: false },
      refused: { default: false, rendered: false },
      missing: { default: null, rendered: false }
    };
  }
});

let cached;
export function schema040() {
  cached ??= getSchema([
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { isAllowedUri: isAllowedNoteLink } }),
    EvernoteLinkOrigin,
    Table.configure({ resizable: true, renderWrapper: true }),
    TableRow, TableCell, TableHeader, Superscript, Subscript,
    ...STYLE_EXTENSIONS, ...OPAQUE_EXTENSIONS, ...TASK_EXTENSIONS,
    NoteImage040, NoteAttachment, ...MATH_EXTENSIONS
  ]);
  return cached;
}
