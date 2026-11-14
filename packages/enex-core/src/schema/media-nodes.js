// The two media nodes: an image, and an attached file of any other type.
//
// SCHEMA ONLY. Kosko's editor draws them with React views (an alt-text field, a player, a placeholder while
// uploading) and adds those with `.extend({ addNodeView })` in app/note-editor-nodes.js, which keeps every
// field below unchanged.
import { Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { imageDisplayWidth, imageAlign, imageCaption } from '../leaves/block-values.js';

// One of the picture's 0.5.0 attributes: read through its rule, and rendered only when it passes the rule.
const ruled = (name, dataName, rule) => ({
  default: null,
  parseHTML: (element) => rule(element.getAttribute(dataName)),
  renderHTML: (attributes) => {
    const value = rule(attributes[name]);
    return value === null ? {} : { [dataName]: String(value) };
  }
});

// The stock Image extension plus `path` (the durable storage path, the source of truth) and the editor's
// own state attributes.
export const NoteImage = Image.extend({
  name: 'noteImage',
  addAttributes() {
    return {
      ...this.parent?.(),
      path: { default: null },
      // A transient flag while the upload is in flight.
      uploading: { default: false },
      // Bytes, from file.size at insert time; feeds Kosko's byte quota on save.
      size: { default: null },
      // True only while a HEIC/HEIF source is being converted: `src` is a local blob no browser can decode.
      heicPending: { default: false },
      // Set when a save is refused for this file's bytes. Never rendered to HTML.
      refused: { default: false, rendered: false },
      // An import placeholder's reason (why the file did not arrive). Kept in the note's JSON, never
      // rendered to HTML.
      missing: { default: null, rendered: false },
      // 0.5.0 (Kosko 726). `width` and `height` above stay the picture's own pixel size; these three say how
      // it is SHOWN. displayWidth is a whole percentage of the text column (10 to 100), so a desk, a peek
      // panel and a phone agree; null is the full column.
      displayWidth: ruled('displayWidth', 'data-display-width', imageDisplayWidth),
      align: ruled('align', 'data-align', imageAlign),
      // The figure's visible text, separate from `alt`. Plain text, one line, at most 500 characters.
      caption: ruled('caption', 'data-caption', imageCaption)
    };
  }
});

// A block-level atom for an attached file. Not built on the Image extension, which assumes an <img>.
export const NoteAttachment = Node.create({
  name: 'noteAttachment',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      path: { default: null },
      src: { default: null },
      mediaType: { default: 'audio' },
      mimeType: { default: null },
      filename: { default: null },
      uploading: { default: false },
      size: { default: null },
      refused: { default: false, rendered: false },
      missing: { default: null, rendered: false }
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-note-attachment]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-note-attachment': '' }];
  }
});
