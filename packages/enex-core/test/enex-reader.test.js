// 253 — the streaming ENEX reader. Synthetic exports only: the owner's corpus has 0 nested CDATA, 0
// empty <data>, 0 slashed file names and 0 <task>, so each quirk other importers report gets its own
// fixture here. The real files are read only by the opt-in corpus run.
import { describe, it, expect, vi } from 'vitest';
import { Blob } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { readEnex } from '../src/enex/enex-reader.js';

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n';
const exportOf = (notes, attrs = 'export-date="20260914T000000Z" application="Evernote" version="11.32.5"') =>
  `${PROLOG}<en-export ${attrs}>\n${notes.join('\n')}\n</en-export>\n`;

function resourceXml({ bytes = Buffer.from('hello'), mime = 'image/png', fileName = 'a.png', width, height, dataAttrs = ' encoding="base64"', data } = {}) {
  const b64 = data ?? bytes.toString('base64').replace(/(.{76})/g, '$1\n');
  return `<resource><data${dataAttrs}>\n${b64}\n</data><mime>${mime}</mime>` +
    `${width ? `<width>${width}</width>` : ''}${height ? `<height>${height}</height>` : ''}` +
    `<resource-attributes><file-name>${fileName}</file-name><source-url>x</source-url></resource-attributes></resource>`;
}

function noteXml({ title = 'A note', created = '20200101T101010Z', updated = '20210101T101010Z', tags = [], content = '<en-note><div>hi</div></en-note>', resources = [], extra = '', attributes = '<author>me</author>' } = {}) {
  return `<note><title>${title}</title><created>${created}</created><updated>${updated}</updated>` +
    tags.map((t) => `<tag>${t}</tag>`).join('') +
    `<note-attributes>${attributes}</note-attributes>` +
    `<content>\n<![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">${content}]]>\n</content>` +
    resources.join('') + extra + '</note>';
}

// A Blob whose stream yields the bytes in pieces of `size` — to cut multi-byte characters, entities and
// terminators wherever they fall, since a real Blob.stream() chooses its own boundaries.
function piecewiseBlob(text, size) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    size: bytes.length,
    stream() {
      let at = 0;
      return new ReadableStream({
        pull(controller) {
          if (at >= bytes.length) return controller.close();
          controller.enqueue(new Uint8Array(bytes.subarray(at, at + size)));
          at += size;
        }
      });
    }
  };
}

async function readAll(input, options) {
  const blob = typeof input === 'string' ? new Blob([input]) : input;
  const records = [];
  for await (const r of readEnex(blob, options)) records.push(r);
  return { records, notes: records.filter((r) => r.kind === 'note'), end: records.at(-1) };
}

