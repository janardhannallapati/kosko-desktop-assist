// 252 — ENML elements -> the schema's own HTML dialect, one explicit decision per construct.
//
// This is NOT a second statement of the schema's parse rules (`10`:B2). Anything the schema already reads
// correctly (tables, h1–h6, sub/sup, <font>, links, <en-crypt>) is copied and left to the schema. This file
// only exists for the constructs a probe measured the schema LOSING when handed raw ENML (2026-09-14): the
// decision table in .mdd/docs/252-enml-tiptap-converter.md is the spec, one row per branch below.
import { NOTE_PALETTE } from '../leaves/note-palette.js';
import { styleMap, isCodeBlock, codeLanguage, isHighlight, taskGroupId, styleWithout } from './enml-evernote-styles.js';
import { mediaHtml, rawHtmlBlock, remoteImageHtml, codeLines, flattenedLeaves, copyElement, bump } from './enml-blocks.js';
import {
  leadingTodo,
  isTodoLine,
  todoEntries,
  isClassicTodoList,
  isEvernoteTodoList,
  evernoteChecked,
  groupTasks
} from './enml-todos.js';

// Measured: ProseMirror's parser overflows the stack between 1,000 and 3,000 levels. Beyond this depth
// wrappers are unwrapped and only their leaves are converted, so structure degrades and content does not.
export const MAX_DEPTH = 200;

// Not note content: code, styling, document chrome and form controls. Dropped WITH their text and counted.
// Form containers and legacy presentational elements that hold visible text (form, label, button,
// textarea, fieldset, legend, noscript, marquee, …) are NOT here — they fall through as transparent, so
// their text survives.
export const DROPPED = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'base', 'iframe', 'object', 'embed', 'applet', 'param', 'frame', 'frameset', 'noframes', 'bgsound', 'input', 'select', 'option', 'optgroup']);

// Elements that make an ENML <div> a CONTAINER rather than a paragraph.
const BLOCK = new Set(['div', 'p', 'center', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'dt', 'dd', 'li', 'table', 'pre', 'blockquote', 'hr', 'address', 'en-crypt', 'map', 'form', 'fieldset']);

const isBlank = (n) => (n.nodeType === 3 || n.nodeType === 4) && !n.data.trim();
const hasBlockChild = (el) => Array.from(el.childNodes).some((c) => c.nodeType === 1 && BLOCK.has(c.localName));

export function newStats() {
  return { todoGlyphs: 0, taskGroups: { resolved: 0, unresolved: 0 }, highlights: 0, remoteImages: 0, depthCapped: false, degraded: {}, dropped: {} };
}

// ctx: { doc (HTML document), window, tasks, media (manifest, shared), stats, skip (source text to ignore) }

// Runs of a container's children: consecutive todo lines together (they become ONE task list), consecutive
// inline nodes together, and every other block alone. The converter uses the same runs as its audit units.
export function groupRuns(nodes) {
  const runs = [];
  let open = null;
  for (const node of nodes) {
    const kind = node.nodeType === 1 && isTodoLine(node) ? 'todo' : node.nodeType === 1 && BLOCK.has(node.localName) ? 'block' : node.nodeType === 1 || node.nodeType === 3 || node.nodeType === 4 ? 'inline' : null;
    if (!kind) continue;
    if (kind !== 'block' && open?.kind === kind) open.nodes.push(node);
    else runs.push((open = { kind, nodes: [node] }));
    if (kind === 'block') open = null;
  }
  return runs.filter((run) => run.nodes.some((n) => !isBlank(n)));
}

export function runToHtml(run, ctx, depth = 0) {
  const frag = ctx.doc.createDocumentFragment();
  if (run.kind === 'todo') frag.appendChild(todoRunHtml(run.nodes, ctx, depth));
  else if (run.kind === 'inline') {
    const p = ctx.doc.createElement('p');
    appendAll(p, run.nodes, ctx, depth);
    frag.appendChild(p);
  } else appendAll(frag, run.nodes, ctx, depth);
  return frag;
}

function appendAll(parent, nodes, ctx, depth) {
  for (const node of nodes) {
    const out = toHtml(node, ctx, depth);
    if (out) parent.appendChild(out);
  }
}

