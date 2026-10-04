#!/usr/bin/env node
// kosko-assist — moves a whole Evernote account into Kosko. Wave 1 ships only the measurement commands.
import { parseArgs } from 'node:util';
import { runProbe } from '../src/mcp/probe.mjs';
import { findDataDirs, listAccounts } from '../src/reader/locate.mjs';

const USAGE = `Usage:
  kosko-assist accounts [--data-dir <Evernote data folder>]
  kosko-assist probe-mcp --out <dir> [--port 8765] [--max-notes N] [--max-minutes 60] [--plan-wait-minutes 30]

probe-mcp signs you in to Evernote (read only), lists the MCP server's tools into <dir>/tools.json, waits for
<dir>/plan.json, then measures how fast notes can be fetched. The report holds no note titles or bodies.

accounts lists the Evernote accounts on this computer (user id, database size, last written). It reads file
names and sizes only.`;

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
