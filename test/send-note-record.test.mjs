// 467 rules 6-7: a note's identity is /import's (fp1), its body is its plain text as paragraphs with its attachments
// after, and every body fits enex-core's note schema (proved here, owner decision 2026-10-06: Tiptap is dev-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteSchema } from '@kosko-app/enex-core';
import { formatEnexDate, fingerprintNote } from '@kosko-app/enex-core/enex';
import { plainTextDoc, mediaNode, fingerprintsFor, versionOf, buildRecord, isoFromMs } from '../src/send/library/note-record.mjs';

const T0 = Date.UTC(2014, 2, 4, 10, 30, 15);
const fits = (doc) => noteSchema().nodeFromJSON(doc).check();

test('plain text lines become paragraphs; an empty line is an empty paragraph; nothing is a paragraph of nothing', () => {
  assert.deepEqual(plainTextDoc('one\n\ntwo\r\nthree'), { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'one' }] }, { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'three' }] }] });
  assert.deepEqual(plainTextDoc(''), { type: 'doc', content: [{ type: 'paragraph' }] });
  assert.deepEqual(plainTextDoc(null), { type: 'doc', content: [{ type: 'paragraph' }] });
});

test('attachments become media nodes: images noteImage, others noteAttachment, a missing one marked', () => {
  assert.deepEqual(mediaNode({ mime: 'image/png', filename: 'a.png', md5: 'a'.repeat(32) }, { path: 'notes/x/images/a.png' }),
    { type: 'noteImage', attrs: { src: null, path: 'notes/x/images/a.png', alt: null } });
  assert.deepEqual(mediaNode({ mime: 'application/pdf', filename: 'b.pdf', md5: 'b'.repeat(32) }, { missing: 'missing_from_cache' }),
    { type: 'noteAttachment', attrs: { src: null, path: `enex-resource:${'b'.repeat(32)}`, mediaType: 'file', mimeType: 'application/pdf', filename: 'b.pdf', missing: 'missing_from_cache' } });
  assert.equal(mediaNode({ mime: 'audio/mpeg', md5: 'c'.repeat(32) }, { path: 'p' }).attrs.mediaType, 'audio');
  assert.equal(mediaNode({ mime: 'video/mp4', md5: 'c'.repeat(32) }, { path: 'p' }).attrs.mediaType, 'video');
});

test('every body this module builds fits enex-core\'s note schema, edge cases included', () => {
  const texts = ['', 'plain', 'తెలుగు వచనం 👋🏽', 'tab\there', 'a\u0000b', 'lone \ud800 surrogate', '\n\n\n', 'x'.repeat(100_000)];
  const atts = [
    mediaNode({ mime: 'image/png', md5: 'a'.repeat(32) }, { path: 'notes/n/images/a.png' }),
    mediaNode({ mime: 'application/pdf', filename: 'b.pdf', md5: 'b'.repeat(32) }, { missing: 'missing_from_cache' }),
    mediaNode({ mime: 'image/jpeg', md5: 'c'.repeat(32) }, { missing: 'unreadable' }),
    mediaNode({ mime: 'audio/mpeg', md5: 'd'.repeat(32) }, { path: 'notes/n/attachments/d.mp3' })
  ];
  for (const t of texts) {
    const doc = plainTextDoc(t);
    doc.content.push(...atts);
    assert.doesNotThrow(() => fits(doc), JSON.stringify(t).slice(0, 40));
  }
});

test('control characters Postgres refuses never reach the body', () => {
  const text = JSON.stringify(plainTextDoc('a\u0000b \ud800'));
  assert.ok(!text.includes('\\u0000') && !text.includes('\\ud800'));
});

test('fp1 is /import\'s and match\'s: formatEnexDate + fingerprintNote, same-second notes told apart', async () => {
  const notes = [{ created: T0 }, { created: T0 }, { created: T0 + 1000 }];
  const fps = await fingerprintsFor(notes);
  assert.equal(fps.length, 3);
  assert.ok(fps.every((f) => /^fp1:[0-9a-f]{64}$/.test(f)));
  assert.equal(new Set(fps).size, 3, 'two notes in one second get distinct keys');
  const { identity } = await fingerprintNote({ created: formatEnexDate(T0 + 1000) });
  assert.equal(fps[2], `fp1:${identity}`, 'a lone note\'s fp1 is the identity match.mjs computes');
});

test('the version changes with the text, the title, the tags or the attachments, and not with tag order', async () => {
  const base = { created: T0, title: 'T', plainText: 'x' };
  const v = await versionOf(base, ['a', 'b'], ['m1']);
  assert.match(v, /^[0-9a-f]{64}$/);
  assert.equal(await versionOf(base, ['b', 'a'], ['m1']), v);
  for (const other of [await versionOf({ ...base, plainText: 'y' }, ['a', 'b'], ['m1']), await versionOf({ ...base, title: 'U' }, ['a', 'b'], ['m1']),
    await versionOf(base, ['a'], ['m1']), await versionOf(base, ['a', 'b'], ['m2'])]) assert.notEqual(other, v);
});

test('a record is exactly what notes/batch takes: GUID as external_id, ISO dates, a bad GUID sent as none', () => {
  const doc = plainTextDoc('x');
  const r = buildRecord({ note: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', title: 'Hello', created: T0, updated: T0 + 1000 }, id: '11111111-2222-4333-8444-555555555555',
    jobId: '99999999-2222-4333-8444-555555555555', fingerprint: `fp1:${'a'.repeat(64)}`, version: 'b'.repeat(64), parentId: '77777777-2222-4333-8444-555555555555', tags: ['t'], doc });
  assert.deepEqual(r, { id: '11111111-2222-4333-8444-555555555555', job_id: '99999999-2222-4333-8444-555555555555', fingerprint: `fp1:${'a'.repeat(64)}`,
    version_hash: 'b'.repeat(64), external_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', title: 'Hello', created_at: '2014-03-04T10:30:15.000Z',
    updated_at: '2014-03-04T10:30:16.000Z', parent_id: '77777777-2222-4333-8444-555555555555', tags: ['t'], content: doc });
  assert.equal(buildRecord({ note: { id: '../../escape', title: '', created: T0, updated: T0 }, id: 'x', jobId: 'y', fingerprint: 'f', version: 'v', parentId: null, tags: [], doc }).external_id, null);
  assert.equal(buildRecord({ note: { id: 'g', title: '', created: T0, updated: T0 }, id: 'x', jobId: 'y', fingerprint: 'f', version: 'v', parentId: null, tags: [], doc }).title, null);
  assert.equal(isoFromMs('not a number'), null);
});