// A container's children, with todo lines batched into task lists.
function childrenInto(parent, xml, ctx, depth) {
  for (const run of groupRuns(xml.childNodes)) {
    if (run.kind === 'todo') parent.appendChild(todoRunHtml(run.nodes, ctx, depth));
    else appendAll(parent, run.nodes, ctx, depth);
  }
}

function taskItemHtml(ctx, checked, fill) {
  const li = ctx.doc.createElement('li');
  li.setAttribute('data-type', 'taskItem');
  li.setAttribute('data-checked', checked ? 'true' : 'false');
  fill(li);
  return li;
}

function taskListHtml(ctx) {
  const ul = ctx.doc.createElement('ul');
  ul.setAttribute('data-type', 'taskList');
  return ul;
}

// Classic todo lines: consecutive task entries share a list; a plain line between them is a paragraph.
function todoRunHtml(elements, ctx, depth) {
  const frag = ctx.doc.createDocumentFragment();
  let list = null;
  for (const entry of todoEntries(elements)) {
    if (entry.task) {
      ctx.consumed.add(entry.todo);
      if (!list) frag.appendChild((list = taskListHtml(ctx)));
      list.appendChild(taskItemHtml(ctx, entry.checked, (li) => {
        const p = ctx.doc.createElement('p');
        appendAll(p, entry.nodes, ctx, depth + 1);
        li.appendChild(p);
      }));
    } else {
      list = null;
      const p = copyElement(entry.from, 'p', ctx);
      appendAll(p, entry.nodes, ctx, depth + 1);
      frag.appendChild(p);
    }
  }
  return frag;
}

// A code block holding media, a locked block, a table or a todo is not mapped: its text-only form would
// delete them, and formatting may degrade where content may not.
const NOT_IN_CODE = ['en-media', 'en-crypt', 'img', 'table', 'en-todo'];

function divHtml(xml, ctx, depth) {
  const map = styleMap(xml);
  if (isCodeBlock(map) && NOT_IN_CODE.every((name) => xml.getElementsByTagName(name).length === 0)) {
    const pre = ctx.doc.createElement('pre');
    const code = ctx.doc.createElement('code');
    const language = codeLanguage(map);
    if (language) code.setAttribute('class', `language-${language}`);
    code.textContent = codeLines(xml, BLOCK);
    pre.appendChild(code);
    return pre;
  }
  const groupId = taskGroupId(map);
  if (groupId) {
    const tasks = groupTasks(ctx.tasks, groupId);
    if (tasks.length) {
      ctx.stats.taskGroups.resolved += 1;
      ctx.skip.add(xml);
      const ul = taskListHtml(ctx);
      for (const task of tasks) {
        ul.appendChild(taskItemHtml(ctx, task.checked, (li) => {
          const p = ctx.doc.createElement('p');
          p.textContent = task.text;
          li.appendChild(p);
        }));
      }
      return ul;
    }
    ctx.stats.taskGroups.unresolved += 1;
  }
  if (map.get('display') === 'none') bump(ctx.stats.degraded, 'display');
  if (hasBlockChild(xml)) {
    const frag = ctx.doc.createDocumentFragment();
    childrenInto(frag, xml, ctx, depth + 1);
    return frag;
  }
  // Evernote's paragraph. As a <p> its alignment is read by TextAlign; as a <div> it was measured lost.
  const p = copyElement(xml, 'p', ctx);
  if (xml.localName === 'center' && !p.hasAttribute('align')) p.setAttribute('align', 'center');
  const onlyBreaks = Array.from(xml.childNodes).every((c) => isBlank(c) || (c.nodeType === 1 && c.localName === 'br'));
  if (!onlyBreaks) appendAll(p, xml.childNodes, ctx, depth + 1);
  return p;
}

