#!/usr/bin/env node
// kosko-assist — moves a whole Evernote account into Kosko. The commands are in src/cli.mjs.
import '../src/quiet-sqlite-warning.mjs';
// Loaded dynamically, AFTER the warning filter: a static import would link node:sqlite (and print its experimental
// notice) before any module body here runs.
const { main } = await import('../src/cli.mjs');
await main(process.argv.slice(2));
