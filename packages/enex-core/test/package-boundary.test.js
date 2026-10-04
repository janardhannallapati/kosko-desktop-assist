// 458 rules 3, 4, 7 and 9: what this package may import, depend on and contain.
//
// The package is shared by Kosko and the desktop tool, so anything it reaches outside itself is something
// both of them silently depend on. These are negatives ("imports nothing else"), which no ordinary test can
// falsify, so they are scans over the published source.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { noteSchema } from '../src/schema/note-schema.js';

const ROOT = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
}
const SOURCES = walk(join(ROOT, 'src')).map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, 'utf8') }));
const specifiers = (text) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)]
  .map((m) => m[1] ?? m[2]);

describe('package boundary', () => {
  it('scans a real source tree', () => {
    expect(SOURCES.length).toBeGreaterThan(15);
  });

  it('imports only relative files with a .js extension, and declared peers', () => {
    const bad = [];
    for (const { file, text } of SOURCES) {
      for (const spec of specifiers(text)) {
        if (spec.startsWith('.')) {
          if (!spec.endsWith('.js')) bad.push(`${file}: ${spec} (Node ESM needs the extension)`);
          // A relative path can still climb out of the package (into Kosko's app/, say). It must land in src/.
          const target = relative(join(ROOT, 'src'), resolve(dirname(join(ROOT, file)), spec));
          if (target.startsWith('..')) bad.push(`${file}: ${spec} (outside the package)`);
          continue;
        }
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!(name in pkg.peerDependencies) && !(name in (pkg.dependencies ?? {})) && !spec.startsWith('node:')) bad.push(`${file}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('a relative import inside the package passes the same check (benign path)', () => {
    expect(specifiers("import { x } from './leaves/note-mime.js';")).toEqual(['./leaves/note-mime.js']);
  });

  it('has exactly two runtime dependencies, the ENEX reader\'s, each pinned exact (owner, 2026-10-04)', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['hash-wasm', 'sax']);
    for (const v of Object.values(pkg.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('./enex reaches no Tiptap module, so the desktop tool installs only sax and hash-wasm', () => {
    const entry = join(ROOT, pkg.exports['./enex']);
    const seen = new Set();
    const bare = [];
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
        else bare.push(spec);
      }
    };
    walk(entry);
    expect(seen.size).toBeGreaterThan(4); // it walked the reader, not just the index
    expect(bare.filter((s) => s.startsWith('@tiptap/'))).toEqual([]);
    expect([...new Set(bare)].sort()).toEqual(['hash-wasm', 'sax']);
  });

  it('marks every Tiptap peer optional (needed only through the root entry)', () => {
    for (const name of Object.keys(pkg.peerDependencies)) expect(pkg.peerDependenciesMeta?.[name]?.optional, name).toBe(true);
  });

  it('pins every Tiptap peer exact, to one version', () => {
    const versions = new Set(Object.values(pkg.peerDependencies));
    expect([...versions]).toEqual(['3.30.5']);
  });

  it('holds no origin, no Kosko address and no environment read', () => {
    const bad = SOURCES.filter(({ text }) =>
      /https?:\/\/(?!evil\.test)/.test(text.replace(/^\s*\/\/.*$/gm, '')) || /kosko\.app/i.test(text) || /process\.env|\.env\b/.test(text))
      .map(({ file }) => file);
    expect(bad).toEqual([]);
  });

  it('makes no network call of its own (what Kosko scanned per file before the move: 400)', () => {
    const NETWORK = /\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|node:(?:https?|net|dns)\b/;
    const bad = SOURCES.filter(({ text }) => NETWORK.test(text.replace(/^\s*\/\/.*$/gm, ''))).map(({ file }) => file);
    expect(bad).toEqual([]);
    expect(NETWORK.test("await fetch('x')")).toBe(true);
  });

  it('never reaches for a global DOM: window is always an argument', () => {
    // `window.document…` is fine: every converter function takes `window` as a parameter. What breaks the
    // tool (plain Node, no browser) is a BARE global — `document.x`, or `globalThis.window`/`.document`.
    const GLOBAL_DOM = /(?<![.\w])document\.|globalThis\.(?:window|document)\b/;
    const bad = SOURCES.filter(({ text }) => GLOBAL_DOM.test(text.replace(/^\s*\/\/.*$/gm, ''))).map(({ file }) => file);
    expect(bad).toEqual([]);
    expect(GLOBAL_DOM.test('const t = window.document.createElement("x");')).toBe(false);
    expect(GLOBAL_DOM.test('const t = document.createElement("x");')).toBe(true);
  });

  it('builds the schema in plain Node, with no DOM global present', () => {
    expect(typeof globalThis.document).toBe('undefined');
    const schema = noteSchema();
    expect(Object.keys(schema.nodes)).toEqual(expect.arrayContaining(['noteImage', 'noteAttachment', 'rawHtml', 'noteLocked', 'taskItem', 'table']));
  });
});
