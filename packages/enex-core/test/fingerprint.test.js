// 254 — which Kosko note an exported note already is, with no identifier in the export (0 <guid> in 86
// real notes). Identity must survive an edit in Evernote; version must change with one. Measured on the
// owner's corpus: <created> is unique across all 86 notes while 8 notes share a title — so a title is not
// identity. And the version hashes SOURCE fields, never converted JSON (252: 2 of 86 notes convert
// differently in jsdom and Chromium).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fingerprintNote, assignFingerprints, FINGERPRINT_SCHEME } from '../src/fingerprint.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const note = (over = {}) => ({
  title: 'Groceries', created: '20200101T101010Z', updated: '20210101T000000Z', content: '<en-note>milk</en-note>',
  tags: ['home', 'weekly'], resources: [{ md5: 'aa'.repeat(16), bytes: 3, problem: null }, { md5: 'bb'.repeat(16), bytes: 4, problem: null }],
  ...over
});

describe('fingerprintNote', () => {
  it('identity is sha256 over the scheme and <created> — an independent computation agrees', async () => {
    const { identity, version } = await fingerprintNote(note());
    expect(FINGERPRINT_SCHEME).toBe('fp1');
    expect(identity).toBe(sha('fp1\ncreated:20200101T101010Z'));
    expect(version).toBe(sha(JSON.stringify(['v2', 'Groceries', '<en-note>milk</en-note>', ['home', 'weekly'], ['aa'.repeat(16), 'bb'.repeat(16)]])));
  });

  // Kosko 510: v2 hashes canonical ENML, so the same note from Evernote's MCP server and from an ENEX export has one
  // version (461 R5), and a crossing between routes is never read as an edit.
  it('version is the same for an ENEX body and its MCP twin (canonical ENML, v2)', async () => {
    const enex = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">\n'
      + '<en-note>milk<div style="display:none;--en-chs:e30=">\u200A</div></en-note>\n';
    expect((await fingerprintNote(note({ content: enex }))).version).toBe((await fingerprintNote(note())).version);
  });

  it('identity ignores everything an Evernote edit changes', async () => {
    const base = await fingerprintNote(note());
    const edited = await fingerprintNote(note({ title: 'Groceries (edited)', content: '<en-note>eggs</en-note>', tags: [], resources: [], updated: '20260101T000000Z' }));
    expect(edited.identity).toBe(base.identity);
  });

  it.each([
    ['title', { title: 'Other' }],
    ['content', { content: '<en-note>milk!</en-note>' }],
    ['a tag', { tags: ['home'] }],
    ['a resource', { resources: [{ md5: 'aa'.repeat(16), bytes: 3, problem: null }] }]
  ])('version changes when %s changes', async (_, change) => {
    expect((await fingerprintNote(note(change))).version).not.toBe((await fingerprintNote(note())).version);
  });

  it('version does NOT change with <updated> alone, tag order or resource order', async () => {
    const base = (await fingerprintNote(note())).version;
    expect((await fingerprintNote(note({ updated: '20990101T000000Z' }))).version).toBe(base);
    expect((await fingerprintNote(note({ tags: ['weekly', 'home'] }))).version).toBe(base);
    expect((await fingerprintNote(note({ resources: [...note().resources].reverse() }))).version).toBe(base);
  });

  it('fields are framed, so moving a character between fields changes the version', async () => {
    const a = await fingerprintNote(note({ tags: ['ab', 'c'] }));
    const b = await fingerprintNote(note({ tags: ['a', 'bc'] }));
    expect(a.version).not.toBe(b.version);
    const c = await fingerprintNote(note({ title: 'x', content: 'yz' }));
    const d = await fingerprintNote(note({ title: 'xy', content: 'z' }));
    expect(c.version).not.toBe(d.version);
  });

  it('a resource that could not be hashed still contributes its size and problem', async () => {
    const r = (bytes) => note({ resources: [{ md5: null, bytes, problem: 'too-large-to-read' }] });
    expect((await fingerprintNote(r(5))).version).not.toBe((await fingerprintNote(r(6))).version);
  });

  it('no valid <created> means no identity', async () => {
    expect((await fingerprintNote(note({ created: null }))).identity).toBe(null);
  });

  it('non-ASCII text is hashed as UTF-8', async () => {
    const { version } = await fingerprintNote(note({ title: 'తెలుగు 😀', tags: [], resources: [] }));
    expect(version).toBe(sha(JSON.stringify(['v2', 'తెలుగు 😀', '<en-note>milk</en-note>', [], []])));
  });
});

