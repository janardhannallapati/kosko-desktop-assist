// 252 — ENML -> Tiptap JSON for ONE note, for any Evernote user.
//
//   convertEnml(enml, { schema, window, tasks }) ->
//     { ok: false, reason }                         refused (an entity declaration); convert nothing
//     { ok: true, doc, media, report }              doc passes schema.nodeFromJSON(doc).check()
//
// ONE MODULE, DOM AND SCHEMA INJECTED — W2's open research. W3 runs this in the browser with the page's
// `window` and getSchema(EXTENSIONS); tests and the corpus run use vitest's jsdom `window`. Nothing in
// lib/enml imports app/, whose schema file pulls in React NodeViews. A browser copy and a server copy
// would be `10`:B2 again.
//
// THE PIPELINE: enml-source (refuse / parse) -> enml-prepass (a decision per construct, into the schema's
// own HTML dialect) -> ProseMirror's DOMParser built from THE LIVE SCHEMA -> an audit per run of blocks ->
// a post-pass (palette tokens, media placeholders). The schema stays the one statement of how HTML becomes
// nodes; this module only decides what it is given.
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { canonicalTextColour } from '../leaves/note-colours.js';
import { prepareEnml } from './enml-source.js';
import { isTextPreserved, sourceText, docText } from './enml-audit.js';
import { DROPPED, MAX_DEPTH, groupRuns, runToHtml, newStats } from './enml-prepass.js';

const parsers = new WeakMap();
const parserFor = (schema) => {
  if (!parsers.has(schema)) parsers.set(schema, PMDOMParser.fromSchema(schema));
  return parsers.get(schema);
};

const MEDIA_SENTINEL = /^enex-media:(\d+)$/;

function mergeStats(into, from) {
  for (const key of ['todoGlyphs', 'highlights', 'remoteImages']) into[key] += from[key];
  into.taskGroups.resolved += from.taskGroups.resolved;
  into.taskGroups.unresolved += from.taskGroups.unresolved;
  into.depthCapped = into.depthCapped || from.depthCapped;
  for (const bag of ['degraded', 'dropped']) {
    for (const [k, v] of Object.entries(from[bag])) into[bag][k] = (into[bag][k] || 0) + v;
  }
}

function renumberSentinels(nodes, base) {
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    const match = MEDIA_SENTINEL.exec(node?.attrs?.src || '');
    if (match) node.attrs.src = `enex-media:${base + Number(match[1])}`;
    if (node?.content) stack.push(...node.content);
  }
}

function sentinelsIn(nodes) {
  let n = 0;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (MEDIA_SENTINEL.test(node?.attrs?.src || '')) n += 1;
    if (node?.content) stack.push(...node.content);
  }
  return n;
}

// One run of ENML nodes, through the pre-pass and the live schema, checked. Returns the nodes, or null when
// the run lost text or a media placeholder — the caller then splits it or keeps it verbatim.
function tryRun(run, env, depth) {
  const media = [];
  const ctx = { doc: env.doc, window: env.window, tasks: env.tasks, media, stats: newStats(), skip: new Set(), consumed: new Set() };
  const host = env.doc.createElement('div');
  host.appendChild(runToHtml(run, ctx, depth));
  if (!host.hasChildNodes()) return { nodes: [], media, stats: ctx.stats };
  const nodes = parserFor(env.schema).parse(host).toJSON().content || [];
  const expected = sourceText(run.nodes, { skip: ctx.skip, dropped: DROPPED });
  const lostText = !isTextPreserved(expected, docText({ type: 'doc', content: nodes }, env));
  // "Every <en-media> accounted for" is checked, not assumed: a placeholder the schema dropped is a lost
  // attachment the text audit cannot see.
  const lostMedia = sentinelsIn(nodes) !== media.length;
  return lostText || lostMedia ? null : { nodes, media, stats: ctx.stats };
}

function rawHtmlOf(nodes, env) {
  const serializer = new env.window.XMLSerializer();
  return { type: 'rawHtml', attrs: { html: nodes.map((n) => serializer.serializeToString(n)).join('') } };
}

