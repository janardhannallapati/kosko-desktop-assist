// 253 — the half of the ENEX reader that turns sax events into note records. The other half,
// enex-reader.js, owns the byte stream; this file owns what an element MEANS: which fields are kept (and
// their caps), how a resource's <data> is decoded and hashed without being held, and when a structure is
// refused. Split along that seam so each can be read whole.
import { createBase64Decoder, MAX_RESOURCE_BYTES } from './base64-stream.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxContentChars: 16 * 1024 * 1024, // the export DTD caps ENML at 5,242,880; the owner's largest is 1.15 MB
  maxFieldChars: 64 * 1024,
  maxDepth: 16,
  maxTags: 1000,
  maxResources: 10000,
  maxTasks: 10000,
  maxResourceBytes: MAX_RESOURCE_BYTES,
  chunkChars: 64 * 1024 // sax checks its buffers only between write() calls
});

const TIMESTAMP = /^\d{8}T\d{6}Z$/;

const NOTE_ATTRIBUTES = {
  'source-url': 'sourceUrl',
  author: 'author',
  source: 'source',
  'source-application': 'sourceApplication',
  'reminder-time': 'reminderTime',
  'reminder-done-time': 'reminderDoneTime',
  'reminder-order': 'reminderOrder',
  'subject-date': 'subjectDate',
  'content-class': 'contentClass',
  'place-name': 'placeName',
  latitude: 'latitude',
  longitude: 'longitude',
  altitude: 'altitude'
};

const TASK_FIELDS = { title: 'title', taskStatus: 'status', taskGroupNoteLevelID: 'groupId', sortWeight: 'sortWeight', dueDate: 'dueDate' };

// The children of <note> this reader understands. Anything else is ignored and counted.
const NOTE_CHILDREN = new Set(['title', 'created', 'updated', 'tag', 'note-attributes', 'content', 'resource', 'task']);

export class Stop extends Error {}

