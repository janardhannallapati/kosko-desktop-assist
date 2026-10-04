// @vitest-environment jsdom
//
// 252 — one test per row of the decision table in .mdd/docs/252-enml-tiptap-converter.md. Every row that
// is not "copied, the schema decides" exists because a throwaway probe measured a loss when raw ENML was
// handed straight to getSchema(EXTENSIONS) (2026-09-14); the comment on each names that loss. Every
// output is also run through schema.nodeFromJSON(doc).check() by the harness.
import { describe, it, expect, vi } from 'vitest';


import { conv, nodesOf, topTypes, textOf } from './support/convert-harness.js';

const HASH = 'ABCDEF0123456789ABCDEF0123456789';

describe('paragraph structure', () => {
  it('keeps alignment on Evernote\'s paragraph element, the <div> (measured: textAlign null)', () => {
    const { doc } = conv('<div style="text-align:center">x</div><div align="right">y</div><center>z</center>');
    expect(doc.content.map((p) => [p.type, p.attrs?.textAlign])).toEqual([
      ['paragraph', 'center'],
      ['paragraph', 'right'],
      ['paragraph', 'center']
    ]);
  });

  it('treats a div that holds blocks as a transparent container', () => {
    const { doc } = conv('<div><h2>Title</h2><div>body</div></div>');
    expect(topTypes(doc)).toEqual(['heading', 'paragraph']);
  });

  it('turns Evernote\'s empty line, <div><br/></div>, into an empty paragraph rather than a two-line one', () => {
    const { doc } = conv('<div>a</div><div><br/></div><div>b</div>');
    expect(doc.content[1]).toEqual({ type: 'paragraph', attrs: { textAlign: null } });
  });

  it('drops en-note\'s own page attributes without losing its content', () => {
    const { doc } = conv('<en-note bgcolor="#ffffff" text="#000000" style="font-size:14px"><div>kept</div></en-note>');
    expect(textOf(doc)).toBe('kept');
  });
});

describe('<en-media> (measured: every one of 785 deleted, position included)', () => {
  it('becomes a media node in place, keyed by the lowercase hash in `path`', () => {
    const { doc, media, report } = conv(`<div>before<en-media hash="${HASH}" type="image/png" width="120" height="80px"/>after</div>`);
    expect(topTypes(doc)).toEqual(['paragraph', 'noteImage', 'paragraph']);
    expect(doc.content[1].attrs).toMatchObject({ path: `enex-resource:${HASH.toLowerCase()}`, src: null, width: 120, height: 80 });
    expect(media).toEqual([{ hash: HASH.toLowerCase(), mime: 'image/png', node: 'noteImage', width: 120, height: 80 }]);
    expect(report.media).toBe(1);
  });

  it('chooses the node by type: images the library stores, and HEIC, are images; the rest are attachments', () => {
    const cases = [
      ['image/jpeg', 'noteImage', undefined],
      ['image/heic', 'noteImage', undefined],
      ['image/svg+xml', 'noteImage', undefined], // 374: an SVG is drawn by <img>, safely
      ['application/pdf', 'noteAttachment', 'file'],
      ['audio/mpeg', 'noteAttachment', 'audio'],
      ['video/mp4', 'noteAttachment', 'video']
    ];
    for (const [mime, node, mediaType] of cases) {
      const { doc } = conv(`<en-media hash="${HASH}" type="${mime}"/>`);
      const n = doc.content.find((c) => c.type === node);
      expect(n, mime).toBeTruthy();
      if (mediaType) expect(n.attrs).toMatchObject({ mediaType, mimeType: mime, path: `enex-resource:${HASH.toLowerCase()}` });
    }
  });

  it('keeps only numeric sizes', () => {
    const { media } = conv(`<en-media hash="${HASH}" type="image/png" width="50%" height="auto"/>`);
    expect(media[0]).toMatchObject({ width: null, height: null });
  });

  it('lists media in document order, and each node points at ITS OWN entry, across runs', () => {
    const { doc, media } = conv('<table><tr><td><en-media hash="aa" type="image/png"/></td></tr></table><ul><li><en-media hash="bb" type="audio/mpeg"/></li></ul>');
    expect(media.map((m) => m.hash)).toEqual(['aa', 'bb']);
    // Each run numbers its media from 0, so without renumbering the second node would carry the first
    // resource's hash — a wrong attachment, not a missing one.
    const paths = [...nodesOf(doc, 'noteImage'), ...nodesOf(doc, 'noteAttachment')].map((n) => n.attrs.path);
    expect(paths).toEqual(['enex-resource:aa', 'enex-resource:bb']);
  });

  it('never folds media into a code block, whose text-only form would delete it', () => {
    const { doc, media } = conv('<div style="--en-codeblock:true;"><div>see</div><en-media hash="cc" type="image/png"/></div>');
    expect(nodesOf(doc, 'codeBlock')).toHaveLength(0);
    expect(nodesOf(doc, 'noteImage').map((n) => n.attrs.path)).toEqual(['enex-resource:cc']);
    expect(media).toHaveLength(1);
  });
});