describe('readEnex — fields', () => {
  it('yields the export record, then each note with its fields, then an end record', async () => {
    const png = randomBytes(2000);
    const { records, notes, end } = await readAll(exportOf([
      noteXml({ title: 'A &amp; B &#x263A;', tags: ['work', 'ideas'], resources: [resourceXml({ bytes: png, width: 10, height: 20 })] }),
      noteXml({ title: 'Second' })
    ]));
    expect(records[0]).toEqual({ kind: 'export', application: 'Evernote', version: '11.32.5' });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      kind: 'note', index: 0, title: 'A & B ☺', created: '20200101T101010Z', updated: '20210101T101010Z',
      tags: ['work', 'ideas'], attributes: { author: 'me' }, problems: {}
    });
    expect(notes[0].content).toBe('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>hi</div></en-note>');
    expect(notes[0].resources).toEqual([{ md5: md5(png), bytes: 2000, mime: 'image/png', fileName: 'a.png', width: 10, height: 20, problem: null }]);
    expect(notes[1]).toMatchObject({ index: 1, title: 'Second', resources: [], tasks: [] });
    expect(end).toEqual({ kind: 'end', notes: 2 });
  });

  it('does not depend on element order: content after metadata, resources before content, tags last', async () => {
    const bytes = randomBytes(100);
    const xml = exportOf([
      `<note>${resourceXml({ bytes })}<tag>t</tag><content><![CDATA[<en-note>x</en-note>]]></content>` +
      '<updated>20210101T101010Z</updated><note-attributes><source-url>https://e.test/a</source-url></note-attributes>' +
      '<created>20200101T101010Z</created><title>T</title></note>'
    ]);
    const { notes } = await readAll(xml);
    expect(notes[0]).toMatchObject({ title: 'T', created: '20200101T101010Z', tags: ['t'], content: '<en-note>x</en-note>', attributes: { sourceUrl: 'https://e.test/a' } });
    expect(notes[0].resources[0].md5).toBe(md5(bytes));
  });

  it('maps <task> into the converter\'s shape, keyed by taskGroupNoteLevelID', async () => {
    const task = (t, s, g, w, due = '') => `<task><title>${t}</title><created>20200101T000000Z</created><taskStatus>${s}</taskStatus>` +
      `<inNote>true</inNote><taskFlag>false</taskFlag><sortWeight>${w}</sortWeight><noteLevelID>n</noteLevelID>` +
      `<taskGroupNoteLevelID>${g}</taskGroupNoteLevelID>${due ? `<dueDate>${due}</dueDate>` : ''}<reminder><reminderDate>x</reminderDate></reminder></task>`;
    const { notes } = await readAll(exportOf([noteXml({ extra: task('Buy milk', 'open', 'G1', 'B') + task('Call', 'completed', 'G1', 'A', '20260101T000000Z') })]));
    expect(notes[0].tasks).toEqual([
      { groupId: 'G1', title: 'Buy milk', status: 'open', sortWeight: 'B', dueDate: null },
      { groupId: 'G1', title: 'Call', status: 'completed', sortWeight: 'A', dueDate: '20260101T000000Z' }
    ]);
  });

  it('keeps a file name exactly as written — slashes included — because it is display text, never a key', async () => {
    const { notes } = await readAll(exportOf([noteXml({ resources: [resourceXml({ fileName: '../../etc/passwd\\x.pdf', mime: 'application/octet-stream' })] })]));
    expect(notes[0].resources[0]).toMatchObject({ fileName: '../../etc/passwd\\x.pdf', mime: 'application/octet-stream', problem: null });
  });

  it('ignores <recognition> and <alternate-data> inside a resource, and unknown elements, without keeping their text', async () => {
    const bytes = randomBytes(30);
    const res = `<resource><data encoding="base64">${bytes.toString('base64')}</data><mime>image/png</mime>` +
      '<recognition><![CDATA[<recoIndex><item><t>secret</t></item></recoIndex>]]></recognition>' +
      `<alternate-data encoding="base64">${randomBytes(10).toString('base64')}</alternate-data></resource>`;
    const { notes } = await readAll(exportOf([noteXml({ resources: [res], extra: '<future-element>zzz</future-element>' })]));
    expect(notes[0].resources).toEqual([{ md5: md5(bytes), bytes: 30, mime: 'image/png', fileName: null, width: null, height: null, problem: null }]);
    expect(notes[0].problems).toEqual({ 'unknown-element': 1 });
    expect(JSON.stringify(notes[0])).not.toContain('secret');
  });

  it('a timestamp that is not Evernote\'s basic ISO format becomes null and is counted', async () => {
    const { notes } = await readAll(exportOf([noteXml({ created: '2020-01-01', updated: 'x20210101T101010Zx' })]));
    expect(notes[0]).toMatchObject({ created: null, updated: null, problems: { 'bad-timestamp': 2 } });
  });

  it('reads a file with no XML declaration, no DOCTYPE and CRLF line endings', async () => {
    const xml = exportOf([noteXml()]).replace(PROLOG, '').replace(/\n/g, '\r\n');
    const { notes, end } = await readAll(xml);
    expect(notes).toHaveLength(1);
    expect(end.error).toBeUndefined();
  });
});

