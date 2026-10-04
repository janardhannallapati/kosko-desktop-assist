#!/usr/bin/env node
// kosko-assist — moves a whole Evernote account into Kosko. Wave 1 ships only the measurement commands.
import { parseArgs } from 'node:util';
import { runProbe } from '../src/mcp/probe.mjs';

const USAGE = `Usage:
  kosko-assist probe-mcp --out <dir> [--port 8765] [--max-notes N] [--max-minutes 60] [--plan-wait-minutes 30]

probe-mcp signs you in to Evernote (read only), lists the MCP server's tools into <dir>/tools.json, waits for
<dir>/plan.json, then measures how fast notes can be fetched. The report holds no note titles or bodies.`;

const [command, ...rest] = process.argv.slice(2);
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
