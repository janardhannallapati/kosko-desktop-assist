// What a reader does with a note that holds blocks its schema does not know (Kosko 726, "The old-reader guard").
//
// WHY THIS EXISTS. Tiptap hands a document to ProseMirror, ProseMirror throws "Unknown node type", and Tiptap
// catches that and loads an EMPTY document with a console warning. The reader then shows an empty note, and
// its next autosave stores the empty note over the real one. So a reader runs `degradeDoc` first: every block
// it does not know becomes a block it does, and no text is dropped.
//
//   degradeDoc(doc, schema) -> { doc, degraded, floor, kinds }
//     doc       the SAME object when nothing needed changing; otherwise a new document `schema` accepts
//     degraded  true when anything was changed (the caller then opens the note read-only)
//     floor     true when the rebuilt note still failed the schema and plain paragraphs were used instead
//     kinds     a count per thing degraded: a node type, `type.attribute`, or `mark.type`
//
// PURE: no DOM, no editor, and never a change to the note it was given. Written without recursion, because a
// stored note is JSON a client wrote and can nest deeper than the JS stack.
//
// NOTE_SCHEMA_VERSION / schemaVersionNeeded are the other half: Kosko's save route compares the version a
// client was built with against the version the STORED note needs, and refuses a save from a client too old
// to have read that note correctly.

// 1: everything through 0.4.x. 2: the 0.5.0 blocks. Raised only when a release adds something an older
// reader would lose.
export const NOTE_SCHEMA_VERSION = 2;

const V2_NODES = new Set(['callout', 'details', 'detailsSummary', 'detailsContent', 'tableOfContents']);
// A Map, not an object: `type` is text a client wrote, and "constructor" or "__proto__" must find nothing.
const V2_ATTRS = new Map([['noteImage', ['displayWidth', 'align', 'caption']], ['tableCell', ['background']], ['tableHeader', ['background']]]);

const isNode = (n) => n !== null && typeof n === 'object' && !Array.isArray(n);
const childrenOf = (n) => (Array.isArray(n.content) ? n.content.filter(isNode) : []);
const isSet = (v) => v !== null && v !== undefined;

export function schemaVersionNeeded(doc) {
  if (!isNode(doc)) return 1;
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop();
    if (V2_NODES.has(node.type)) return 2;
    const attrs = V2_ATTRS.get(node.type);
    if (attrs && isNode(node.attrs) && attrs.some((name) => isSet(node.attrs[name]))) return 2;
    for (const child of childrenOf(node)) stack.push(child);
  }
  return 1;
}

const paragraphOf = (content) => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

function withBold(node, schema) {
  if (node.type !== 'text' || !schema.marks.bold) return node;
  const marks = node.marks || [];
  return marks.some((m) => m.type === 'bold') ? node : { ...node, marks: [...marks, { type: 'bold' }] };
}

// Every text node under these nodes, in order. Used when blocks land where only inline content may go.
function textNodesOf(nodes) {
  const out = [];
  const stack = [...nodes].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'text') out.push(node);
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return out;
}

function count(kinds, key) {
  kinds[key] = (kinds[key] || 0) + 1;
}

function keptText(node, schema, kinds) {
  if (typeof node.text !== 'string' || !node.text) return [];
  if (!Array.isArray(node.marks)) return [{ type: 'text', text: node.text }];
  const marks = [];
  for (const mark of node.marks.filter(isNode)) {
    if (schema.marks[mark.type]) marks.push(mark);
    else count(kinds, `mark.${mark.type}`);
  }
  return [marks.length ? { type: 'text', text: node.text, marks } : { type: 'text', text: node.text }];
}

// A node the schema knows: its unknown attributes are dropped, and a container left empty is given the one
// paragraph the schema needs.
function keptNode(node, kids, schema, kinds) {
  const type = schema.nodes[node.type];
  const spec = type.spec.attrs || {};
  const out = { type: node.type };
  if (isNode(node.attrs)) {
    const attrs = {};
    for (const [name, value] of Object.entries(node.attrs)) {
      if (Object.hasOwn(spec, name)) attrs[name] = value;
      else if (isSet(value)) count(kinds, `${node.type}.${name}`);
    }
    out.attrs = attrs;
  }
  if (Array.isArray(node.marks)) {
    const marks = [];
    for (const mark of node.marks.filter(isNode)) {
      if (schema.marks[mark.type]) marks.push(mark);
      else count(kinds, `mark.${mark.type}`);
    }
    if (marks.length) out.marks = marks;
  }
  if (!type.isLeaf) {
    if (kids.length) out.content = kids;
    else if (!type.contentMatch.validEnd) {
      out.content = type.contentMatch.matchType(schema.nodes.paragraph) ? [paragraphOf([])] : (type.createAndFill()?.toJSON().content ?? []);
    }
  }
  const result = [out];
  // A picture's caption is text. A reader with no `caption` attribute shows it as the line after the picture.
  const caption = node.type === 'noteImage' && !Object.hasOwn(spec, 'caption') ? node.attrs?.caption : null;
  if (typeof caption === 'string' && caption.trim()) result.push(paragraphOf([{ type: 'text', text: caption }]));
  return result;
}

