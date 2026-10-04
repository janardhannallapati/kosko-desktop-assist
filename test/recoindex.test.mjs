import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecoIndex, RecoIndexError } from '../src/reader/recoindex.mjs';
import { RECO_XML, RECO_WORDS } from './fixtures/synthetic-db.mjs';

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

test('the real recoIndex shape parses to words in document order', () => {
  const out = parseRecoIndex(hex(RECO_XML));
  assert.equal(out.text, RECO_WORDS);
  assert.equal(out.wordCount, 3);
});

test('highest w wins, first on a tie', () => {
  const xml = '<recoIndex><item><t w="10">low</t><t w="70">high</t><t w="70">tie</t></item><item><t w="5">a</t><t w="5">b</t></item></recoIndex>';
  assert.equal(parseRecoIndex(hex(xml)).text, 'high a');
});

test('entities decoded', () => {
  const xml = '<recoIndex><item><t w="1">&lt;&gt;&amp;&quot;&apos;&#65;&#x42;</t></item></recoIndex>';
  assert.equal(parseRecoIndex(hex(xml)).text, `<>&"'AB`);
});

test('DOCTYPE not expanded: an entity declared in the DTD stays literal', () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE recoIndex [<!ENTITY boom "EXPANDED">]><recoIndex><item><t w="1">&boom;</t></item></recoIndex>';
  const out = parseRecoIndex(hex(xml));
  assert.equal(out.text, '&boom;');
  assert.ok(!out.text.includes('EXPANDED'));
});

test('bad hex → RecoIndexError', () => {
  assert.throws(() => parseRecoIndex('zz-not-hex'), { name: 'Error', message: 'OCR record is not valid hex' });
  assert.throws(() => parseRecoIndex('abc'), /not valid hex/); // odd length
  // Buffer.from(…, 'hex') silently stops at the first bad character; a valid record plus junk must still refuse.
  assert.throws(() => parseRecoIndex(`${hex(RECO_XML)}zz`), /not valid hex/);
  assert.throws(() => parseRecoIndex('zz-not-hex'), RecoIndexError);
});

test('hex of something that is not a recoIndex → RecoIndexError', () => {
  assert.throws(() => parseRecoIndex(hex('<html><body>hi</body></html>')), RecoIndexError);
});

test('an item with no <t> and an empty recoIndex give no words', () => {
  assert.deepEqual(parseRecoIndex(hex('<recoIndex><item><object w="9"/></item></recoIndex>')), { text: '', wordCount: 0 });
  assert.deepEqual(parseRecoIndex(hex('<recoIndex/>')), { text: '', wordCount: 0 });
});

test('a <t> with single-quoted or missing w still counts (missing w ranks lowest)', () => {
  const xml = "<recoIndex><item><t>none</t><t w='3'>three</t></item><item><t>only</t></item></recoIndex>";
  assert.equal(parseRecoIndex(hex(xml)).text, 'three only');
});

test('a truncated or hostile record costs linear time (80k unclosed items, 80k unclosed <t>)', () => {
  const t0 = Date.now();
  assert.deepEqual(parseRecoIndex(hex(`<recoIndex>${'<item x="1">'.repeat(80_000)}`)), { text: '', wordCount: 0 });
  parseRecoIndex(hex(`<recoIndex><item>${'<t w="1">'.repeat(80_000)}</item></recoIndex>`));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('CDATA is copied verbatim, entities outside it decoded once', () => {
  const xml = '<recoIndex><item><t w="1">x&amp;<![CDATA[a &amp;lt; b]]>y</t></item></recoIndex>';
  assert.equal(parseRecoIndex(hex(xml)).text, 'x&a &amp;lt; by');
});

test('NUL and lone-surrogate references stay literal', () => {
  const xml = '<recoIndex><item><t w="1">a&#0;b&#xD800;c</t></item></recoIndex>';
  assert.equal(parseRecoIndex(hex(xml)).text, 'a&#0;b&#xD800;c');
});

test('an element whose name only starts with item or t is not mistaken for one', () => {
  const xml = '<recoIndex><items><item><tx w="99">no</tx><t w="1">yes</t></item></items></recoIndex>';
  assert.equal(parseRecoIndex(hex(xml)).text, 'yes');
});
