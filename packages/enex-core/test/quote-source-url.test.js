// Kosko 742 / 743: the address rule of a quote's source.
//
// The address ends up as a link's href on the source chip and in every export, so it is the one value here
// that can do harm. It is parsed BY HAND (scheme, no name or password, a real host, no hidden characters), so
// the answer is the same on a runtime whose URL is incomplete; where URL works it is one more check.
import { describe, it, expect, vi } from 'vitest';
import { quoteSourceUrl, SOURCE_URL_MAX } from '../src/index.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';
// Addresses whose host part is not a host. The first four were accepted before the second review.
const STRUCTURE = ['http://[evil]/', 'http://[1:2]:99999/', 'http://\uff20a.com', 'http://a.com:', 'http://a.com:/x', 'http://[::1/x', 'http://[::1]x/', 'http://a.com:65536/', 'http://a%2ecom/', 'http://a.com\uff1a80/', 'http://a!b.com/', 'http://a.com:80:80/', 'https://[]/', 'https://[:]/'];
const HOSTILE = [null, undefined, 7, true, {}, [], [ID], { toString: () => 'https://example.com/' }, new String('https://example.com/'), Symbol.iterator, () => ID, NaN];

describe('quoteSourceUrl: http or https only, no credentials, at most 2,000 characters', () => {
  it.each([
    'https://example.com/a?b=c#d',
    'http://example.com',
    'HTTPS://EXAMPLE.com/Path',
    'https://తెలుగు.example/వ్యాసం',
    'https://example.com:8443/a%20b',
    'https://example.com/?next=a@b.test#c@d',
    'http://127.0.0.1:3003/x',
    'https://[2001:db8::1]/x'
  ])('keeps %s exactly as written', (url) => {
    expect(quoteSourceUrl(url)).toBe(url);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['javascript with a tab inside', 'java\tscript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['ftp:', 'ftp://example.com/file'],
    ['file:', 'file:///etc/passwd'],
    ['evernote:', 'evernote:///view/1/s1/a/a/'],
    ['a name and password', 'https://user:pass@example.com/'],
    ['a name alone', 'https://user@example.com/'],
    ['no scheme', '//example.com/a'],
    ['a bare host', 'example.com'],
    ['a scheme with no slashes', 'https:example.com'],
    ['a space before it', ' https://example.com'],
    ['a space inside it', 'https://exa mple.com'],
    ['a line break after it', 'https://example.com/\n'],
    ['no host', 'https://'],
    ['a host that is only a dot', 'http://.'],
    ['a backslash in the path', 'https://example.com\\path'],
    ['an empty host before a path', 'http:///x'],
    ['a host of marks only', 'https://-._/x'],
    ['a backslash before the name sign', 'https://example.com\\@evil.test/'],
    ['a port that is not digits', 'https://example.com:80a/'],
    ['a zero-width space in the host', 'https://exam\u200bple.com/'],
    ['a bidi override in the path', 'https://example.com/\u202egnp.exe'],
    ['a NUL', 'https://example.com/\u0000'],
    ['a name sign hidden after a question mark is fine, but one in the host part is not', 'https://example.com@evil.test/?a'],
    ['the empty string', '']
  ])('refuses %s', (_name, value) => {
    expect(quoteSourceUrl(value)).toBeNull();
  });

  it('keeps 2,000 characters and refuses 2,001', () => {
    const base = 'https://example.com/';
    expect(quoteSourceUrl(base + 'a'.repeat(SOURCE_URL_MAX - base.length))).toHaveLength(2000);
    expect(quoteSourceUrl(base + 'a'.repeat(SOURCE_URL_MAX - base.length + 1))).toBeNull();
    expect(quoteSourceUrl(base + 'a'.repeat(1_000_000))).toBeNull();
  });

  it('refuses everything that is not a string, without throwing', () => {
    for (const bad of HOSTILE) expect(quoteSourceUrl(bad)).toBeNull();
  });

  it('does not depend on the runtime having a URL: with none, the hand rule decides alone', () => {
    vi.stubGlobal('URL', undefined);
    try {
      expect(quoteSourceUrl('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
      expect(quoteSourceUrl('https://తెలుగు.example/వ్యాసం')).toBe('https://తెలుగు.example/వ్యాసం');
      for (const bad of ['javascript:alert(1)', 'ftp://example.com/f', 'https://user:pass@example.com/', 'https://user@example.com/', 'http://.', 'http:///x', 'https://', ...STRUCTURE]) expect(quoteSourceUrl(bad), bad).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an address the runtime\'s URL cannot construct is refused, even one the hand rule would pass', () => {
    vi.stubGlobal('URL', class { constructor() { throw new TypeError('Invalid URL'); } });
    try {
      expect(quoteSourceUrl('https://example.com/a')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the host part holds letters, digits, hyphens, dots and underscores, or one bracketed IPv6 literal, and nothing else', () => {
    for (const bad of STRUCTURE) expect(quoteSourceUrl(bad), bad).toBeNull();
    for (const good of ['https://xn--d1acufc.xn--p1ai/', 'https://[::1]:8080/x', 'https://[2001:db8::1]/', 'http://127.0.0.1:3000/', 'https://sub_domain.example-site.co.in/', `https://example.com/${'%E0%B0%85'.repeat(200)}?q=a:b@c/d`]) {
      expect(quoteSourceUrl(good), good).toBe(good);
    }
  });

  it('half a surrogate pair, U+FFFE or U+FFFF anywhere refuses the address: an Evernote file cannot hold them (0.6.1)', () => {
    for (const bad of ['https://example.com/\ufffe', 'https://example.com/a\uffffb', 'https://example.com/\ud800', 'https://example.com/?q=\udc00x', 'https://exa\ud83dmple.com/', 'https://example.com/#\ude00\ud83d']) {
      expect(quoteSourceUrl(bad), JSON.stringify(bad)).toBeNull();
    }
    const whole = 'https://example.com/😀?q=\ud83d\ude00';
    expect(quoteSourceUrl(whole)).toBe(whole);
  });

  it('a joiner or non-joiner is allowed after the host (Persian and Indic addresses carry them), and nowhere in it', () => {
    for (const good of ['https://fa.example/می\u200cخواهم', 'https://te.example/క్\u200dష?q=క్\u200cష#క్\u200cష']) expect(quoteSourceUrl(good), good).toBe(good);
    for (const bad of ['https://exam\u200cple.com/', 'https://exam\u200dple.com/x', 'https://example.com/a\u200bb', 'https://example.com/a\u200eb', 'https://example.com/a\u2060b', 'https://example.com/?q=\u202ex']) expect(quoteSourceUrl(bad), JSON.stringify(bad)).toBeNull();
  });

  it('where URL works and reads the address differently, it is refused: one more check, never the only one', () => {
    const reads = (fields) => class { constructor() { Object.assign(this, { protocol: 'https:', username: '', password: '', hostname: 'example.com' }, fields); } };
    const good = 'https://example.com/a';
    try {
      for (const fields of [{ username: 'u' }, { password: 'p' }, { hostname: '' }, { protocol: 'ftp:' }]) {
        vi.stubGlobal('URL', reads(fields));
        expect(quoteSourceUrl(good), JSON.stringify(fields)).toBeNull();
      }
      vi.stubGlobal('URL', reads({}));
      expect(quoteSourceUrl(good)).toBe(good);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('where URL constructs and its getters throw or are missing, the hand rule decides', () => {
    vi.stubGlobal('URL', class {});
    try {
      expect(quoteSourceUrl('https://example.com/a')).toBe('https://example.com/a');
      expect(quoteSourceUrl('https://user@example.com/')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal('URL', class { get protocol() { throw new Error('x'); } });
    try {
      expect(quoteSourceUrl('https://example.com/a')).toBe('https://example.com/a');
      expect(quoteSourceUrl('https://user@example.com/')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