// A node the schema does not know, already holding its degraded children. `inline` says whether the place it
// sits in takes inline content. A toggle's two parts are counted with their toggle; one found outside a toggle
// is counted itself, so the note is still reported as degraded.
function replaced(node, kids, schema, kinds, inline, parentType) {
  const toggleParts = node.type === 'detailsSummary' || node.type === 'detailsContent';
  if (!toggleParts || parentType !== 'details') count(kinds, String(node.type));
  switch (node.type) {
    case 'callout':
      return kids.length && schema.nodes.blockquote ? [{ type: 'blockquote', content: kids }] : kids;
    case 'detailsSummary':
      return kids.length ? [paragraphOf(kids.map((k) => withBold(k, schema)))] : [];
    case 'tableOfContents':
      return [];
    default: {
      // `details` and `detailsContent` land here too: their children are already blocks, and are lifted.
      if (!kids.length) return [];
      const kidsInline = kids.every((k) => k.type === 'text' || schema.nodes[k.type]?.isInline);
      if (kidsInline) return inline ? kids : [paragraphOf(kids)];
      return inline ? textNodesOf(kids) : kids;
    }
  }
}

function rebuild(doc, schema, kinds) {
  // Post-order with an explicit stack: a frame collects its children's replacements, then is replaced itself.
  // `children` is read once per frame: reading it on every step made a long note quadratic.
  const frameOf = (node, inline, into) => ({ node, children: childrenOf(node), kids: [], next: 0, inline, into });
  const root = frameOf(doc, false, null);
  const stack = [root];
  let result = [];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.next < frame.children.length) {
      const child = frame.children[frame.next];
      frame.next += 1;
      const known = schema.nodes[frame.node.type];
      const inline = known ? known.inlineContent : frame.node.type === 'detailsSummary';
      if (child.type === 'text') frame.kids.push(...keptText(child, schema, kinds));
      else stack.push(frameOf(child, inline, frame));
      continue;
    }
    stack.pop();
    const out = schema.nodes[frame.node.type]
      ? keptNode(frame.node, frame.kids, schema, kinds)
      : replaced(frame.node, frame.kids, schema, kinds, frame.inline, frame.into?.node.type);
    if (frame.into) frame.into.kids.push(...out);
    else result = out;
  }
  return result[0];
}

// The floor: every run of text as its own plain paragraph. Used only when the rebuilt note fails the schema.
function plainParagraphs(doc) {
  const out = [];
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop();
    const kids = childrenOf(node);
    if (kids.some((k) => k.type === 'text')) {
      const text = textNodesOf(kids).map((t) => (typeof t.text === 'string' ? t.text : '')).join('');
      if (text) out.push(paragraphOf([{ type: 'text', text }]));
      continue;
    }
    if (node.type === 'noteImage' && typeof node.attrs?.caption === 'string' && node.attrs.caption.trim()) {
      out.push(paragraphOf([{ type: 'text', text: node.attrs.caption }]));
    }
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return { type: 'doc', content: out.length ? out : [paragraphOf([])] };
}

function accepts(schema, doc) {
  try {
    schema.nodeFromJSON(doc).check();
    return true;
  } catch {
    // An invalid note, or one nested past the stack (a RangeError). Either way the floor is next.
    return false;
  }
}

export function degradeDoc(doc, schema) {
  // No prototype: a key is a node type a client wrote, and "__proto__" must count like any other.
  const kinds = Object.create(null);
  if (!isNode(doc) || doc.type !== 'doc' || !Array.isArray(doc.content)) {
    return { doc: plainParagraphs(isNode(doc) ? doc : {}), degraded: true, floor: true, kinds };
  }
  const rebuilt = rebuild(doc, schema, kinds);
  // Nothing unknown: the note is returned as it is, valid or not. A note whose only fault is an old structural
  // quirk loads the way it always has; rewriting it here would turn a note that opens into one that cannot be edited.
  if (!Object.keys(kinds).length) return { doc, degraded: false, floor: false, kinds };
  if (accepts(schema, rebuilt)) return { doc: rebuilt, degraded: true, floor: false, kinds };
  return { doc: plainParagraphs(doc), degraded: true, floor: true, kinds };
}