// Wires `parser`'s callbacks. `state.queue` receives completed records; `state.fatal` is set once, to the
// first reason the file cannot be read on; a callback that sets it throws Stop out of parser.write().
export function attachEnexAssembler(parser, { limits, md5, keepData = false }) {
  const state = { queue: [], fatal: null, notes: 0, sawRoot: false };

  const path = []; // open element names
  let note = null;
  let resource = null;
  let task = null;
  let capture = null; // { target, cap, parts, length, over, cdataParts }
  let data = null; // { decoder } while inside a resource's <data>

  const problem = (name) => {
    note.problems[name] = (note.problems[name] || 0) + 1;
  };
  const stop = (reason) => {
    state.fatal = state.fatal || reason;
    throw new Stop(reason);
  };

  const startCapture = (target, cap) => {
    capture = { target, cap, parts: [], cdata: [], length: 0, over: false };
  };
  const appendCapture = (text, isCdata) => {
    if (capture.over) return;
    capture.length += text.length;
    if (capture.length > capture.cap) {
      capture.over = true;
      capture.parts = [];
      capture.cdata = [];
      return;
    }
    (isCdata ? capture.cdata : capture.parts).push(text);
  };
  // <content> is its CDATA when it has one: the whitespace around the section is ENEX formatting, and ENML
  // must begin with its own <?xml?> for the converter's XML parse.
  const captured = () => {
    if (capture.over) return { over: true, value: null };
    const value = capture.cdata.length ? capture.cdata.join('') : capture.parts.join('');
    return { over: false, value };
  };

  parser.ondoctype = (doctype) => {
    // sax hands over the whole DOCTYPE, internal subset included (`<!ENTITY …>` stays inside it, measured),
    // and never interprets it. Evernote writes none, so any subset at all is refused.
    if (doctype.includes('[')) stop('internal-dtd');
  };

  parser.onopentag = (node) => {
    const name = node.name;
    const parent = path[path.length - 1];
    path.push(name);
    if (path.length > limits.maxDepth) stop('too-deep');
    if (path.length === 1) {
      if (name !== 'en-export') stop('not-enex');
      state.sawRoot = true;
      state.queue.push({ kind: 'export', application: attr(node, 'application'), version: attr(node, 'version') });
      return;
    }
    if (name === 'note' && parent === 'en-export') {
      note = { kind: 'note', index: state.notes, title: null, created: null, updated: null, tags: [], attributes: {}, content: null, resources: [], tasks: [], problems: {} };
      return;
    }
    if (!note) return;

    if (parent === 'note') {
      if (!NOTE_CHILDREN.has(name)) problem('unknown-element');
      else if (name === 'content') startCapture({ field: 'content' }, limits.maxContentChars);
      else if (name === 'resource') resource = { md5: null, bytes: null, mime: null, fileName: null, width: null, height: null, problem: null };
      else if (name === 'task') task = { groupId: null, title: null, status: null, sortWeight: null, dueDate: null };
      else if (name !== 'note-attributes') startCapture({ field: name }, limits.maxFieldChars);
      return;
    }
    if (parent === 'note-attributes' && NOTE_ATTRIBUTES[name]) {
      startCapture({ attribute: NOTE_ATTRIBUTES[name] }, limits.maxFieldChars);
      return;
    }
    if (resource && parent === 'resource') {
      if (name === 'data') {
        const encoding = node.attributes.encoding;
        if (encoding !== undefined && String(encoding).toLowerCase() !== 'base64') {
          resource.problem = 'unsupported-encoding';
          return;
        }
        md5.init();
        // 384: the import (not the dry run) keeps a resource's decoded bytes, as a Blob, for upload. A copy
        // per chunk because the decoder may reuse its buffer; one note is held at a time (the caller pulls
        // the next note only after it has finished this one).
        const chunks = keepData ? [] : null;
        data = {
          chunks,
          decoder: createBase64Decoder({
            maxBytes: limits.maxResourceBytes,
            onBytes: (u8) => { md5.update(u8); if (chunks) chunks.push(u8.slice()); }
          })
        };
      } else if (name === 'mime' || name === 'width' || name === 'height') {
        startCapture({ resourceField: name }, limits.maxFieldChars);
      }
      return;
    }
    if (resource && parent === 'resource-attributes' && name === 'file-name') {
      startCapture({ resourceField: 'fileName' }, limits.maxFieldChars);
      return;
    }
    if (task && parent === 'task' && TASK_FIELDS[name]) {
      startCapture({ taskField: TASK_FIELDS[name] }, limits.maxFieldChars);
    }
  };

  const onText = (text, isCdata) => {
    if (data) data.decoder.push(text);
    else if (capture) appendCapture(text, isCdata);
  };
  parser.ontext = (t) => onText(t, false);
  parser.oncdata = (t) => onText(t, true);

  parser.onclosetag = (name) => {
    path.pop();
    if (!note) return;
    const depthAfter = path.length;

    if (data && name === 'data') {
      const { bytes, problem: p } = data.decoder.end();
      resource.bytes = bytes;
      resource.problem = p;
      resource.md5 = p === 'corrupt' || p === 'too-large-to-read' ? null : md5.digest('hex');
      if (data.chunks) resource.data = p ? null : new Blob(data.chunks);
      data = null;
      return;
    }
    if (capture) {
      const { over, value } = captured();
      const { target } = capture;
      capture = null;
      if (target.field === 'content') {
        if (over) problem('content-too-large');
        else note.content = value;
        return;
      }
      if (over) {
        problem('field-too-large');
        return;
      }
      if (target.field === 'created' || target.field === 'updated') {
        const trimmed = value.trim();
        if (TIMESTAMP.test(trimmed)) note[target.field] = trimmed;
        else problem('bad-timestamp');
      } else if (target.field === 'tag') {
        if (note.tags.length < limits.maxTags) note.tags.push(value);
        else problem('too-many-tags');
      } else if (target.field) {
        note[target.field] = value;
      } else if (target.attribute) {
        note.attributes[target.attribute] = value;
      } else if (target.resourceField) {
        if (target.resourceField === 'width' || target.resourceField === 'height') {
          const n = Number(value.trim());
          resource[target.resourceField] = Number.isFinite(n) && value.trim() !== '' ? n : null;
        } else {
          resource[target.resourceField] = target.resourceField === 'mime' ? value.trim() : value;
        }
      } else if (target.taskField) {
        task[target.taskField] = value;
      }
      return;
    }
    if (name === 'resource' && depthAfter === 2) {
      if (note.resources.length < limits.maxResources) note.resources.push(resource);
      else problem('too-many-resources');
      resource = null;
      return;
    }
    if (name === 'task' && depthAfter === 2) {
      if (note.tasks.length < limits.maxTasks) note.tasks.push(task);
      else problem('too-many-tasks');
      task = null;
      return;
    }
    if (name === 'note' && depthAfter === 1) {
      state.queue.push(note);
      state.notes += 1;
      note = null;
    }
  };

  parser.onerror = () => {
    state.fatal = state.fatal || 'malformed-xml';
    throw new Stop('malformed-xml');
  };

  return state;
}

function attr(node, name) {
  const value = node.attributes[name];
  return typeof value === 'string' ? value.slice(0, 256) : null;
}
