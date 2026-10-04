// node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature" on first use. For someone moving
// their notes that line reads like something went wrong, so the CLI drops exactly that warning and no other.
// Built-in modules are linked before any module body runs, so whatever imports node:sqlite must be loaded with
// a dynamic import() after this file (see bin/kosko-assist.mjs).
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/.test(String(warning?.message ?? warning))) return;
  return emit.call(this, warning, ...rest);
};
