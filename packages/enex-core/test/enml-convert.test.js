// @vitest-environment jsdom
//
// 252 — the converter as a whole: the refusal, the fallbacks, the audit net, depth, determinism, and
// what the report may and may not carry.
import { describe, it, expect, vi } from 'vitest';


import { Mark, getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { NOTE_SCHEMA_EXTENSIONS as EXTENSIONS } from '../src/schema/note-schema.js';
import { convertEnml } from '../src/enml/enml-convert.js';
import { conv, nodesOf, textOf, schema } from './support/convert-harness.js';

describe('refusals and fallbacks', () => {
  it('refuses a note that declares an entity and converts nothing', () => {
    expect(convertEnml('<!DOCTYPE en-note [<!ENTITY a "b">]><en-note>&a;</en-note>', { schema, window })).toEqual({
      ok: false,
      reason: 'entity-declaration'
    });
  });

  it('keeps a malformed note whole, verbatim, as ONE rawHtml block', () => {
    const body = '<en-note><div>unclosed <b>bold</en-note>';
    const { doc, report } = conv(body);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({ type: 'rawHtml', attrs: { html: body } });
    expect(report.fallback).toBe('malformed-xml');
  });

  it('turns an empty note into one empty paragraph — not an invalid doc, and not a verbatim fallback', () => {
    const { doc, report } = conv('<en-note></en-note>');
    expect(doc.content).toEqual([{ type: 'paragraph', attrs: { textAlign: null } }]);
    expect(report.fallback).toBe(null);
  });
});

describe('the audit net', () => {
  // A schema that DELETES a construct's text, which the live schema has never been measured doing — so
  // it is built for the test. An `ignore` parse rule drops an element with everything inside it.
  const Swallow = Mark.create({ name: 'swallowDfn', parseHTML: () => [{ tag: 'dfn', ignore: true }] });
  const lossy = getSchema([...EXTENSIONS, Swallow]);

  it('control: the lossy schema really does delete the text when nothing checks', () => {
    const dom = new window.DOMParser().parseFromString('<body><p>keep <dfn>lost</dfn></p></body>', 'text/html');
    expect(PMDOMParser.fromSchema(lossy).parse(dom.body).textContent).toBe('keep');
  });

  it('replaces only the block that lost text with rawHtml of its ORIGINAL ENML', () => {
    const { doc, report } = conv('<div>fine</div><div>keep <dfn>lost</dfn></div><div>also fine</div>', { schema: lossy });
    expect(doc.content.map((n) => n.type)).toEqual(['paragraph', 'rawHtml', 'paragraph']);
    expect(doc.content[1].attrs.html).toContain('<dfn>lost</dfn>');
    expect(report.auditFallbacks).toBe(1);
  });

  it('splits a failing run of checklist lines into its lines, keeping the good ones as tasks', () => {
    const { doc } = conv('<div><en-todo/>fine</div><div><en-todo/>keep <dfn>lost</dfn></div>', { schema: lossy });
    expect(doc.content.map((n) => n.type)).toEqual(['taskList', 'rawHtml']);
  });

  it('keeps a block verbatim when the schema drops its MEDIA, which the text audit alone cannot see', () => {
    // No text is lost here — only the attachment — so this is the case the media half of the audit is for.
    const SwallowImg = Mark.create({ name: 'swallowImg', parseHTML: () => [{ tag: 'img', ignore: true, priority: 1000 }] });
    const noImages = getSchema([...EXTENSIONS, SwallowImg]);
    const { doc } = conv('<div>caption<en-media hash="dd" type="image/png"/></div>', { schema: noImages });
    expect(nodesOf(doc, 'rawHtml').map((n) => n.attrs.html)).toEqual(['<div>caption<en-media hash="dd" type="image/png"/></div>']);
  });

  it('descends into a wrapper instead of giving up on the whole note', () => {
    const { doc } = conv('<div style="--en-clipped-content:article"><div>fine</div><div>keep <dfn>lost</dfn></div></div>', { schema: lossy });
    expect(doc.content.map((n) => n.type)).toEqual(['paragraph', 'rawHtml']);
  });
});

describe('depth', () => {
  // No wall-clock bound: without the cap this THROWS `Maximum call stack size exceeded` (mutation-tested), and
  // a time bound only added a failure mode that fires under machine load (measured 2.4 s at load 6, 13 s at
  // load 7). Slow BY DESIGN, so it declares its own allowance (CLAUDE.md's convention): at 5,000 levels it took
  // 16.8 s inside the full parallel suite and broke the 15 s floor. 3,500 is still past the measured overflow.
  it('converts nesting that overflows ProseMirror\'s parser (measured: stack overflow at 3,000)', { timeout: 60000 }, () => {
    const depth = 3500;
    const { doc, report } = conv(`${'<div>'.repeat(depth)}deep<en-media hash="aa" type="image/png"/>${'</div>'.repeat(depth)}`);
    expect(textOf(doc)).toBe('deep');
    // The decisions still apply beneath the cap.
    expect(nodesOf(doc, 'noteImage')).toHaveLength(1);
    expect(report.depthCapped).toBe(true);
  });

  it('does not report a cap that was not reached', () => {
    expect(conv('<div><div>shallow</div></div>').report.depthCapped).toBe(false);
  });
});

describe('scale', () => {
  it('converts a 300 x 10 table with every cell intact', () => {
    const row = `<tr>${'<td>cell</td>'.repeat(10)}</tr>`;
    const { doc } = conv(`<table>${row.repeat(300)}</table>`);
    expect(nodesOf(doc, 'tableCell')).toHaveLength(3000);
  });
});

describe('determinism and the report', () => {
  const NOTE = '<div style="text-align:center">Title</div><div><en-todo checked="true"/>secretword</div><en-media hash="AbC" type="application/pdf"/><div><span style="color:#dc2626">red</span></div>';

  it('produces byte-identical JSON for the same input — W3\'s fingerprint hashes it', () => {
    expect(JSON.stringify(conv(NOTE))).toBe(JSON.stringify(conv(NOTE)));
  });

  it('carries counts only, never note text', () => {
    const { report } = conv(NOTE);
    const json = JSON.stringify(report);
    for (const word of ['Title', 'secretword', 'red']) expect(json).not.toContain(word);
    expect(report).toMatchObject({ fallback: null, taskItems: 1, media: 1, colourTokens: 1, rawHtml: 0, auditFallbacks: 0 });
  });
});
