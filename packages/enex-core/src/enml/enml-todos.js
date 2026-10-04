// 252 — Evernote checklists in all three shapes, into `251`'s task list.
//
//   classic   <div><en-todo checked="true"/>buy milk</div>        (also split by <br/>, inside li, wrapped in b/i)
//   Evernote 10  <ul style="--en-todo:true"><li style="--en-checked:true">…     (sub-lists as ul-in-ul)
//   tasks     <div style="--en-task-group:true; --en-id:X">placeholder</div> + ENEX <task> elements
//
// Measured before this existed: the first lost the checkbox and its state, the second became a bullet
// list, the third kept only "Content not supported". A todo that does not START a line cannot become a
// task item (a task item is a block), so it becomes a ☑/☐ glyph — the state survives as text.
import { styleMap, isTodoList, isChecked } from './enml-evernote-styles.js';

// Inline wrappers a todo may sit inside and still be "the start of the line". The importers' research
// found todos inside span/a and inside b/i; all are formatting around the checkbox, not content before it.
const WRAPPERS = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'span', 'font', 'a', 'sub', 'sup', 'strike', 'small', 'big', 'del', 'ins', 'code', 'tt']);

const isBlank = (node) => (node.nodeType === 3 || node.nodeType === 4) && !node.data.trim();

// The en-todo that starts this run of nodes, or null. Iterative through the first meaningful child of
// each wrapper, so a pathological nesting cannot overflow the stack.
export function leadingTodo(nodes) {
  let list = Array.from(nodes);
  for (;;) {
    const first = list.find((n) => !isBlank(n));
    if (!first || first.nodeType !== 1) return null;
    if (first.localName === 'en-todo') return first;
    if (!WRAPPERS.has(first.localName)) return null;
    list = Array.from(first.childNodes);
  }
}

// A div/p's children split at its own top-level <br/>s — Evernote's one-div-many-lines form.
export function lines(element) {
  const out = [[]];
  for (const child of element.childNodes) {
    if (child.nodeType === 1 && child.localName === 'br') out.push([]);
    else out[out.length - 1].push(child);
  }
  return out;
}

const LINE_ELEMENTS = new Set(['div', 'p']);

// Does this element contribute task items to a run of checklist lines?
export function isTodoLine(node) {
  return node.nodeType === 1 && LINE_ELEMENTS.has(node.localName) && lines(node).some((line) => leadingTodo(line));
}

// Consecutive todo lines -> entries: { task: true, checked, nodes, todo } or { task: false, nodes, from }.
export function todoEntries(elements) {
  const entries = [];
  for (const element of elements) {
    for (const line of lines(element)) {
      const todo = leadingTodo(line);
      if (todo) entries.push({ task: true, checked: todo.getAttribute('checked') === 'true', nodes: line, todo });
      else if (line.some((n) => !isBlank(n))) entries.push({ task: false, nodes: line, from: element });
    }
  }
  return entries;
}

// A classic ul/ol whose EVERY item starts with a todo is a checklist; one without is an ordinary list
// with glyphs, because turning half a list into tasks would invent structure the author did not make.
export function isClassicTodoList(element) {
  if (element.nodeType !== 1 || !['ul', 'ol'].includes(element.localName)) return false;
  const items = Array.from(element.children).filter((c) => c.localName === 'li');
  return items.length > 0 && items.every((li) => leadingTodo(li.childNodes));
}

export function isEvernoteTodoList(element) {
  return element.nodeType === 1 && element.localName === 'ul' && isTodoList(styleMap(element));
}

export const evernoteChecked = (li) => isChecked(styleMap(li));

// ENEX dates are `20260920T000000Z`; an ISO string is accepted too. Only the date is kept, as text.
function dueText(due) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(due || ''));
  return m ? ` (due ${m[1]}-${m[2]}-${m[3]})` : '';
}

// Code-unit order, NOT localeCompare: a locale-dependent sort would make the same export convert to different
// JSON in two browsers, and W3's fingerprint hashes that JSON.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The tasks of one group, in Evernote's order. `sortWeight` is an opaque string. Ties keep input order
// because Array.prototype.sort is stable (ES2019) — an explicit index tie-break was mutation-tested equivalent.
export function groupTasks(tasks, groupId) {
  return (tasks || [])
    .map((task) => ({ task }))
    .filter(({ task }) => task && task.groupId === groupId)
    .sort((a, b) => compare(String(a.task.sortWeight ?? ''), String(b.task.sortWeight ?? '')))
    .map(({ task }) => ({ checked: task.status === 'completed', text: `${task.title ?? ''}${dueText(task.dueDate)}` }));
}