describe('<en-crypt>', () => {
  it('reaches noteLocked through the schema\'s own rule, attributes kept as strings', () => {
    const { doc, report } = conv('<div>above</div><en-crypt cipher="AES" length="128" hint="false">RU5DMGFiYw==</en-crypt>');
    const [locked] = nodesOf(doc, 'noteLocked');
    expect(locked.attrs).toEqual({ ciphertext: 'RU5DMGFiYw==', cipher: 'AES', length: '128', hint: 'false' });
    expect(report.locked).toBe(1);
  });
});

describe('classic <en-todo> (measured: checkbox and state deleted)', () => {
  const states = (doc) => nodesOf(doc, 'taskItem').map((t) => [t.attrs.checked, textOf(t)]);

  it('turns consecutive todo lines into one task list', () => {
    const { doc, report } = conv('<div><en-todo checked="true"/>buy milk</div><div><en-todo/>eggs</div>');
    expect(topTypes(doc)).toEqual(['taskList']);
    expect(states(doc)).toEqual([[true, 'buy milk'], [false, 'eggs']]);
    expect(report.taskItems).toBe(2);
  });

  it('splits one div at <br/> when each line starts with a todo', () => {
    const { doc } = conv('<div><en-todo/>a<br/><en-todo checked="true"/>b</div>');
    expect(states(doc)).toEqual([[false, 'a'], [true, 'b']]);
  });

  it('finds a todo wrapped in formatting at the start of a line', () => {
    const { doc } = conv('<div><b><i><en-todo checked="true"/></i></b>bold task</div>');
    expect(states(doc)).toEqual([[true, 'bold task']]);
  });

  it('turns a list whose every item starts with a todo into a task list', () => {
    const { doc } = conv('<ul><li><en-todo checked="true"/>a</li><li><en-todo/>b</li></ul>');
    expect(topTypes(doc)).toEqual(['taskList']);
    expect(states(doc)).toEqual([[true, 'a'], [false, 'b']]);
  });

  it('keeps a list where only SOME items start with a todo as an ordinary list, with glyphs', () => {
    const { doc, report } = conv('<ul><li><en-todo checked="true"/>a</li><li>b</li></ul>');
    expect(topTypes(doc)).toEqual(['bulletList']);
    expect(textOf(doc)).toBe('☑ ab');
    expect(report.todoGlyphs).toBe(1);
  });

  it('writes a glyph for a todo in the middle of a line, keeping the state as text', () => {
    const { doc, report } = conv('<div>call <en-todo/>Bob and <en-todo checked="true"/>Ann</div>');
    expect(topTypes(doc)).toEqual(['paragraph']);
    expect(textOf(doc)).toBe('call ☐ Bob and ☑ Ann');
    expect(report.todoGlyphs).toBe(2);
  });

  it('keeps a plain line between todo lines as a paragraph, splitting the list around it', () => {
    const { doc } = conv('<div><en-todo/>a</div><div>note</div><div><en-todo/>b</div>');
    expect(topTypes(doc)).toEqual(['taskList', 'paragraph', 'taskList']);
  });
});

describe('Evernote 10 checklist (measured: became a bullet list)', () => {
  it('maps --en-todo lists and --en-checked items, spacing variants included', () => {
    const { doc } = conv('<ul style="--en-todo:true;"><li style="--en-checked:true;"><div>done</div></li><li style="--en-checked: false"><div>open</div></li></ul>');
    expect(topTypes(doc)).toEqual(['taskList']);
    expect(nodesOf(doc, 'taskItem').map((t) => t.attrs.checked)).toEqual([true, false]);
  });

  it('moves a sub-list placed directly inside the list into the previous item', () => {
    const { doc } = conv('<ul style="--en-todo:true;"><li style="--en-checked:false;"><div>parent</div></li><ul style="--en-todo:true;"><li style="--en-checked:true;"><div>child</div></li></ul></ul>');
    const [parent] = doc.content[0].content;
    expect(textOf(parent.content[0])).toBe('parent');
    expect(parent.content[1].type).toBe('taskList');
    expect(parent.content[1].content[0].attrs.checked).toBe(true);
  });
});

