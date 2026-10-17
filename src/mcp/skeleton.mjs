// Kosko 537 rule 5 — what `kosko-assist shapes` keeps of an MCP answer, and how two of them are compared.
//
// A skeleton is the structure of a value with every value removed: an object keeps its key names, an array keeps ONE
// item skeleton merged from all its items, and a primitive becomes its type. So it can be written down and diffed
// without holding a title, a body or a file name (rule 2). report.mjs's shape() keeps string lengths and ids for the
// 461 probe; a skeleton keeps neither, because two accounts' lengths always differ and are not a contract.
//
// Node: { types: sorted type names, keys?: { name: node } (sorted), items?: node }. Types: object, array, string,
// number, boolean, null, and `deep` past MAX_DEPTH (a hostile or runaway answer stops there).

export const MAX_DEPTH = 12;
const MAX_REPORTED = 200;

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** The skeleton of one value. */
// An object keyed by data, not by a fixed schema (tag or file names as keys), would write those names down (review A6):
// more than MAP_KEYS keys, or any key that is not identifier-like, collapses to one MAP_KEY entry merging all values.
export const MAP_KEYS = 40;
export const MAP_KEY = '<map>';
const IDENT = /^[A-Za-z_$][\w$-]{0,63}$/;

export function skeleton(v, depth = 0) {
  if (depth >= MAX_DEPTH) return { types: ['deep'] };
  const t = typeOf(v);
  if (t === 'object') {
    const entries = Object.entries(v);
    if (entries.length > MAP_KEYS || entries.some(([k]) => !IDENT.test(k))) {
      const values = entries.map(([, x]) => skeleton(x, depth + 1));
      return { types: ['object'], keys: values.length ? { [MAP_KEY]: values.reduce(merge) } : {} };
    }
    return { types: ['object'], keys: sortKeys(Object.fromEntries(entries.map(([k, x]) => [k, skeleton(x, depth + 1)]))) };
  }
  if (t === 'array') {
    const node = { types: ['array'] };
    for (const x of v) node.items = node.items ? merge(node.items, skeleton(x, depth + 1)) : skeleton(x, depth + 1);
    return node;
  }
  return { types: [t === 'bigint' ? 'number' : t] };
}

/** Two skeletons as one: the union of their types, keys merged key by key, items merged. */
export function merge(a, b) {
  const out = { types: [...new Set([...a.types, ...b.types])].sort() };
  if (a.keys || b.keys) {
    // A Map, not `keys[k] =`: a key named __proto__ would otherwise set the object's prototype (review A8).
    const keys = new Map(Object.entries(a.keys ?? {}));
    for (const [k, n] of Object.entries(b.keys ?? {})) keys.set(k, keys.has(k) ? merge(keys.get(k), n) : n);
    out.keys = sortKeys(Object.fromEntries(keys));
  }
  if (a.items || b.items) out.items = a.items && b.items ? merge(a.items, b.items) : (a.items ?? b.items);
  return out;
}

const nonNull = (n) => n.types.filter((t) => t !== 'null');
const label = (types) => types.join('|');

/**
 * Live against the baseline. A difference is something the run could trip on: a key the baseline has that live lacks,
 * or a non-null type with nothing in common. Noted is what breaks nothing: a new key, a type seen alongside the old
 * one, an array empty in this sample. null on either side is compatible with anything.
 */
export function diffSkeletons(base, live, path) {
  const differences = [];
  const noted = [];
  walk(base, live, path, differences, noted);
  return { differences: differences.slice(0, MAX_REPORTED), noted: noted.slice(0, MAX_REPORTED) };
}

function walk(base, live, path, differences, noted) {
  const b = nonNull(base);
  const l = nonNull(live);
  if (b.length && l.length) {
    if (!b.some((t) => l.includes(t))) { differences.push(`${path}: ${label(b)} → ${label(l)}`); return; }
    const added = l.filter((t) => !b.includes(t));
    if (added.length) noted.push(`${path}: also ${label(added)}`);
  }
  if (base.keys && live.keys) {
    for (const [k, n] of Object.entries(base.keys)) {
      if (!live.keys[k]) differences.push(`${path}.${k}: ${label(nonNull(n).length ? nonNull(n) : n.types)} → missing`);
      else walk(n, live.keys[k], `${path}.${k}`, differences, noted);
    }
    for (const [k, n] of Object.entries(live.keys)) if (!base.keys[k]) noted.push(`${path}.${k}: new (${label(n.types)})`);
  }
  if (base.items && live.types.includes('array')) {
    if (!live.items) noted.push(`${path}[]: empty in this sample, not compared`);
    else walk(base.items, live.items, `${path}[]`, differences, noted);
  }
}
