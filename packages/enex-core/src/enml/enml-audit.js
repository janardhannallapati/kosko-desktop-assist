// 252 — "0 characters lost", as a check the converter runs on itself rather than a claim in a doc.
//
// A SUBSEQUENCE, not equality: the converter legitimately ADDS characters — “” for <q>, ☐ for a mid-line
// todo, a URL segment as an image link's text, a due date after a task — and must never REMOVE one. And
// whitespace is ignored on both sides, because outside code it is layout; code blocks are guarded by
// their own tests for exactly that reason. UTF-16 units, deliberately: comparing by code point was
// mutation-tested EQUIVALENT — only a lone surrogate tells the two apart, and XML cannot contain one.
const squash = (text) => String(text ?? '').replace(/\s+/g, '');

export function isTextPreserved(source, output) {
  const want = squash(source);
  const have = squash(output);
  let matched = 0;
  for (let i = 0; i < have.length && matched < want.length; i += 1) {
    if (have[i] === want[matched]) matched += 1;
  }
  return matched === want.length;
}

// Elements whose text is not note content, so the source side does not expect to find it. Kept in step
// with DROPPED in enml-prepass.js by importing it rather than restating it.
export function sourceText(nodes, { skip = new Set(), dropped = new Set() } = {}) {
  let out = '';
  // Iterative: a note can nest deeper than the JS stack (measured: ProseMirror overflows at 3,000).
  const stack = [...nodes].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType === 3 || node.nodeType === 4) {
      out += node.data;
    } else if (node.nodeType === 1 && !skip.has(node) && !dropped.has(node.localName)) {
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) stack.push(node.childNodes[i]);
    }
  }
  return out;
}

// The text a Tiptap document shows or preserves. A rawHtml payload is read through an inert <template>
// — the DOM decodes its entities, and a template's content never loads an image or runs a script.
export function docText(doc, { window }) {
  const template = window.document.createElement('template');
  let out = '';
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'text') out += node.text || '';
    if (node.type === 'noteLocked') out += `${node.attrs?.ciphertext || ''}${node.attrs?.hint || ''}`;
    if (node.type === 'rawHtml') {
      template.innerHTML = node.attrs?.html || '';
      out += template.content.textContent;
    }
    const children = node.content || [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return out;
}
