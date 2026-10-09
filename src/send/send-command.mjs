// 467 — `kosko-assist send --plan <folder or kosko-plan.json> [--app <url>] [--data-dir <folder>] [--account <id>]`.
// Reads the import token (466), finds Evernote's folder as the dry run does, and runs the send. Ctrl-C stops it
// cleanly: the job is closed as cancelled and the checkpoint kept, so running the same command again continues.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { findDataDirs } from '../reader/locate.mjs';
import { appOrigin } from './api.mjs';
import { readToken, redact } from './token.mjs';
import { runSend } from './library/run-send.mjs';

export async function runSendCommand({ plan, app, dataDir, account, evernote = false, port, env = process.env, stdin = process.stdin, stderr = process.stderr }) {
  try {
    if (!plan) throw new Error('send needs --plan <the dry run\'s folder>.');
    const planPath = statSync(plan, { throwIfNoEntry: false })?.isDirectory() ? join(plan, 'kosko-plan.json') : plan;
    const origin = appOrigin(app);
    const [dir] = findDataDirs({ dataDir });
    if (!dir) throw new Error('No Evernote data folder found. Pass --data-dir <folder>.');
    const loopback = port === undefined ? 8765 : Number(port);
    if (evernote && !(Number.isInteger(loopback) && loopback >= 1024 && loopback <= 65535)) throw new Error('--port must be a number from 1024 to 65535.');
    const token = await readToken({ env, stdin, stderr });
    const ac = new AbortController();
    const onSigint = () => { stderr.write('\nStopping after the current request…\n'); ac.abort(); };
    process.once('SIGINT', onSigint);
    try {
      // 512: --evernote fetches formatted bodies from Evernote's MCP server (sign-in through the browser, on 127.0.0.1:<port>).
      const r = await runSend({ planPath, app: origin, token, dataDir: dir, accountId: account, signal: ac.signal,
        evernote: evernote ? { port: loopback } : null });
      return r.exitCode;
    } finally { process.removeListener('SIGINT', onSigint); }
  } catch (e) {
    stderr.write(`${redact(e.message)}\n`);
    return 1;
  }
}