function listHtml(xml, ctx, depth) {
  if (isEvernoteTodoList(xml)) {
    const ul = taskListHtml(ctx);
    let last = null;
    for (const child of xml.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.localName === 'li') {
        ul.appendChild((last = taskItemHtml(ctx, evernoteChecked(child), (li) => childrenInto(li, child, ctx, depth + 1))));
      } else if (['ul', 'ol'].includes(child.localName) && last) {
        // A sub-list placed directly inside the list: it belongs to the item before it.
        const sub = toHtml(child, ctx, depth + 1);
        if (sub) last.appendChild(sub);
      }
    }
    return ul;
  }
  if (isClassicTodoList(xml)) {
    const ul = taskListHtml(ctx);
    for (const li of Array.from(xml.children).filter((c) => c.localName === 'li')) {
      const todo = leadingTodo(li.childNodes);
      ctx.consumed.add(todo);
      ul.appendChild(taskItemHtml(ctx, todo.getAttribute('checked') === 'true', (item) => childrenInto(item, li, ctx, depth + 1)));
    }
    return ul;
  }
  const el = copyElement(xml, xml.localName, ctx);
  childrenInto(el, xml, ctx, depth + 1);
  return el;
}

export function toHtml(xml, ctx, depth = 0) {
  if (xml.nodeType === 3 || xml.nodeType === 4) return ctx.doc.createTextNode(xml.data);
  if (xml.nodeType !== 1) return null;
  const name = xml.localName;

  if (DROPPED.has(name)) {
    bump(ctx.stats.dropped, name);
    return null;
  }
  if (depth > MAX_DEPTH) {
    ctx.stats.depthCapped = true;
    const frag = ctx.doc.createDocumentFragment();
    for (const leaf of flattenedLeaves(xml, DROPPED)) {
      const out = toHtml(leaf, ctx, 0);
      if (out) frag.appendChild(out);
    }
    return frag;
  }

  switch (name) {
    case 'en-note':
    case 'html':
    case 'body': {
      const frag = ctx.doc.createDocumentFragment();
      childrenInto(frag, xml, ctx, depth + 1);
      return frag;
    }
    case 'div':
    case 'p':
    case 'center':
      return divHtml(xml, ctx, depth);
    case 'ul':
    case 'ol':
      return listHtml(xml, ctx, depth);
    case 'en-media':
      return mediaHtml(xml, ctx);
    case 'en-todo': {
      if (ctx.consumed.has(xml)) return null;
      ctx.stats.todoGlyphs += 1;
      return ctx.doc.createTextNode(xml.getAttribute('checked') === 'true' ? '☑ ' : '☐ ');
    }
    case 'en-crypt': {
      // Left for the schema's own `en-crypt` rule (`248`), which keeps the attributes as strings.
      const el = copyElement(xml, 'en-crypt', ctx);
      el.textContent = xml.textContent;
      return el;
    }
    case 'img': {
      const src = (xml.getAttribute('src') || '').trim();
      if (/^https?:\/\//i.test(src)) return remoteImageHtml(xml, ctx);
      return src ? rawHtmlBlock(xml, ctx) : null;
    }
    case 'map':
      return rawHtmlBlock(xml, ctx);
    case 'q': {
      const frag = ctx.doc.createDocumentFragment();
      frag.appendChild(ctx.doc.createTextNode('“'));
      appendAll(frag, xml.childNodes, ctx, depth + 1);
      frag.appendChild(ctx.doc.createTextNode('”'));
      return frag;
    }
    case 'span': {
      const map = styleMap(xml);
      if (!isHighlight(map)) break;
      ctx.stats.highlights += 1;
      const mark = ctx.doc.createElement('mark');
      mark.setAttribute('data-color', map.get('background-color') || map.get('--en-highlight') || NOTE_PALETTE.highlightImportDefault);
      const inner = copyElement(xml, 'span', ctx);
      const rest = styleWithout(map, ['background-color', 'background', '--en-highlight', '-evernote-highlight']);
      if (rest) inner.setAttribute('style', rest);
      else inner.removeAttribute('style');
      appendAll(inner, xml.childNodes, ctx, depth + 1);
      mark.appendChild(inner);
      return mark;
    }
    default:
      break;
  }

  // Everything else in the DTD: copied, and the schema decides. abbr/acronym land here too — their text is
  // kept and copyElement counts the title that did not come across.
  const el = copyElement(xml, name, ctx);
  childrenInto(el, xml, ctx, depth + 1);
  return el;
}