describe('Evernote 10 task groups', () => {
  const PLACEHOLDER = '<div style="--en-task-group:true; --en-id:g1;"><div>Content not supported</div><div>This block is a placeholder for Tasks.</div></div>';
  const TASKS = [
    { groupId: 'g1', title: 'Pay rent', status: 'completed', sortWeight: 'B', dueDate: '20260920T000000Z' },
    { groupId: 'g1', title: 'Call mum', status: 'open', sortWeight: 'A' },
    { groupId: 'other', title: 'Not here', status: 'open', sortWeight: 'A' }
  ];

  it('replaces the placeholder with the group\'s tasks, ordered by sortWeight, due date kept as text', () => {
    const { doc, report } = conv(PLACEHOLDER, { tasks: TASKS });
    expect(nodesOf(doc, 'taskItem').map((t) => [t.attrs.checked, textOf(t)])).toEqual([
      [false, 'Call mum'],
      [true, 'Pay rent (due 2026-09-20)']
    ]);
    expect(textOf(doc)).not.toContain('placeholder');
    expect(report.taskGroups).toEqual({ resolved: 1, unresolved: 0 });
  });

  it('keeps the placeholder text and counts the group when no tasks were supplied', () => {
    const { doc, report } = conv(PLACEHOLDER);
    expect(textOf(doc)).toContain('placeholder for Tasks');
    expect(report.taskGroups).toEqual({ resolved: 0, unresolved: 1 });
  });
});

describe('code blocks (measured: indentation collapsed to one space)', () => {
  it('keeps every line and its indentation, with the language', () => {
    const { doc, report } = conv('<div style="padding:8px;--en-codeblock:true;--en-syntaxLanguage:python;"><div>def f():</div><div>    return 1</div><div><br/></div><div>f()</div></div>');
    const [code] = nodesOf(doc, 'codeBlock');
    expect(code.attrs.language).toBe('python');
    expect(textOf(code)).toBe('def f():\n    return 1\n\nf()');
    expect(report.codeBlocks).toBe(1);
  });

  it('ignores pretty-printing between a code block\'s lines, as Evernote\'s own rendering does', () => {
    const { doc } = conv('<div style="--en-codeblock:true;">\n  <div>a</div>\n  <div>  b</div>\n</div>');
    expect(textOf(nodesOf(doc, 'codeBlock')[0])).toBe('a\n  b');
  });

  it('accepts the single-dash form and <br/> line breaks', () => {
    const { doc } = conv('<div style="-en-codeblock:true;">a<br/>  b</div>');
    expect(textOf(nodesOf(doc, 'codeBlock')[0])).toBe('a\n  b');
  });
});

describe('highlights and colour', () => {
  it('maps an Evernote highlight to the highlight mark, which locks a readable foreground (246)', () => {
    for (const style of ['--en-highlight:yellow;background-color: #ffef9e;', 'background-color: rgb(255, 250, 165);-evernote-highlight:true;']) {
      const { doc, report } = conv(`<div><span style="${style}">hi</span></div>`);
      const marks = doc.content[0].content[0].marks;
      expect(marks.map((m) => m.type)).toContain('highlight');
      // The background moved onto the mark; it must not ALSO arrive as a textStyle background.
      expect(marks.find((m) => m.type === 'textStyle')?.attrs.backgroundColor || '').toBe('');
      expect(report.highlights).toBe(1);
    }
  });

  it('writes a recognised palette colour as its token, whatever its spelling (247)', () => {
    const { doc, report } = conv('<div><span style="color:#dc2626">a</span><font color="#15803d">b</font><span style="color: rgb(220, 38, 38)">c</span><span style="color:#123456">d</span></div>');
    const colours = doc.content[0].content.map((t) => t.marks?.find((m) => m.type === 'textStyle')?.attrs.color);
    expect(colours).toEqual(['note-red', 'note-green', 'note-red', '#123456']);
    expect(report.colourTokens).toBe(3);
  });
});

describe('images that are not resources', () => {
  it('turns a remote <img> into a link, never an image node (measured: removed on save, and a beacon)', () => {
    const { doc, report } = conv('<div><img src="https://example.test/pics/cat.png" alt="A cat"/> and <img src="https://example.test/pics/dog.jpg?x=1"/></div>');
    expect(nodesOf(doc, 'noteImage')).toHaveLength(0);
    const links = doc.content[0].content.filter((t) => t.marks?.some((m) => m.type === 'link'));
    expect(links.map((t) => [t.text, t.marks.find((m) => m.type === 'link').attrs.href])).toEqual([
      ['A cat', 'https://example.test/pics/cat.png'],
      ['dog.jpg', 'https://example.test/pics/dog.jpg?x=1']
    ]);
    expect(report.remoteImages).toBe(2);
  });

  it('keeps a data: image and an image map verbatim as rawHtml', () => {
    const { doc, report } = conv('<div><img src="data:image/png;base64,iVBOR" alt="x"/></div><map name="m"><area href="https://example.test/a" alt="spot"/></map>');
    const raw = nodesOf(doc, 'rawHtml').map((n) => n.attrs.html);
    expect(raw.some((h) => h.includes('data:image/png;base64,iVBOR'))).toBe(true);
    expect(raw.some((h) => h.includes('https://example.test/a'))).toBe(true);
    expect(report.rawHtml).toBe(2);
  });
});

