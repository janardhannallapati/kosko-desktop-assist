// Kosko 538 — ENML notes the bundle and the executable must convert byte-identically to the source. The formatted
// bodies the send tests use, plus one note per construct the converter treats specially (styles jsdom parses,
// tables, lists, checklists, media, links, encrypted text), and one with broken XML, which takes the converter's
// raw-HTML fallback. Every word is invented.
import { BODIES, HEADER } from './fixtures/evernote-setup.mjs';

const H = 'abcdef0123456789abcdef0123456789';
const note = (body) => `${HEADER}<en-note>${body}</en-note>`;

export const ENML_SAMPLES = [
  ...Object.values(BODIES),
  note('<div style="text-align:center">c</div><div align="right">r</div><center>z</center><div><br/></div>'),
  note('<div><span style="color:rgb(255, 0, 0);background-color:#ffef9e;font-size:18px">red on yellow</span>'
    + '<span style="--en-highlight:yellow;font-family:\'Courier New\'">mono</span> <u>u</u> <s>s</s> <sup>2</sup><sub>i</sub></div>'),
  note('<div style="color: rgb(0, 0, 0); --en-codeblock:true;">let x = 1;<br/>x += 1;</div>'),
  note('<table style="width:100%"><colgroup><col style="width:120px"/><col/></colgroup><tr><th colspan="2">head</th></tr>'
    + '<tr><td style="text-align:right">1</td><td><div>two</div><div>lines</div></td></tr></table>'),
  note('<ul><li>a<ul><li>a.1</li></ul></li><li>b</li></ul><ol start="3"><li>three</li></ol>'
    + '<ul style="--en-todo:true"><li style="--en-checked:true">done</li><li style="--en-checked:false">open</li></ul>'),
  note(`<div>before<en-media hash="${H}" type="image/jpeg" width="120" height="80px"/>after</div>`
    + `<en-media hash="${H.replace('a', 'b')}" type="application/pdf"/>`),
  note('<div><a href="https://example.com/x?y=1">a link</a> and <a href="evernote:///view/1/s1/00000000-0000-4000-8000-000000000301/00000000-0000-4000-8000-000000000301/">a note link</a></div>'
    + '<hr/><blockquote>quoted</blockquote><h2>Heading</h2><pre>pre  text</pre>'),
  note('<en-crypt hint="pet" cipher="AES" length="128">U2FsdGVkX19aYWJj</en-crypt><div>after the secret</div>'),
  `${HEADER}<en-note><div>not closed</en-note>` // broken XML: the raw-HTML fallback
];