// The audit net. A run that passes is kept. One that fails is split — a run of several blocks into single
// blocks, a container into its own runs — and a leaf that still fails is kept as its ORIGINAL ENML in a
// rawHtml block. Descending stops at a paragraph-like element, so the fallback is a whole line, not a
// shard of one.
function convertRuns(runs, env, out, depth) {
  for (const run of runs) {
    const result = tryRun(run, env, depth);
    if (result) {
      // A run numbers its media from 0; renumber into the note's manifest as the run is accepted.
      renumberSentinels(result.nodes, out.media.length);
      out.nodes.push(...result.nodes);
      for (const m of result.media) out.media.push(m);
      mergeStats(out.stats, result.stats);
      continue;
    }
    const [only] = run.nodes;
    if (run.kind !== 'inline' && run.nodes.length > 1) {
      // Reclassified, not relabelled: a checklist line split out of a todo run is still a checklist line.
      convertRuns(run.nodes.flatMap((node) => groupRuns([node])), env, out, depth);
    } else if (run.nodes.length === 1 && only.nodeType === 1 && depth < MAX_DEPTH && groupRuns(only.childNodes).some((r) => r.kind !== 'inline')) {
      convertRuns(groupRuns(only.childNodes), env, out, depth + 1);
    } else {
      out.nodes.push(rawHtmlOf(run.nodes, env));
      out.stats.auditFallbacks += 1;
    }
  }
}

// Post-pass over the finished JSON: media placeholders get their real attributes straight from the
// manifest, and recognised text colours become palette tokens (247).
function finish(nodes, media, report) {
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    const match = MEDIA_SENTINEL.exec(node.attrs?.src || '');
    if (match) {
      const m = media[Number(match[1])];
      const path = `enex-resource:${m.hash}`;
      if (node.type === 'noteImage') Object.assign(node.attrs, { src: null, path, alt: m.alt ?? null, width: m.width, height: m.height });
      else {
        const mediaType = m.mime.startsWith('video/') ? 'video' : m.mime.startsWith('audio/') ? 'audio' : 'file';
        Object.assign(node.attrs, { src: null, path, mediaType, mimeType: m.mime || null, filename: null });
      }
    }
    for (const mark of node.marks || []) {
      if (mark.type !== 'textStyle' || !mark.attrs?.color) continue;
      const token = canonicalTextColour(mark.attrs.color);
      if (token) {
        mark.attrs.color = token;
        report.colourTokens += 1;
      }
    }
    if (node.type === 'rawHtml') report.rawHtml += 1;
    if (node.type === 'noteLocked') report.locked += 1;
    if (node.type === 'taskItem') report.taskItems += 1;
    if (node.type === 'codeBlock') report.codeBlocks += 1;
    if (node.content) stack.push(...node.content);
  }
}

function emptyReport() {
  return { fallback: null, rawHtml: 0, locked: 0, taskItems: 0, codeBlocks: 0, colourTokens: 0, media: 0, auditFallbacks: 0, ...newStats() };
}

function wholeNoteFallback(enml, reason) {
  return { ok: true, doc: { type: 'doc', content: [{ type: 'rawHtml', attrs: { html: enml } }] }, media: [], report: { ...emptyReport(), fallback: reason, rawHtml: 1 } };
}

export function convertEnml(enml, { schema, window, tasks = [] } = {}) {
  const prepared = prepareEnml(enml, { window });
  if (!prepared.ok) return prepared;
  if (prepared.malformed) return wholeNoteFallback(enml, 'malformed-xml');

  const report = emptyReport();
  const env = { schema, window, tasks, doc: window.document.implementation.createHTMLDocument('') };
  const out = { nodes: [], media: [], stats: report };
  convertRuns(groupRuns(prepared.root.childNodes), env, out, 0);

  report.media = out.media.length;

  const doc = { type: 'doc', content: out.nodes.length ? out.nodes : [{ type: 'paragraph', attrs: { textAlign: null } }] };
  finish(doc.content, out.media, report);
  try {
    schema.nodeFromJSON(doc).check();
  } catch {
    return wholeNoteFallback(enml, 'schema-check');
  }
  return { ok: true, doc, media: out.media.map(({ hash, mime, node, width, height }) => ({ hash, mime, node, width, height })), report };
}