describe('readEnex — resources', () => {
  it('an empty <data/> is a per-resource problem; the MD5 is of zero bytes', async () => {
    const res = '<resource><data encoding="base64"/><mime>image/png</mime></resource>';
    const { notes } = await readAll(exportOf([noteXml({ resources: [res] }), noteXml({ title: 'next' })]));
    expect(notes[0].resources[0]).toMatchObject({ bytes: 0, problem: 'empty', md5: md5(Buffer.alloc(0)) });
    expect(notes[1].title).toBe('next');
  });

  it('<data> without an encoding attribute is base64 (the DTD default)', async () => {
    const bytes = randomBytes(99);
    const { notes } = await readAll(exportOf([noteXml({ resources: [resourceXml({ bytes, dataAttrs: '' })] })]));
    expect(notes[0].resources[0]).toMatchObject({ md5: md5(bytes), bytes: 99, problem: null });
  });

  it('the encoding name is compared case-insensitively (NMTOKEN in the DTD; `BASE64` is still base64)', async () => {
    const bytes = randomBytes(12);
    const { notes } = await readAll(exportOf([noteXml({ resources: [resourceXml({ bytes, dataAttrs: ' encoding="BASE64"' })] })]));
    expect(notes[0].resources[0]).toMatchObject({ md5: md5(bytes), problem: null });
  });

  it('mime is trimmed and an empty width or height is null, not 0', async () => {
    const res = `<resource><data>${Buffer.from('x').toString('base64')}</data><mime>\n image/png \n</mime><width></width><height> 7 </height></resource>`;
    const { notes } = await readAll(exportOf([noteXml({ resources: [res] })]));
    expect(notes[0].resources[0]).toMatchObject({ mime: 'image/png', width: null, height: 7 });
  });

  it('an encoding other than base64 is unsupported: no size, no hash, counted on the resource', async () => {
    const { notes } = await readAll(exportOf([noteXml({ resources: [resourceXml({ dataAttrs: ' encoding="hex"', data: 'abcd' })] })]));
    expect(notes[0].resources[0]).toMatchObject({ md5: null, bytes: null, problem: 'unsupported-encoding' });
  });

  it('corrupt base64 marks that resource and nothing else', async () => {
    const good = randomBytes(10);
    const { notes } = await readAll(exportOf([
      noteXml({ resources: [resourceXml({ data: 'QUJD*REVG' }), resourceXml({ bytes: good })] }),
      noteXml({ title: 'unaffected', resources: [resourceXml({ bytes: good })] })
    ]));
    expect(notes[0].resources.map((r) => r.problem)).toEqual(['corrupt', null]);
    expect(notes[0].resources[0].md5).toBe(null);
    expect(notes[1].resources[0]).toMatchObject({ md5: md5(good), problem: null });
  });

  it('past the decoded-size cap the resource is counted but not hashed', async () => {
    const big = randomBytes(5000);
    const { notes } = await readAll(exportOf([noteXml({ resources: [resourceXml({ bytes: big })] })]), { limits: { maxResourceBytes: 1000 } });
    expect(notes[0].resources[0]).toMatchObject({ md5: null, bytes: 5000, problem: 'too-large-to-read' });
  });

  it('hashes a multi-megabyte resource correctly when the file arrives in odd-sized byte pieces', async () => {
    const big = randomBytes(3 * 1024 * 1024 + 7);
    const xml = exportOf([noteXml({ title: 'తెలుగు 😀', resources: [resourceXml({ bytes: big })] })]);
    const { notes } = await readAll(piecewiseBlob(xml, 65531));
    expect(notes[0].title).toBe('తెలుగు 😀');
    expect(notes[0].resources[0]).toMatchObject({ md5: md5(big), bytes: big.length, problem: null });
  });
});

