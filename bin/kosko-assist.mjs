#!/usr/bin/env node
// kosko-assist — moves a whole Evernote account into Kosko. Wave 1 ships only the measurement commands.
import '../src/quiet-sqlite-warning.mjs';
import { parseArgs } from 'node:util';
// Loaded dynamically, AFTER the warning filter: a static import would link node:sqlite (and print its experimental
// notice) before any module body here runs.
const { runProbe } = await import('../src/mcp/probe.mjs');
const { findDataDirs, listAccounts } = await import('../src/reader/locate.mjs');
const { runDryRun, pickAccount } = await import('../src/plan/dry-run.mjs');
const { openAccount } = await import('../src/reader/reader.mjs');
const { enexFiles, matchExports, renderMatch } = await import('../src/match/match.mjs');

const USAGE = `Usage:
  kosko-assist accounts [--data-dir <Evernote data folder>]
  kosko-assist dry-run --out <folder> [--data-dir <Evernote data folder>] [--account <user id>]
  kosko-assist match <export.enex | folder>... [--out <folder>] [--data-dir <Evernote data folder>] [--account <user id>]
  kosko-assist probe-mcp --out <dir> [--port 8765] [--max-notes N] [--max-minutes 60] [--plan-wait-minutes 30]

probe-mcp signs you in to Evernote (read only), lists the MCP server's tools into <dir>/tools.json, waits for
<dir>/plan.json, then measures how fast notes can be fetched. The report holds no note titles or bodies.

accounts lists the Evernote accounts on this computer (user id, database size, last written). It reads file
names and sizes only.

dry-run reads one account (the largest, or --account) from a private copy of Evernote's database and writes the
whole import plan to <folder>/kosko-plan.json, plus a one-screen summary. It checks every number against a direct
count of the database and stops with exit code 1 on any difference. Nothing is sent anywhere.

match reads Evernote exports (.enex) and finds, for each note, the local note with the same fp1 key (its creation
time). It prints how many matched exactly one, and names by title every note that did not. With --out it also
writes <folder>/kosko-match-report.json (counts and titles only). Exit code 0 when at least 99% matched.`;

const [command, ...rest] = process.argv.slice(2);
if (command === 'accounts') {
  const { values } = parseArgs({ args: rest, options: { 'data-dir': { type: 'string' } } });
  const dirs = findDataDirs({ dataDir: values['data-dir'] });
  if (!dirs.length) { console.error('No Evernote data folder found. Pass --data-dir <folder>.'); process.exit(1); }
  for (const dir of dirs) {
    console.log(dir);
    const accounts = listAccounts(dir);
    if (!accounts.length) console.log('  no Evernote accounts here (expected conduit-storage/<host>/UDB-User<id>+RemoteGraph.sql)');
    for (const a of accounts) {
      console.log(`  User${a.userId}  ${(a.dbBytes / 1e6).toFixed(1)} MB  last written ${a.modifiedAt.toISOString()}`
        + `  resource-cache: ${a.resourceCacheExists ? 'yes' : 'no'}  (${a.host})`);
    }
  }
  process.exit(0);
}
if (command === 'dry-run') {
  const { values } = parseArgs({ args: rest, options: { out: { type: 'string' }, 'data-dir': { type: 'string' }, account: { type: 'string' } } });
  if (!values.out) { console.error(USAGE); process.exit(2); }
  const [dataDir] = findDataDirs({ dataDir: values['data-dir'] });
  if (!dataDir) { console.error('No Evernote data folder found. Pass --data-dir <folder>.'); process.exit(1); }
  try {
    const r = await runDryRun({ dataDir, outDir: values.out, accountId: values.account });
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`dry-run: ${e.message}`);
    process.exit(1);
  }
}
if (command === 'match') {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true,
    options: { out: { type: 'string' }, 'data-dir': { type: 'string' }, account: { type: 'string' } } });
  if (!positionals.length) { console.error(USAGE); process.exit(2); }
  const [dataDir] = findDataDirs({ dataDir: values['data-dir'] });
  if (!dataDir) { console.error('No Evernote data folder found. Pass --data-dir <folder>.'); process.exit(1); }
  // Every path ends at ONE exit, after close(): process.exit() inside try would skip a finally, and close() is what
  // deletes the private copy of Evernote's database.
  let acct;
  let code = 1;
  try {
    const files = enexFiles(positionals);
    if (!files.length) throw new Error('no .enex files in the paths given');
    acct = await openAccount(pickAccount(dataDir, values.account).account);
    const report = await matchExports(acct, files);
    console.log(renderMatch(report));
    if (values.out) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(values.out, { recursive: true });
      writeFileSync(join(values.out, 'kosko-match-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    code = report.pass ? 0 : 1;
  } catch (e) {
    console.error(`match: ${e.message}`);
  } finally {
    acct?.close();
  }
  process.exit(code);
}
if (command !== 'probe-mcp') { console.error(USAGE); process.exit(command ? 2 : 0); }
const { values } = parseArgs({
  args: rest,
  options: {
    out: { type: 'string' }, port: { type: 'string', default: '8765' },
    'max-notes': { type: 'string' }, 'max-minutes': { type: 'string', default: '60' },
    'plan-wait-minutes': { type: 'string', default: '30' }
  }
});
if (!values.out) { console.error(USAGE); process.exit(2); }
try {
  await runProbe({
    outDir: values.out,
    port: Number(values.port),
    maxNotes: values['max-notes'] ? Number(values['max-notes']) : Infinity,
    maxMinutes: Number(values['max-minutes']),
    planWaitMinutes: Number(values['plan-wait-minutes'])
  });
  process.exit(0);
} catch (e) {
  console.error(`probe-mcp: ${e.message}`);
  process.exit(1);
}