describe('small semantic elements', () => {
  it('draws the quotation marks <q> used to get from the browser', () => {
    expect(textOf(conv('<div>he said <q>hi</q></div>').doc)).toBe('he said “hi”');
  });

  it('keeps the text of abbr, a hidden div, and bidi text, counting what it dropped', () => {
    const { doc, report } = conv('<div><abbr title="HyperText">HTML</abbr></div><div style="display:none">hidden</div><div dir="rtl">مرحبا</div>');
    expect(textOf(doc)).toBe('HTMLhiddenمرحبا');
    expect(report.degraded.title).toBe(1);
    expect(report.degraded.dir).toBe(1);
  });

  it('drops prohibited elements with their text, and counts them', () => {
    const { doc, report } = conv('<div>kept<script>alert(1)</script><style>p{}</style></div>');
    expect(textOf(doc)).toBe('kept');
    expect(report.dropped).toEqual({ script: 1, style: 1 });
  });

  it('keeps Indic and right-to-left body text byte for byte', () => {
    const text = 'తెలుగు వచనం క్ష్మ — עברית — العربية';
    expect(textOf(conv(`<div>${text}</div>`).doc)).toBe(text);
  });
});

describe('attributes', () => {
  // The schema's own nodes are recognised by attributes (`data-type`, `data-note-attachment`, `path`,
  // `data-note-raw-html`). ENML forbids data-* and web clips carry them anyway, so copying every attribute
  // would let a crafted export FORGE a node — an attachment with a real-looking Storage path, say.
  it('copies only the attributes the schema reads, so ENML cannot forge one of its nodes', () => {
    const { doc } = conv('<div data-note-attachment="" path="notes/11111111-1111-4111-8111-111111111111/x/a.pdf" src="https://evil.test/a">forged</div><ul data-type="taskList"><li data-type="taskItem" data-checked="true">not a task</li></ul><div data-note-raw-html="&lt;b&gt;x&lt;/b&gt;">plain</div>');
    expect(nodesOf(doc, 'noteAttachment')).toHaveLength(0);
    expect(nodesOf(doc, 'taskItem')).toHaveLength(0);
    expect(nodesOf(doc, 'rawHtml')).toHaveLength(0);
    expect(textOf(doc)).toBe('forgednot a taskplain');
  });
});

describe('a style the DOM implementation refuses', () => {
  // Found by the corpus run (2026-09-14): jsdom 29.1.1's `setAttribute('style', …)` THROWS on this valid CSS
  // (inside its background-shorthand expansion), and one real note crashed the whole run. A browser accepts
  // it — but this module runs under jsdom for the tests, the corpus run and any future server worker, and a
  // note must never crash an import. Minimised from the real value by dropping declarations while it threw.
  const STYLE = 'background:none repeat scroll 0% 0% transparent; background-attachment:scroll; background-color:transparent';

  it('control: jsdom really does throw on it', () => {
    expect(() => document.createElement('p').setAttribute('style', STYLE)).toThrow();
  });

  it('keeps the note, the text and every declaration the DOM accepts, and counts the refusal', () => {
    const { doc, report } = conv(`<div style="text-align:center; ${STYLE}">kept</div>`);
    expect(textOf(doc)).toBe('kept');
    expect(doc.content[0].attrs.textAlign).toBe('center');
    expect(report.degraded.style).toBe(1);
  });
});

describe('links', () => {
  it('keeps evernote:/// links and refuses javascript: ones while keeping their text (246:B2)', () => {
    const { doc } = conv('<div><a href="evernote:///view/1/s1/abc/abc/">SQL</a> <a href="javascript:alert(1)">bad</a></div>');
    const runs = doc.content[0].content;
    const sql = runs.find((t) => t.text === 'SQL');
    expect(sql.marks[0].attrs.href).toBe('evernote:///view/1/s1/abc/abc/');
    // " " and "bad" are both unmarked once the javascript: href is refused, so they merge into one run.
    expect(runs.find((t) => t.text.includes('bad')).marks).toBeUndefined();
    expect(textOf(doc)).toBe('SQL bad');
  });
});

describe('everything else in the DTD is copied and the schema decides', () => {
  it('keeps nested tables, headings, sub/sup, strike and definition lists with their text', () => {
    const { doc } = conv('<h4>H</h4><table><tr><td><table><tr><td>inner</td></tr></table></td><td>x<sub>2</sub><strike>s</strike></td></tr></table><dl><dt>t</dt><dd>d</dd></dl>');
    expect(nodesOf(doc, 'table')).toHaveLength(2);
    expect(nodesOf(doc, 'heading')[0].attrs.level).toBe(4);
    expect(textOf(doc)).toBe('Hinnerx2std');
  });
});
