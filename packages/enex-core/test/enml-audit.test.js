// @vitest-environment jsdom
//
// 252 — "0 characters lost" as a check rather than a claim. The converter legitimately ADDS characters
// (“” for <q>, ☐ for a mid-line todo, a URL segment for an image link) and must never REMOVE one, so the
// rule is a subsequence, not equality — and whitespace is ignored, because outside code it is layout.
import { describe, it, expect } from 'vitest';
import { isTextPreserved, docText } from '../src/enml/enml-audit.js';

describe('isTextPreserved', () => {
  it('accepts identical text', () => {
    expect(isTextPreserved('hello world', 'hello world')).toBe(true);
  });

  it('accepts added characters anywhere', () => {
    expect(isTextPreserved('quote', '“quote”')).toBe(true);
    expect(isTextPreserved('callBob', 'call ☐ Bob')).toBe(true);
  });

  it('ignores whitespace on both sides', () => {
    expect(isTextPreserved('a  b\n c', 'abc')).toBe(true);
  });

  it('fails when one character is missing', () => {
    expect(isTextPreserved('alphabet', 'alphabt')).toBe(false);
  });

  it('fails when characters are reordered, which a count comparison would miss', () => {
    expect(isTextPreserved('ab', 'ba')).toBe(false);
  });
});

describe('docText', () => {
  it('reads text nodes, a locked block\'s ciphertext and hint, and a rawHtml payload through the DOM', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'noteLocked', attrs: { ciphertext: 'U2Fs', hint: 'dog' } },
        { type: 'rawHtml', attrs: { html: '<map><area href="x" alt="spot">three&amp;four</map>' } }
      ]
    };
    const text = docText(doc, { window });
    expect(text).toContain('one');
    expect(text).toContain('U2Fs');
    expect(text).toContain('dog');
    // Entity decoded by the DOM, not a regex.
    expect(text).toContain('three&four');
  });
});