describe('assignFingerprints — collisions are reported, never merged', () => {
  const fp = (s) => `fp1:${s}`;

  it('a unique identity is the fingerprint', async () => {
    const a = await fingerprintNote(note());
    const b = await fingerprintNote(note({ created: '20200101T101011Z' }));
    const r = await assignFingerprints([a, b]);
    expect(r.fingerprints).toEqual([fp(a.identity), fp(b.identity)]);
    expect(r).toMatchObject({ collisions: [], identical: [], withoutCreated: [] });
  });

  it('two notes sharing <created> get distinct fingerprints derived from their versions, and are reported', async () => {
    const a = await fingerprintNote(note());
    const b = await fingerprintNote(note({ title: 'Other' }));
    const c = await fingerprintNote(note({ created: '20300101T000000Z' }));
    const r = await assignFingerprints([a, c, b]);
    expect(r.fingerprints).toEqual([fp(sha(`${a.identity}\n${a.version}`)), fp(c.identity), fp(sha(`${b.identity}\n${b.version}`))]);
    expect(new Set(r.fingerprints).size).toBe(3);
    expect(r.collisions).toEqual([[0, 2]]);
    expect(r.identical).toEqual([]);
  });

  it('identical notes (same identity AND version) are disambiguated by their order, and reported as identical', async () => {
    const a = await fingerprintNote(note());
    const r = await assignFingerprints([a, a, a]);
    expect(new Set(r.fingerprints).size).toBe(3);
    expect(r.fingerprints[1]).toBe(fp(sha(`${a.identity}\n${a.version}\n#1`)));
    expect(r.collisions).toEqual([[0, 1, 2]]);
    expect(r.identical).toEqual([[0, 1, 2]]);
  });

  it('the FIRST of identical notes keeps the fingerprint it has without its duplicate — deleting a duplicate in Evernote must not re-key the original', async () => {
    const a = await fingerprintNote(note());
    const b = await fingerprintNote(note({ title: 'Other' }));
    const withDuplicate = await assignFingerprints([a, a, b]);
    const afterDuplicateDeleted = await assignFingerprints([a, b]);
    expect(withDuplicate.fingerprints[0]).toBe(afterDuplicateDeleted.fingerprints[0]);
  });

  it('a note without <created> is keyed by its version, and listed', async () => {
    const a = await fingerprintNote(note({ created: null }));
    const b = await fingerprintNote(note({ created: null, title: 'B' }));
    const r = await assignFingerprints([a, b]);
    expect(r.fingerprints).toEqual([fp(sha(`nocreated\n${a.version}`)), fp(sha(`nocreated\n${b.version}`))]);
    expect(r.withoutCreated).toEqual([0, 1]);
    expect(r.collisions).toEqual([]);
  });

  it('two identical notes without <created> still get two fingerprints', async () => {
    const a = await fingerprintNote(note({ created: null }));
    const r = await assignFingerprints([a, a]);
    expect(new Set(r.fingerprints).size).toBe(2);
    expect(r.identical).toEqual([[0, 1]]);
  });

  it('every fingerprint matches the ledger\'s check constraint', async () => {
    const r = await assignFingerprints([await fingerprintNote(note()), await fingerprintNote(note({ created: null }))]);
    for (const f of r.fingerprints) expect(f).toMatch(/^fp1:[0-9a-f]{64}$/);
  });
});
