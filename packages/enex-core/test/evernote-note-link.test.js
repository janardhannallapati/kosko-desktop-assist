// Kosko 510 / 514 — an Evernote note link names its note by GUID; the desktop assist resolves it exactly
// (the GUID ledger, 463) instead of 424's unique-title match.
import { describe, it, expect } from 'vitest';
import { parseEvernoteNoteLink } from '../src/leaves/note-link-schemes.js';

const G = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';

describe('parseEvernoteNoteLink', () => {
  it.each([
    [`evernote:///view/12345/s1/${G}/${G}/`],
    [`evernote:///view/12345/s1/${G}/${G}`],
    [`EVERNOTE:///view/12345/s123/${G}/${G}/`],
    [`  evernote:///view/12345/s1/${G}/${G}/  `]
  ])('returns the note GUID of %s', (href) => {
    expect(parseEvernoteNoteLink(href)).toBe(G);
  });

  it('lower-cases the GUID, so one note is one key', () => {
    const upper = G.toUpperCase();
    expect(parseEvernoteNoteLink(`evernote:///view/1/s1/${upper}/${upper}/`)).toBe(G);
  });

  it.each([
    ['a web link', `https://www.evernote.com/shard/s1/nl/1/${G}/`],
    ['a prefix scheme', `evernotex:///view/1/s1/${G}/${G}/`],
    ['a non-view path', `evernote:///edit/1/s1/${G}/${G}/`],
    ['a malformed GUID', 'evernote:///view/1/s1/not-a-guid/not-a-guid/'],
    ['two different GUIDs', `evernote:///view/1/s1/${G}/11111111-2222-3333-4444-555555555555/`],
    ['not a string', 42],
    ['empty', '']
  ])('returns null for %s', (_, href) => {
    expect(parseEvernoteNoteLink(href)).toBeNull();
  });
});
