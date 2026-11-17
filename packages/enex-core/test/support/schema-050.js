// The note schema as @kosko-app/enex-core 0.5.0 built it: the reader a tab left open from before 0.6.0 runs.
// Rebuilt here from the 0.5.0 source (the extension list of note-schema.js at that release), the way
// schema-040.js was, so the degrade tests check against a real old schema and not against today's with an
// attribute deleted by name. 0.6.0 added one extension, the quote's source attributes; nothing below has it.
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import Superscript from '@tiptap/extension-superscript';
import Subscript from '@tiptap/extension-subscript';
import { STYLE_EXTENSIONS } from '../../src/schema/style-marks.js';
import { OPAQUE_EXTENSIONS } from '../../src/schema/opaque-nodes.js';
import { TASK_EXTENSIONS } from '../../src/schema/task-items.js';
import { NoteImage, NoteAttachment } from '../../src/schema/media-nodes.js';
import { MATH_EXTENSIONS } from '../../src/schema/math-nodes.js';
import { Callout, Details, DetailsSummary, DetailsContent, TableOfContents, CellBackground } from '../../src/schema/block-nodes.js';
import { EvernoteLinkOrigin } from '../../src/schema/note-schema.js';
import { isAllowedNoteLink } from '../../src/leaves/note-link-schemes.js';

let cached;
export function schema050() {
  cached ??= getSchema([
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { isAllowedUri: isAllowedNoteLink } }),
    EvernoteLinkOrigin,
    Table.configure({ resizable: true, renderWrapper: true }),
    TableRow, TableCell, TableHeader, Superscript, Subscript,
    ...STYLE_EXTENSIONS, ...OPAQUE_EXTENSIONS, ...TASK_EXTENSIONS,
    NoteImage, NoteAttachment, ...MATH_EXTENSIONS,
    Callout, Details, DetailsSummary, DetailsContent, TableOfContents, CellBackground
  ]);
  return cached;
}
