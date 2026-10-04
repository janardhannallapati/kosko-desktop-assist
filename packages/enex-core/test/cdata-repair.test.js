// @vitest-environment jsdom
//
// 253 — the CDATA repair in front of `sax`. Evernote has written notes whose <content> CDATA holds a
// stray `]]>`: a multi-note export from 10.65.3 wrote `]]<![CDATA[>]]>` (obsidian-importer #173), and
// another export ended an inner CDATA inside the note (`…<![CDATA[x]]></en-note>]]></content>`). In
// XML the FIRST `]]>` ends the section, so a strict parser then meets `</en-note>` with no open
// element and gives up on the file. None of Joplin, obsidian-importer, yarle or evernote2md repairs
// this while streaming (Joplin's regex is commented out for running out of memory on 1 GB files).
//
// The oracle is jsdom's XML parser: the repaired output must parse, and <content>'s text must be the
// ENML the note meant. And the rule that makes the repair safe to run on EVERY file: on a document with
// no stray terminator, the output is byte-identical to the input.
import { describe, it, expect } from 'vitest';
import { createCdataRepair } from '../src/enex/cdata-repair.js';

const repairWhole = (s) => {
  const r = createCdataRepair();
  return r.push(s) + r.end();
};

// Every split point, and every pair of split points for short inputs: a repair that only works when a
// terminator arrives in one piece is the bug a streaming filter is most likely to have.
function repairEverySplit(s, check) {
  check(repairWhole(s), 'whole');
  for (let i = 1; i < s.length; i++) {
    const r = createCdataRepair();
    check(r.push(s.slice(0, i)) + r.push(s.slice(i)) + r.end(), `split@${i}`);
  }
  if (s.length <= 120) {
    for (let i = 1; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        const r = createCdataRepair();
        check(r.push(s.slice(0, i)) + r.push(s.slice(i, j)) + r.push(s.slice(j)) + r.end(), `split@${i},${j}`);
      }
    }
  }
}

function contentOf(xml) {
  const doc = new window.DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) return { error: true };
  return { error: false, text: doc.getElementsByTagName('content')[0]?.textContent };
}

const enex = (content) => `<en-export><note><title>t</title><content>${content}</content></note></en-export>`;

describe('createCdataRepair — identity on valid XML', () => {
  const valid = [
    enex('<![CDATA[<en-note><div>hello</div></en-note>]]>'),
    enex('<![CDATA[<en-note>a</en-note>]]>  \n  '),
    enex('<![CDATA[one]]><![CDATA[two]]>'),
    enex('<![CDATA[one]]>\n<![CDATA[two]]>'),
    enex('<![CDATA[x]]]]><![CDATA[>y]]>'), // the valid XML spelling of `]]>` inside CDATA
    '<?xml version="1.0"?><!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd"><en-export a="1">' +
      '<note><title>A &amp; B</title><content><![CDATA[<en-note/>]]></content></note></en-export>',
    '<r><a/><![CDATA[x]]></r>',
    '<r x=">" y=\'a>b\'><![CDATA[x]]></r>',
    '<r><!-- <![CDATA[ not a section ]]> --><c><![CDATA[x]]></c></r>',
    '<r><?pi <![CDATA[ ?><c><![CDATA[x]]></c></r>',
    '<r>]] > text</r>',
    '<r><content ><![CDATA[x]]></content ></r>',
    '<r><data>QUJD\nREVG</data></r>',
    // A `>` inside a comment or PI must not end it early, or the `<![CDATA[` after it would be taken for a
    // real section and the real one below would then be "repaired" (c7/c8 survived without these).
    '<r><!-- a > b <![CDATA[ --><content><![CDATA[x]]></content></r>',
    '<r><?pi a > b <![CDATA[ ?><content><![CDATA[x]]></content></r>'
  ];
  for (const xml of valid) {
    it(`returns the input unchanged at every chunk split: ${xml.slice(0, 60)}`, () => {
      repairEverySplit(xml, (out, where) => expect(out, where).toBe(xml));
    });
  }
});

