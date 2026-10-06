// 467 rule 8: every attachment is decided before anything is sent, and its bytes come only from the resource-cache
// path the reader validated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideAttachment, readCachedBytes } from '../src/send/library/attachments.mjs';

const MD5 = 'a'.repeat(32);
const att = (x = {}) => ({ id: 'att', noteId: '00000000-0000-4000-8000-000000000001', dataHash: MD5, mime: 'image/png', size: 5, filename: 'x.png', cacheStatus: 'present', ...x });
const MAX = 200 * 1024 * 1024;

test('present and storable: upload, images to images/, others to attachments/', () => {
  assert.deepEqual(decideAttachment(att(), { maxFileBytes: MAX }), { upload: true, type: 'image/png', folder: 'images' });
  assert.deepEqual(decideAttachment(att({ mime: 'application/pdf' }), { maxFileBytes: MAX }), { upload: true, type: 'application/pdf', folder: 'attachments' });
  assert.equal(decideAttachment(att({ mime: ' IMAGE/PNG ' }), { maxFileBytes: MAX }).type, 'image/png');
});

test('each refusal has its reason, its receipt count and whether it keeps a node', () => {
  const cases = [
    [att({ cacheStatus: 'missing' }), { missing: 'missing_from_cache', count: 'placeholder', node: true }],
    [att({ cacheStatus: 'size-mismatch' }), { missing: 'unreadable', count: 'unreadable', node: true }],
    [att({ cacheStatus: 'invalid-id' }), { missing: 'unreadable', count: 'unreadable', node: true }],
    [att({ dataHash: 'ZZ../x' }), { missing: 'unreadable', count: 'unreadable', node: false }],
    [att({ mime: 'application/octet-stream' }), { missing: 'type_not_stored', count: 'type_not_stored', node: true }],
    [att({ mime: '' }), { missing: 'type_not_stored', count: 'type_not_stored', node: true }],
    [att({ mime: 'application/x-msdownload' }), { missing: 'type_not_stored', count: 'type_not_stored', node: true }],
    [att({ size: MAX + 1 }), { missing: 'over_size_cap', count: 'over_cap', node: true }]
  ];
  for (const [a, want] of cases) assert.deepEqual(decideAttachment(a, { maxFileBytes: MAX }), { upload: false, ...want }, JSON.stringify(a));
});

test('a missing file wins over every other verdict (it is named on the receipt)', () => {
  assert.equal(decideAttachment(att({ cacheStatus: 'missing', mime: 'application/octet-stream' }), { maxFileBytes: MAX }).missing, 'missing_from_cache');
});

test('bytes are read from <cache>/<note GUID>/<md5> and nowhere else', () => {
  const cache = mkdtempSync(join(tmpdir(), 'kda-cache-'));
  mkdirSync(join(cache, att().noteId));
  writeFileSync(join(cache, att().noteId, MD5), Buffer.from([1, 2, 3, 4, 5]));
  assert.deepEqual([...readCachedBytes(cache, att())], [1, 2, 3, 4, 5]);
  assert.throws(() => readCachedBytes(cache, att({ noteId: '../../etc' })), /not a valid/);
  assert.throws(() => readCachedBytes(cache, att({ dataHash: '../passwd' })), /not a valid/);
});
