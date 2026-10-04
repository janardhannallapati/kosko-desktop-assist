// Shared by the converter tests (Kosko 252). It builds the note schema once and wraps convertEnml so every
// fixture's output is also run through `schema.nodeFromJSON(doc).check()` — the demo-state says "the
// live schema accepts unchanged", and that is checked on every assertion, not in one place.
import { noteSchema } from '../../src/schema/note-schema.js';
import { convertEnml } from '../../src/enml/enml-convert.js';

export const schema = noteSchema();

export function conv(body, options = {}) {
  const enml = body.startsWith('<?xml') || body.startsWith('<en-note') ? body : `<en-note>${body}</en-note>`;
  const result = convertEnml(enml, { schema, window, ...options });
  if (result.ok) (options.schema || schema).nodeFromJSON(result.doc).check();
  return result;
}

export function nodesOf(doc, type) {
  const out = [];
  (function walk(node) {
    if (node.type === type) out.push(node);
    (node.content || []).forEach(walk);
  })(doc);
  return out;
}

export function topTypes(doc) {
  return (doc.content || []).map((n) => n.type);
}

export function textOf(node) {
  let s = '';
  (function walk(n) {
    if (n.type === 'text') s += n.text;
    (n.content || []).forEach(walk);
  })(node);
  return s;
}
