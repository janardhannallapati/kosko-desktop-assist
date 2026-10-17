// kosko-assist's commands. bin/kosko-assist.mjs (npx, a clone) and src/sea/entry.mjs (the single executable, Kosko 538)
// both call main() after the node:sqlite warning filter is installed.
import { parseArgs } from 'node:util';
import { TOOL_VERSION } from './version.mjs';

const USAGE = `Usage:
  kosko-assist --version | --help
  kosko-assist accounts [--data-dir <Evernote data folder>]
  kosko-assist dry-run --out <folder> [--data-dir <Evernote data folder>] [--account <user id>]
  kosko-assist match <export.enex | folder>... [--out <folder>] [--data-dir <Evernote data folder>] [--account <user id>]
  kosko-assist probe-mcp --out <dir> [--port 8765] [--max-notes N] [--max-minutes 60] [--plan-wait-minutes 30]
  kosko-assist connect [--app <Kosko address>]
  kosko-assist send --plan <dry-run folder> [--app <Kosko address>] [--data-dir <Evernote data folder>] [--account <user id>]
                    [--evernote [--port 8765]]
  kosko-assist shapes --plan <dry-run folder> --out <folder> [--notes 5] [--port 8765] [--data-dir <Evernote data folder>]
  kosko-assist convert-enml < note.enml

probe-mcp signs you in to Evernote (read only), lists the MCP server's tools into <dir>/tools.json, waits for
<dir>/plan.json, then measures how fast notes can be fetched. The report holds no note titles or bodies.

accounts lists the Evernote accounts on this computer (user id, database size, last written). It reads file
names and sizes only.

dry-run reads one account (the largest, or --account) from a private copy of Evernote's database and writes the
whole import plan to <folder>/kosko-plan.json, plus a one-screen summary. It checks every number against a direct
count of the database and stops with exit code 1 on any difference. Nothing is sent anywhere.

match reads Evernote exports (.enex) and finds, for each note, the local note with the same fp1 key (its creation
time). It prints how many matched exactly one, and names by title every note that did not. With --out it also
writes <folder>/kosko-match-report.json (counts and titles only). Exit code 0 when at least 99% matched.

connect checks an import token against Kosko (https://kosko.app, or --app http://127.0.0.1:<port> for a local one)
and prints the storage used and left. It sends nothing else. Paste the token when asked, or set KOSKO_IMPORT_TOKEN;
there is deliberately no --token option, because a flag is saved in your shell history.

send moves the account the plan describes into Kosko: notebooks under their stacks, every tag, every note with its plain
text, dates and Evernote id, and the attachments on this computer. It first counts Evernote again and stops if anything
changed since the dry run. Ctrl-C stops it cleanly; running it again continues, and never creates anything twice.

send --evernote also signs you in to Evernote (read only, in your browser) and fetches each note's formatted body from
Evernote's MCP server, so tables, checklists and pictures arrive where you put them. Notes already in Kosko as plain text
are upgraded in place; a note you edited in Kosko since is left as you had it. Evernote offers this on paid plans only:
on a free plan the tool says so and sends plain text.

shapes checks, before a big send --evernote, that Evernote's MCP server still answers the way this tool was tested
against. It signs you in to Evernote (read only), lists every note and compares the list with the plan, fetches a few
notes and attachments, renews the sign-in once, and writes <folder>/kosko-shapes.json: structure, counts and note ids,
never a title, a note's text or a file name. Each check is green or red; exit code 0 when all are green. It sends
nothing to Kosko.

convert-enml reads one note's ENML on standard input and prints the document Kosko would store for it. It sends
nothing; it is there to check a build on the computer it will run on.`;