describe('readEnex — boundaries', () => {
  it('produces identical records whatever the byte pieces (1, 2, 3, 7 bytes) — entities, CDATA terminators and UTF-8 cut anywhere', async () => {
    const xml = exportOf([
      noteXml({ title: 'Ünïcødé &amp; తెలుగు &#128512;', tags: ['a&lt;b'], resources: [resourceXml({ bytes: randomBytes(40) })],
        content: '<en-note><div><![CDATA[x]]></div></en-note>' }),
      noteXml({ title: 'two' })
    ]);
    const whole = await readAll(xml);
    for (const size of [1, 2, 3, 7]) {
      const pieces = await readAll(piecewiseBlob(xml, size), { limits: { chunkChars: 5 } });
      expect(pieces.records, `piece ${size}`).toEqual(whole.records);
    }
  });

  it('reports progress in bytes read', async () => {
    const xml = exportOf([noteXml()]);
    const seen = [];
    await readAll(piecewiseBlob(xml, 50), { onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(Buffer.byteLength(xml));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('awaits `pause` between chunks INSIDE a note, so one 176 MB note cannot hold the page for its whole length', async () => {
    const bytes = randomBytes(300 * 1024);
    const xml = exportOf([noteXml({ resources: [resourceXml({ bytes })] })]);
    let pauses = 0;
    let recordsWhenFirstPaused = null;
    const records = [];
    for await (const r of readEnex(piecewiseBlob(xml, 64 * 1024), { pause: async () => { pauses += 1; recordsWhenFirstPaused ??= records.length; } })) records.push(r);
    expect(pauses).toBeGreaterThanOrEqual(5);
    expect(recordsWhenFirstPaused).toBe(1); // only the export record: the pauses fell while the note was still being read
    expect(records.filter((r) => r.kind === 'note')[0].resources[0].md5).toBe(md5(bytes));
  });

  it('stops reading the file when the consumer stops iterating', async () => {
    const cancel = vi.fn();
    const xml = exportOf(Array.from({ length: 50 }, (_, i) => noteXml({ title: `n${i}` })));
    const bytes = Buffer.from(xml);
    let at = 0;
    const blob = {
      stream: () => new ReadableStream({
        pull(c) { if (at >= bytes.length) return c.close(); c.enqueue(new Uint8Array(bytes.subarray(at, at + 200))); at += 200; },
        cancel
      })
    };
    for await (const r of readEnex(blob)) if (r.kind === 'note') break;
    expect(cancel).toHaveBeenCalled();
    expect(at).toBeLessThan(bytes.length);
  });
});

describe('readEnex — nested CDATA (Evernote 10 quirk)', () => {
  it('reads a note whose content ends an inner CDATA inside the note', async () => {
    const xml = exportOf([noteXml({ content: '<en-note><div><![CDATA[x]]></div></en-note>' }), noteXml({ title: 'after' })]);
    const { notes, end } = await readAll(xml);
    expect(end.error).toBeUndefined();
    expect(notes[0].content).toContain('<en-note><div><![CDATA[x]]></div></en-note>');
    expect(notes[1].title).toBe('after');
  });

  it("reads 10.65.3's `]]<![CDATA[>]]>`", async () => {
    const { notes } = await readAll(exportOf([noteXml({ content: '<en-note><div>a]]<![CDATA[>]]>b</div></en-note>' })]));
    expect(notes[0].content).toContain('<div>a]]<![CDATA[>]]>b</div>');
  });
});

describe('readEnex — hardening and caps', () => {
  it('refuses a DOCTYPE with an internal subset before yielding any note (billion laughs never reaches an entity)', async () => {
    const lol = '<!DOCTYPE en-export [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>';
    const { records } = await readAll(`<?xml version="1.0"?>${lol}<en-export>${noteXml({ title: '&lol2;' })}</en-export>`);
    expect(records).toEqual([{ kind: 'end', notes: 0, error: 'internal-dtd' }]);
  });

  it('refuses an internal subset that declares no entity, too — Evernote never writes one', async () => {
    const { records } = await readAll(`<!DOCTYPE en-export [<!ATTLIST note a CDATA "x">]><en-export>${noteXml()}</en-export>`);
    expect(records).toEqual([{ kind: 'end', notes: 0, error: 'internal-dtd' }]);
  });

  it('an undefined entity is not expanded and is not silently dropped: the file ends malformed, keeping the notes before it', async () => {
    const { notes, end } = await readAll(exportOf([noteXml({ title: 'ok' }), noteXml({ title: 'a&nbsp;b' }), noteXml({ title: 'never' })]));
    expect(notes.map((n) => n.title)).toEqual(['ok']);
    expect(end).toEqual({ kind: 'end', notes: 1, error: 'malformed-xml' });
  });

  it('a file cut off part-way keeps the complete notes and says it ended malformed', async () => {
    const xml = exportOf([noteXml({ title: 'one' }), noteXml({ title: 'two' })]);
    const { notes, end } = await readAll(xml.slice(0, xml.indexOf('<title>two')));
    expect(notes.map((n) => n.title)).toEqual(['one']);
    expect(end).toEqual({ kind: 'end', notes: 1, error: 'malformed-xml' });
  });

  it('a document whose root is not <en-export> is not an ENEX export', async () => {
    expect((await readAll('<?xml version="1.0"?><html><body>hi</body></html>')).records).toEqual([{ kind: 'end', notes: 0, error: 'not-enex' }]);
    expect((await readAll('')).records).toEqual([{ kind: 'end', notes: 0, error: 'not-enex' }]);
  });

  it('a 300 KB attribute value is refused even when the stream delivers it in ONE piece (sax checks buffers only between writes)', async () => {
    const xml = `<en-export application="${'x'.repeat(300 * 1024)}">${noteXml()}</en-export>`;
    const bytes = Buffer.from(xml);
    const oneChunk = { stream: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }) };
    const { notes, end } = await readAll(oneChunk);
    expect(notes).toHaveLength(0);
    expect(end).toEqual({ kind: 'end', notes: 0, error: 'malformed-xml' });
  });

  it('a file ending in an incomplete UTF-8 sequence is not accepted as if it ended cleanly', async () => {
    const bytes = Buffer.concat([Buffer.from(exportOf([noteXml()])), Buffer.from([0xe0, 0xb0])]);
    const blob = { stream: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }) };
    const { notes, end } = await readAll(blob);
    expect(notes).toHaveLength(1);
    expect(end).toEqual({ kind: 'end', notes: 1, error: 'malformed-xml' });
  });

  it('ENEX structure deeper than the cap ends the file', async () => {
    const deep = '<x>'.repeat(20) + '</x>'.repeat(20);
    const { end } = await readAll(exportOf([noteXml({ extra: deep })]));
    expect(end).toEqual({ kind: 'end', notes: 0, error: 'too-deep' });
  });

  it('content over the cap is null and counted; the note is still yielded and the next note is whole', async () => {
    const { notes } = await readAll(exportOf([noteXml({ content: `<en-note>${'x'.repeat(5000)}</en-note>` }), noteXml({ title: 'next' })]), { limits: { maxContentChars: 1000 } });
    expect(notes[0]).toMatchObject({ content: null, problems: { 'content-too-large': 1 } });
    expect(notes[1]).toMatchObject({ title: 'next', problems: {} });
    expect(notes[1].content).toContain('<div>hi</div>');
  });

  it('a kept field over the cap is null and counted', async () => {
    const { notes } = await readAll(exportOf([noteXml({ title: 't'.repeat(200), tags: ['u'.repeat(200), 'ok'] })]), { limits: { maxFieldChars: 100 } });
    expect(notes[0]).toMatchObject({ title: null, tags: ['ok'], problems: { 'field-too-large': 2 } });
  });

  it('tags, resources and tasks past their per-note caps are counted, not kept', async () => {
    const { notes } = await readAll(exportOf([noteXml({ tags: ['a', 'b', 'c'], resources: [resourceXml(), resourceXml(), resourceXml()] })]),
      { limits: { maxTags: 2, maxResources: 1 } });
    expect(notes[0].tags).toEqual(['a', 'b']);
    expect(notes[0].resources).toHaveLength(1);
    expect(notes[0].problems).toEqual({ 'too-many-tags': 1, 'too-many-resources': 2 });
  });
});

