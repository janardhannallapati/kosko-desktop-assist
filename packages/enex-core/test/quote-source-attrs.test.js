// Kosko 742 / 743: the nine source values as one set. Without a valid item there is no source at all, which
// is the invariant the schema, the Evernote converter and Kosko's exporters all read through this function.
import { describe, it, expect } from 'vitest';
import { QUOTE_SOURCE_ATTRS, quoteSourceAttrs } from '../src/index.js';

const ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d';

describe('quoteSourceAttrs: all nine through their rules, and nothing without an item', () => {
  const full = {
    sourceItem: ID, sourceTitle: 'How small teams plan', sourceUrl: 'https://example.com/teams',
    sourceExact: 'Small teams plan in pairs.', sourceCut: null, sourcePrefix: 'the end. ', sourceSuffix: ' Then',
    sourceStart: 1280, sourcePage: 3, sourceLength: 26
  };
  const NONE = Object.fromEntries(QUOTE_SOURCE_ATTRS.map((name) => [name, null]));

  it('a clean set comes back equal', () => {
    expect(quoteSourceAttrs(full)).toEqual(full);
  });

  it('always answers with exactly the ten names', () => {
    expect(Object.keys(quoteSourceAttrs({ ...full, onclick: 'x', style: 'y' }))).toEqual(QUOTE_SOURCE_ATTRS);
  });

  it.each([null, undefined, '', ID.toUpperCase(), 'x', 7, {}])('with the item %j, every other value is null', (item) => {
    expect(quoteSourceAttrs({ ...full, sourceItem: item })).toEqual(NONE);
  });

  it('each value is cleaned by its own rule', () => {
    const out = quoteSourceAttrs({
      ...full, sourceTitle: ' A \n title ', sourceUrl: 'javascript:alert(1)', sourceExact: 'a'.repeat(1500),
      sourceCut: null, sourcePrefix: 5, sourceStart: '5e1', sourcePage: 0, sourceLength: 1500
    });
    expect(out).toMatchObject({ sourceItem: ID, sourceTitle: 'A title', sourceUrl: null, sourceCut: true, sourcePrefix: null, sourceStart: null, sourcePage: null, sourceLength: 1500 });
    expect(quoteSourceAttrs({ ...full, sourceExact: 'a'.repeat(1500), sourceCut: true, sourceLength: '1.5e3' })).toMatchObject({ sourceCut: null, sourceLength: null });
    expect(out.sourceExact).toHaveLength(1000);
  });

  it('answers all null for anything that is not an object of attributes', () => {
    for (const bad of [null, undefined, 'x', 5, [], [full], () => full]) expect(quoteSourceAttrs(bad)).toEqual(NONE);
  });

  it('reads only the object\'s own values: a prototype cannot supply an item', () => {
    expect(quoteSourceAttrs(Object.create(full))).toEqual(NONE);
    expect(quoteSourceAttrs(JSON.parse(`{"__proto__":{"sourceItem":"${ID}"},"sourceTitle":"T"}`))).toEqual(NONE);
  });

  it('reads attributes held in an object with no prototype (as ProseMirror holds them)', () => {
    expect(quoteSourceAttrs(Object.assign(Object.create(null), full))).toEqual(full);
  });
});