describe('createCdataRepair — stray terminators', () => {
  it('repairs an inner CDATA that ends inside the note (the terminator is followed by </en-note>, not </content>)', () => {
    const input = enex('<![CDATA[<en-note><div><![CDATA[x]]></div></en-note>]]>');
    expect(contentOf(input).error).toBe(true); // the precondition: without the repair the file does not parse
    repairEverySplit(input, (out, where) => {
      const parsed = contentOf(out);
      expect(parsed.error, where).toBe(false);
      expect(parsed.text, where).toBe('<en-note><div><![CDATA[x]]></div></en-note>');
    });
  });

  it("repairs Evernote 10.65.3's `]]<![CDATA[>]]>` so the ENML keeps a CDATA that reads back as `]]>`", () => {
    const input = enex('<![CDATA[<en-note><div>a]]<![CDATA[>]]>b</div></en-note>]]>');
    expect(contentOf(input).error).toBe(true);
    repairEverySplit(input, (out, where) => {
      const parsed = contentOf(out);
      expect(parsed.error, where).toBe(false);
      expect(parsed.text, where).toBe('<en-note><div>a]]<![CDATA[>]]>b</div></en-note>');
      // …and the ENML itself, parsed as XML, carries the characters the author wrote.
      const enml = new window.DOMParser().parseFromString(parsed.text, 'application/xml');
      expect(enml.documentElement.textContent, where).toBe('a]]>b');
    });
  });

  it('decides by the element the section is IN: a close tag of another name does not end it', () => {
    const input = '<r><content><![CDATA[a]]></title>b]]></content></r>';
    const out = repairWhole(input);
    expect(contentOf(out)).toEqual({ error: false, text: 'a]]></title>b' });
  });

  it('a self-closing sibling before the section does not become the element it is in', () => {
    const input = '<r><content><x/><![CDATA[a]]></x>b]]></content></r>';
    const out = repairWhole(input);
    expect(contentOf(out)).toEqual({ error: false, text: 'a]]></x>b' });
  });

  it('whitespace between a stray terminator and a close tag of ANOTHER element does not end the section', () => {
    const input = '<r><content><![CDATA[<en-note><![CDATA[x]]>  \n</en-note>]]></content></r>';
    repairEverySplit(input, (out, where) => expect(contentOf(out), where).toEqual({ error: false, text: '<en-note><![CDATA[x]]>  \n</en-note>' }));
  });

  it('a close tag is matched by its whole name: `</contents>` does not end a section inside <content>', () => {
    const input = '<r><content><![CDATA[a]]></contents>b]]></content></r>';
    repairEverySplit(input, (out, where) => expect(contentOf(out), where).toEqual({ error: false, text: 'a]]></contents>b' }));
  });

  it('a quoted attribute value containing `/>` does not make its element self-closing', () => {
    const input = '<r><content a="/>"><![CDATA[a]]></r>b]]></content></r>';
    expect(contentOf(repairWhole(input))).toEqual({ error: false, text: 'a]]></r>b' });
  });

  it('a closed sibling is popped: a section directly in <r> after </title> is in <r>, not <title>', () => {
    const input = '<r><title>t</title><![CDATA[x]]></title>y]]></r>';
    const doc = new window.DOMParser().parseFromString(repairWhole(input), 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const sections = [...doc.documentElement.childNodes].filter((n) => n.nodeType === 4).map((n) => n.data).join('');
    expect(sections).toBe('x]]></title>y');
  });

  it('past the tracked depth the element is unknown, and a close tag after a terminator ends the section as XML says', () => {
    const open = Array.from({ length: 70 }, (_, i) => `<d${i}>`).join('');
    const close = Array.from({ length: 70 }, (_, i) => `</d${69 - i}>`).join('');
    const input = `<r>${open}<![CDATA[x]]></d69>${close.slice('</d69>'.length)}</r>`;
    repairEverySplit(input, (out, where) => expect(out, where).toBe(input));
  });

  it('a comment whose end arrives split across pieces still ends, so a later stray terminator is repaired', () => {
    const input = '<r><!-- c --><content><![CDATA[a]]></x>b]]></content></r>';
    repairEverySplit(input, (out, where) => expect(contentOf(out), where).toEqual({ error: false, text: 'a]]></x>b' }));
  });

  it('a terminator followed by more than 1,024 whitespace characters is taken as ending the section (bounded lookahead)', () => {
    const ws = ' '.repeat(1025);
    const input = `<r><content><![CDATA[a]]>${ws}x</content></r>`;
    const r = createCdataRepair();
    expect(r.push(input.slice(0, 40)) + r.push(input.slice(40)) + r.end()).toBe(input);
  });

  it('within the lookahead bound, whitespace before the close tag still ends the section', () => {
    const ws = ' \n\t'.repeat(300);
    const input = `<r><content><![CDATA[a]]>${ws}</content></r>`;
    repairEverySplit(input.length > 120 ? input : input, (out, where) => expect(out, where).toBe(input));
  });

  it('flushes a held-back terminator at end of input rather than dropping it', () => {
    const r = createCdataRepair();
    const out = r.push('<r><content><![CDATA[a]]>') + r.end();
    expect(out).toBe('<r><content><![CDATA[a]]>');
  });

  it('never grows a large CDATA quadratically: a 20 MB section in 64 KB pieces is repaired in bounded time', { timeout: 30000 }, () => {
    const body = 'x'.repeat(64 * 1024);
    const r = createCdataRepair();
    let out = r.push('<r><content><![CDATA[').length;
    for (let i = 0; i < 320; i++) out += r.push(body).length;
    out += (r.push(']]></content></r>') + r.end()).length;
    expect(out).toBe('<r><content><![CDATA['.length + 320 * body.length + ']]></content></r>'.length);
  });
});