// A mistyped option: the message and the usage, exit 2, never a stack trace (the executable's users are not developers).
function parseOr2(args, config) {
  try {
    return parseArgs({ args, ...config });
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

/** Runs one command. Every path ends in process.exit(). */
export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') { console.log(TOOL_VERSION); process.exit(0); }
  if (command === '--help' || command === '-h' || command === 'help') { console.log(USAGE); process.exit(0); }
  if (command === 'convert-enml') process.exit(await convertEnmlCommand(rest));
  // Loaded dynamically, AFTER the warning filter: a static import would link node:sqlite (and print its experimental
  // notice) before any module body here runs.
  const { runProbe } = await import('./mcp/probe.mjs');
  const { findDataDirs, listAccounts } = await import('./reader/locate.mjs');
  const { runDryRun, pickAccount } = await import('./plan/dry-run.mjs');
  const { openAccount } = await import('./reader/reader.mjs');
  const { enexFiles, matchExports, renderMatch } = await import('./match/match.mjs');
  const { runConnect } = await import('./send/connect.mjs');
  const { runSendCommand } = await import('./send/send-command.mjs');
  const { redact } = await import('./send/token.mjs');
  // 466 rule 1: a token on the command line lands in shell history and process listings. Refused before anything runs.
  // 466 review M8: a token anywhere on the line (a bare word, after a mistyped flag) is refused the same way, unechoed.
  if (rest.some((a) => a === '--token' || a.startsWith('--token=') || /cvit_/i.test(a))) {
    console.error('There is no --token option: paste the import token when asked, or set KOSKO_IMPORT_TOKEN.');
    process.exit(2);
  }
  if (command === 'send') {
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: { plan: { type: 'string' }, app: { type: 'string' }, 'data-dir': { type: 'string' }, account: { type: 'string' },
        evernote: { type: 'boolean' }, port: { type: 'string' } } }));
    } catch (e) {
      console.error(`${redact(e.message)}\n\n${USAGE}`);
      process.exit(2);
    }
    process.exit(await runSendCommand({ plan: values.plan, app: values.app, dataDir: values['data-dir'], account: values.account,
      evernote: values.evernote === true, port: values.port }));
  }
  if (command === 'shapes') process.exit(await shapesCommand(rest));
  if (command === 'connect') {
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: { app: { type: 'string' } } }));
    } catch (e) {
      console.error(`${redact(e.message)}\n\n${USAGE}`);
      process.exit(2);
    }
    process.exit(await runConnect({ app: values.app }));
  }
  if (command === 'accounts') {
    const { values } = parseOr2(rest, { options: { 'data-dir': { type: 'string' } } });
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
    const { values } = parseOr2(rest, { options: { out: { type: 'string' }, 'data-dir': { type: 'string' }, account: { type: 'string' } } });
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
    const { values, positionals } = parseOr2(rest, { allowPositionals: true,
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
  const { values } = parseOr2(rest, {
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
}

// Kosko 537: usage is checked before anything signs in (exit 2); Ctrl-C stops the check and leaves no file.
async function shapesCommand(rest) {
  const { values } = parseOr2(rest, { options: { plan: { type: 'string' }, out: { type: 'string' }, notes: { type: 'string' },
    port: { type: 'string' }, 'data-dir': { type: 'string' } } });
  if (!values.plan || !values.out) { console.error(`shapes needs --plan <the dry run's folder> and --out <folder>.\n\n${USAGE}`); return 2; }
  const { DEFAULT_NOTES, MAX_NOTES, runShapes } = await import('./mcp/shapes.mjs');
  const notes = values.notes === undefined ? DEFAULT_NOTES : Number(values.notes);
  if (!Number.isInteger(notes) || notes < 1 || notes > MAX_NOTES) { console.error(`--notes must be a whole number from 1 to ${MAX_NOTES}.`); return 2; }
  const port = values.port === undefined ? 8765 : Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('--port must be a number from 1024 to 65535.'); return 2; }
  const { statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { findDataDirs } = await import('./reader/locate.mjs');
  const planPath = statSync(values.plan, { throwIfNoEntry: false })?.isDirectory() ? join(values.plan, 'kosko-plan.json') : values.plan;
  const ac = new AbortController();
  const onSigint = () => { ac.abort(); console.error('\nStopping after the current request…'); };
  process.once('SIGINT', onSigint);
  try {
    return await runShapes({ planPath, outDir: values.out, notes, dataDirs: findDataDirs({ dataDir: values['data-dir'] }),
      evernote: { port }, signal: ac.signal });
  } finally { process.removeListener('SIGINT', onSigint); }
}

// 538 rule 5: stdin -> the converted document as JSON on stdout. Exit 0 when it converted, 1 when the converter refused,
// 2 on no input. The same createConverter the --evernote route uses.
async function convertEnmlCommand(rest) {
  if (rest.length || process.stdin.isTTY) { console.error(`convert-enml reads the ENML from a file or a pipe.\n\n${USAGE}`); return 2; }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const enml = Buffer.concat(chunks).toString('utf8');
  if (!enml.trim()) { console.error('convert-enml: no ENML on standard input.'); return 2; }
  const { createConverter } = await import('./send/library/formatted-body.mjs');
  const result = (await createConverter())(enml);
  // Wait for the write to finish: process.exit() right after a large write to a pipe can cut it short (macOS, Windows).
  await new Promise((done) => process.stdout.write(`${JSON.stringify(result)}\n`, done));
  return result.ok ? 0 : 1;
}