// 384 — the import keeps each resource's decoded bytes (the dry run does not).
describe('keepResourceData (384)', () => {
  const b64 = Buffer.from('hello, attachment').toString('base64');
  const enex = `<?xml version="1.0" encoding="UTF-8"?><en-export application="Evernote" version="10"><note><title>T</title><content><![CDATA[<en-note>x</en-note>]]></content><created>20120304T050607Z</created><resource><data encoding="base64">${b64}</data><mime>text/plain</mime><resource-attributes><file-name>a.txt</file-name></resource-attributes></resource></note></en-export>`;
  const notesOf = async (opts) => {
    const out = [];
    for await (const r of readEnex(new Blob([enex]), opts)) if (r.kind === 'note') out.push(r);
    return out;
  };
  it('off by default: no bytes are held', async () => {
    const [note] = await notesOf({});
    expect(note.resources[0].data).toBeUndefined();
  });
  it('on: the decoded bytes come back as a Blob with the same md5-checked content', async () => {
    const [note] = await notesOf({ keepResourceData: true });
    const r = note.resources[0];
    expect(r.data).toBeInstanceOf(Blob);
    expect(Buffer.from(await r.data.arrayBuffer()).toString()).toBe('hello, attachment');
    expect(r.data.size).toBe(r.bytes);
    expect(r.fileName).toBe('a.txt');
  });
});

// 421 — a ZIP entry is a source whose stream can fail part-way. A failure that names itself too large
// (zip-source.js's cap) is that file's own error; any other is read-failed. Notes read before it still count.
describe('a source whose stream fails part-way (421)', () => {
  const failing = (error) => {
    const head = Buffer.from(`${PROLOG}<en-export>\n<note><title>First</title><content><![CDATA[<en-note>a</en-note>]]></content></note>\n`);
    return {
      name: 'x.enex', size: head.length * 2,
      stream: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(head)); }, pull(c) { c.error(error); } })
    };
  };
  const run = async (source) => {
    const out = [];
    for await (const r of readEnex(source)) out.push(r.kind === 'note' ? r.title : r);
    return out;
  };

  it('records too-large when the stream says so, after the notes it did read', async () => {
    const out = await run(failing(Object.assign(new Error('cap'), { fileError: 'too-large' })));
    expect(out).toContain('First');
    expect(out.at(-1)).toMatchObject({ kind: 'end', error: 'too-large' });
  });

  it('records too-compressed when the stream says so', async () => {
    expect((await run(failing(Object.assign(new Error('bomb'), { fileError: 'too-compressed' })))).at(-1)).toMatchObject({ error: 'too-compressed' });
  });

  it('benign: any other stream failure is read-failed, whatever fileError it claims', async () => {
    expect((await run(failing(new Error('disk')))).at(-1)).toMatchObject({ error: 'read-failed' });
    expect((await run(failing(Object.assign(new Error('x'), { fileError: 'malformed-xml' })))).at(-1)).toMatchObject({ error: 'read-failed' });
  });
});
