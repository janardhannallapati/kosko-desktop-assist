// @vitest-environment jsdom
//
// 252 — turning an ENML string into a DOM tree the pre-pass can walk. Measured before this existed:
// `a&nbsp;b` failed an XML parse outright ("undefined entity"), because ENML's DTD declares the XHTML
// entity set and a DTD is never fetched. Older Evernote clients write `&nbsp;` constantly; the owner's
// 11.32.5 corpus happens to contain only the five XML entities, which is exactly why this is tested with
// a synthetic fixture and not left to that corpus.
import { describe, it, expect } from 'vitest';
import { prepareEnml } from '../src/enml/enml-source.js';

const wrap = (body, prolog = '') => `${prolog}<en-note>${body}</en-note>`;
const PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';

describe('prepareEnml', () => {
  it('parses a real-shaped note, prolog and DOCTYPE included', () => {
    const r = prepareEnml(wrap('<div>hi</div>', PROLOG), { window });
    expect(r.ok).toBe(true);
    expect(r.malformed).toBeFalsy();
    expect(r.root.localName).toBe('en-note');
    expect(r.root.textContent).toBe('hi');
  });

  it('decodes named XHTML entities that an XML parser without the DTD cannot', () => {
    const r = prepareEnml(wrap('<div>a&nbsp;b&eacute;&copy;</div>'), { window });
    expect(r.ok).toBe(true);
    expect(r.malformed).toBeFalsy();
    expect(r.root.textContent).toBe('a bé©');
  });

  it('leaves the five XML entities to the XML parser', () => {
    const r = prepareEnml(wrap('<div>&lt;tag&gt; &amp; &quot;q&quot; &apos;</div>'), { window });
    expect(r.root.textContent).toBe('<tag> & "q" \'');
  });

  it('keeps an entity name the browser does not know as literal text rather than failing the note', () => {
    const r = prepareEnml(wrap('<div>x&notarealentity;y</div>'), { window });
    expect(r.ok).toBe(true);
    expect(r.malformed).toBeFalsy();
    expect(r.root.textContent).toBe('x&notarealentity;y');
  });

  it('refuses a note that declares an entity, however it is spelled', () => {
    // The cost of a billion-laughs document is in the parse itself (243), so the only safe answer is to
    // never hand one to a parser. Evernote never writes an internal subset.
    for (const prolog of [
      '<!DOCTYPE en-note [<!ENTITY lol "lol">]>',
      '<!DOCTYPE en-note [\n  <!entity lol "lol">\n]>',
      '<!DOCTYPE en-note SYSTEM "x" [<!ENTITY % p "x">]>'
    ]) {
      expect(prepareEnml(wrap('<div>&lol;</div>', prolog), { window })).toEqual({ ok: false, reason: 'entity-declaration' });
    }
  });

  it('reports malformed XML instead of throwing, so the caller can keep the note verbatim', () => {
    const r = prepareEnml('<en-note><div>unclosed</en-note>', { window });
    expect(r.ok).toBe(true);
    expect(r.malformed).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(prepareEnml(undefined, { window })).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('keeps CDATA text inside a note, which Evernote 10.58 wrote, and does not decode entities in it', () => {
    const r = prepareEnml(wrap('<div><![CDATA[DSCN0716.JPG &nbsp;]]></div>'), { window });
    // Inside CDATA `&nbsp;` is six literal characters the author typed, not a space.
    expect(r.root.textContent).toBe('DSCN0716.JPG &nbsp;');
  });
});
