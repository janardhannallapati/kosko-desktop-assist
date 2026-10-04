// note-parity Wave 4 (`248`) — the two nodes that hold content this app cannot interpret.
//
// Both exist for the initiative's governing rule: an import may degrade formatting, it may never
// lose content. Both store a payload VERBATIM and display something else, and keeping those two
// things distinct is the whole design:
//
//   rawHtml     — whatever the Evernote converter could not map to a real node. Stored verbatim,
//                 displayed by the app through its HTML sanitiser, which reports what it could not show.
//   noteLocked  — Evernote's <en-crypt>, a password-protected block whose key we do not have.
//                 Stored verbatim, displayed as a locked block. Today this round-trips to
//                 `<p>U2FsdGVk…</p>`, i.e. the ciphertext is shown to the reader as ordinary note
//                 prose, so this is a CORRECTNESS fix and not only a preservation one.
//
// NAMED `noteLocked`, NOT `noteEncrypted`, on purpose. `nodes` already carries `content_cipher`,
// `title_cipher`, `cipher_nonce` and the `nodes_plaintext_xor_cipher` constraint — this app's own
// node-level envelope encryption, not yet active. Evernote's en-crypt is an opaque blob INSIDE
// content. Two unrelated things called "encrypted" in one codebase is how somebody eventually wires
// one to the other.
//
// SCHEMA ONLY. The views that draw these blocks, including the one innerHTML built from note content and
// the sanitiser that makes it safe, stay in the Kosko app (app/note-opaque-nodes.js). The app adds them with
// `.extend({ addNodeView })`, which keeps every field below unchanged.
import { Node } from '@tiptap/core';

// Reads an attribute as the STRING it is, from the first of `names` that is present. Returning
// undefined (not null) for an absent one lets the node-level getAttrs value stand, which is how
// `<en-crypt>`'s ciphertext — textContent, not an attribute — survives.
function verbatim(...names) {
  return (element) => {
    for (const name of names) {
      const value = element.getAttribute?.(name);
      if (value !== null && value !== undefined) return value;
    }
    return undefined;
  };
}

export const RawHtml = Node.create({
  name: 'rawHtml',
  group: 'block',
  atom: true,
  // `defining` keeps the node itself when content around it is replaced, rather than letting a
  // paste unwrap it and leave the payload loose in a paragraph.
  defining: true,

  // `parseHTML: verbatim` on every attribute, and it is load-bearing rather than tidy. Tiptap merges
  // a per-attribute default over the node-level `getAttrs` (measured in @tiptap/core 3.30.5:
  // `injectExtensionAttributesToParseRule` spreads `newAttributes` AFTER `oldAttributes`), and that
  // default is `fromString(element.getAttribute(name))` — which turns a digits-only string into a
  // Number and "true"/"false" into booleans. On a node whose entire purpose is to preserve a payload
  // byte for byte, a payload of "0123" silently becoming 123 is the content loss this node exists to
  // prevent. Same `fromString` CLAUDE.md already records from `129`:B1, one consequence further on.
  addAttributes() {
    return { html: { default: '', parseHTML: verbatim('data-note-raw-html') } };
  },

  // Its own rendered form only. Nothing converts unrecognised HTML into a rawHtml node on PASTE —
  // the converter decides what it could not map, and this wave makes the schema able to HOLD that
  // decision. A paste rule that swept up unknown markup would change what pasting does for every
  // user to serve an importer that does not exist yet.
  parseHTML() {
    return [
      {
        tag: 'div[data-note-raw-html]',
        getAttrs: (element) => ({ html: element.getAttribute('data-note-raw-html') || '' })
      }
    ];
  },

  // The payload goes in an ATTRIBUTE, so the serializer escapes it and the round trip is inert by
  // construction. This is what copy/paste and the schema-parity tests see; it is deliberately NOT
  // what a reader sees (that is the NodeView below).
  renderHTML({ node }) {
    return ['div', { 'data-note-raw-html': node.attrs.html || '' }];
  }
});

export const NoteLocked = Node.create({
  name: 'noteLocked',
  group: 'block',
  atom: true,
  defining: true,

  // See RawHtml's note on `verbatim`. `<en-crypt>` really does carry attributes called `cipher`,
  // `length` and `hint`, so these are exactly the names Tiptap's default would read and coerce:
  // measured, `length="128"` arrived as the NUMBER 128, and a hint of "false" would have arrived as
  // boolean `false` — which the NodeView's `if (hint)` would then drop, losing a line of the
  // author's own text.
  addAttributes() {
    return {
      ciphertext: { default: '', parseHTML: verbatim('data-ciphertext') },
      cipher: { default: null, parseHTML: verbatim('cipher', 'data-cipher') },
      length: { default: null, parseHTML: verbatim('length', 'data-length') },
      hint: { default: null, parseHTML: verbatim('hint', 'data-hint') }
    };
  },

  parseHTML() {
    return [
      // The real ENML tag, so a pasted or imported `<en-crypt>` is captured before StarterKit's
      // paragraph rule swallows its text. Measured before this wave: it became `<p>U2FsdGVk…</p>`.
      {
        tag: 'en-crypt',
        getAttrs: (element) => ({
          ciphertext: (element.textContent || '').trim(),
          cipher: element.getAttribute('cipher'),
          length: element.getAttribute('length'),
          hint: element.getAttribute('hint')
        })
      },
      // Its own rendered form, for the round trip.
      {
        tag: 'div[data-note-locked]',
        getAttrs: (element) => ({
          ciphertext: element.getAttribute('data-ciphertext') || '',
          cipher: element.getAttribute('data-cipher'),
          length: element.getAttribute('data-length'),
          hint: element.getAttribute('data-hint')
        })
      }
    ];
  },

  renderHTML({ node }) {
    const attrs = { 'data-note-locked': '', 'data-ciphertext': node.attrs.ciphertext || '' };
    // Omitted rather than emitted empty: `data-hint=""` parses back as a hint of "", which would
    // render an empty hint line. An absent attribute parses back as null.
    if (node.attrs.cipher) attrs['data-cipher'] = node.attrs.cipher;
    if (node.attrs.length) attrs['data-length'] = node.attrs.length;
    if (node.attrs.hint) attrs['data-hint'] = node.attrs.hint;
    return ['div', attrs];
  }
});

export const OPAQUE_EXTENSIONS = [RawHtml, NoteLocked];
