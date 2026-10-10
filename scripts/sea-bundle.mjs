// Kosko 538 rules 1–3: the CLI as ONE CommonJS file, which is what Node's single executable embeds.
//
// esbuild resolves every dependency into the file. Two places in jsdom 29 reach for a file next to their own source,
// and inside an executable there is no such file, so they are rewritten here and nowhere else:
//   - css/helpers/computed-style.js reads browser/default-stylesheet.css: its text is inlined;
//   - xhr/XMLHttpRequest-impl.js resolves xhr-sync-worker.js: it gets a name that fails only if synchronous XHR is
//     used, which the ENML converter never does.
// css-tree's ES build (which jsdom's selector engine imports) loads its JSON data through createRequire(import.meta.url),
// and import.meta is empty in CommonJS, so every css-tree import is resolved to the package's own CommonJS build instead,
// whose plain require() of JSON esbuild inlines. Any OTHER module that uses import.meta fails the build
// (`empty-import-meta` is an error here), so a new one cannot ship broken.
// If jsdom's source stops matching either expression exactly, the build throws naming the file (rule 3): a bundle that
// breaks at run time on the user's computer is worse than a build that stops here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ENTRY = join(ROOT, 'src/sea/entry.mjs');
const JSDOM_LIB = dirname(createRequire(join(ROOT, 'package.json')).resolve('jsdom'));

const STYLESHEET_READ = 'fs.readFileSync(\n  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),\n  { encoding: "utf-8" }\n)';
const SYNC_WORKER = 'require.resolve("./xhr-sync-worker.js")';
export const NO_SYNC_WORKER = 'kosko-assist: jsdom synchronous XHR is not bundled';

/** The two rewrites, keyed by the path under jsdom/lib. Each replaces exactly one occurrence or throws. */
export const JSDOM_REWRITES = {
  'jsdom/living/css/helpers/computed-style.js': {
    find: STYLESHEET_READ,
    replace: () => JSON.stringify(readFileSync(join(JSDOM_LIB, 'jsdom/browser/default-stylesheet.css'), 'utf8'))
  },
  'jsdom/living/xhr/XMLHttpRequest-impl.js': { find: SYNC_WORKER, replace: () => JSON.stringify(NO_SYNC_WORKER) }
};

/** rewrite(relPath, source) -> source with its one expression replaced. Throws if it is not there exactly once. */
export function rewriteJsdom(relPath, source) {
  const r = JSDOM_REWRITES[relPath];
  if (!r) return source;
  const at = source.indexOf(r.find);
  if (at < 0 || source.indexOf(r.find, at + 1) >= 0) {
    throw new Error(`jsdom changed: ${relPath} no longer contains ${JSON.stringify(r.find)} exactly once. `
      + 'Re-check what it reads from disk before bundling it (Kosko 538 rule 3).');
  }
  return source.slice(0, at) + r.replace() + source.slice(at + r.find.length);
}

const jsdomFiles = {
  name: 'jsdom-files',
  setup(b) {
    const seen = new Set();
    b.onLoad({ filter: /[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/](css[\\/]helpers[\\/]computed-style|xhr[\\/]XMLHttpRequest-impl)\.js$/ }, (args) => {
      const rel = args.path.slice(JSDOM_LIB.length + 1).split('\\').join('/');
      seen.add(rel);
      return { contents: rewriteJsdom(rel, readFileSync(args.path, 'utf8')), loader: 'js' };
    });
    // Both files must have been bundled, or one of the rewrites silently stopped applying (a moved file).
    b.onEnd((result) => {
      if (result.errors.length) return;
      const missing = Object.keys(JSDOM_REWRITES).filter((k) => !seen.has(k));
      if (missing.length) throw new Error(`jsdom changed: ${missing.join(', ')} was not bundled (Kosko 538 rule 3).`);
    });
  }
};

const cssTreeCjs = {
  name: 'css-tree-cjs',
  setup(b) {
    b.onResolve({ filter: /^css-tree(\/|$)/ }, (args) => (args.kind === 'require-call' ? undefined
      : b.resolve(args.path, { kind: 'require-call', resolveDir: args.resolveDir, importer: args.importer })));
  }
};

/**
 * Bundles the CLI into `outfile`. Returns esbuild's metafile, which names every input and every import left
 * unresolved (`external: true`).
 */
export async function bundle({ outfile, entry = ENTRY, minify = true } = {}) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.16',
    minify,
    keepNames: true, // jsdom and Tiptap read constructor and function names
    legalComments: 'eof', // the licence headers of what is bundled stay in the file
    metafile: true,
    logLevel: 'silent',
    logOverride: { 'empty-import-meta': 'error' },
    plugins: [jsdomFiles, cssTreeCjs]
  });
  if (result.warnings.length) {
    throw new Error(`esbuild warned:\n${result.warnings.map((w) => `${w.text} (${w.location?.file ?? ''})`).join('\n')}`);
  }
  return result.metafile;
}
