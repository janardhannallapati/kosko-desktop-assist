// A private, consistent copy of Evernote's database. The source is opened read-only and only to run SQLite's
// online backup, so Evernote's own file is never written. The copy holds the whole account in clear, so it lives
// in a fresh 0700 temp folder and is deleted on close, on a failed open, and when the process exits.
import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class EvernoteBusyError extends Error {
  constructor() { super('Evernote is writing to its database. Close Evernote and try again.'); }
}

// dir → closers to run before deleting it. Windows cannot delete a file that is still open, so an open reader's
// database handle is closed first.
const live = new Map();
let hooked = false;

function removeDir(dir) {
  for (const close of live.get(dir) ?? []) { try { close(); } catch { /* already closed */ } }
  live.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

// Other files that must not outlive the process (the dry run's half-written plan). Run on exit and on a signal.
const extra = new Set();
/** Runs fn on exit, Ctrl-C or SIGTERM unless the returned unregister() is called first. */
export function registerCleanup(fn) {
  extra.add(fn);
  hookExit();
  return () => extra.delete(fn);
}

// Never stops halfway: one folder that cannot be removed must not leave the others behind.
function removeAll() {
  for (const fn of [...extra]) {
    extra.delete(fn);
    try { fn(); } catch (e) { process.stderr.write(`kosko-assist: cleanup failed: ${e.message}\n`); }
  }
  for (const dir of [...live.keys()]) {
    try { removeDir(dir); } catch (e) { process.stderr.write(`kosko-assist: could not delete ${dir}: ${e.message}\n`); }
  }
}

const SIGNALS = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on('exit', removeAll);
  for (const sig of SIGNALS) {
    process.once(sig, () => {
      removeAll();
      try { process.kill(process.pid, sig); } catch { process.exit(SIGNAL_EXIT[sig]); }
    });
  }
}

const isBusy = (e) => e?.errcode === 5 || e?.errcode === 6 || /\b(busy|locked)\b/i.test(e?.message ?? '');

// node:sqlite's backup() loses the code when a step is refused and rejects with errcode 0, "not an error"
// (Node 22.23). That is also what a full temp drive could look like, so ask the source again: busy now means
// Evernote took the lock mid-copy; otherwise report the failure as what it is.
function explainBackupFailure(e, srcPath, tmpRoot) {
  if (!(e?.code === 'ERR_SQLITE_ERROR' && e?.errcode === 0)) return e;
  try {
    const again = new DatabaseSync(srcPath, { readOnly: true, timeout: 0 });
    try { again.prepare('SELECT count(*) FROM sqlite_master').get(); } finally { again.close(); }
  } catch (probe) {
    if (isBusy(probe)) return new EvernoteBusyError();
  }
  return new Error(`copying Evernote's database failed without a reason from SQLite; check free space in ${tmpRoot}`);
}

function defaultIntegrityCheck(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('PRAGMA integrity_check').get().integrity_check; } finally { db.close(); }
}

/** @returns {Promise<{ path: string, dir: string, addCloser: (fn: () => void) => void, cleanup: () => void }>} */
export async function snapshotDb(srcPath, { tmpRoot = tmpdir(), integrityCheck = defaultIntegrityCheck,
  busyTimeoutMs = 2000 } = {}) {
  // A -journal file means a write transaction is open or was interrupted; only Evernote may roll it back.
  if (existsSync(`${srcPath}-journal`)) throw new EvernoteBusyError();
  const dir = mkdtempSync(join(tmpRoot, 'kosko-assist-'));
  live.set(dir, []);
  hookExit();
  const cleanup = () => { if (live.has(dir) || existsSync(dir)) removeDir(dir); };
  const addCloser = (fn) => live.get(dir)?.push(fn);
  const path = join(dir, 'evernote-snapshot.sqlite');
  try {
    chmodSync(dir, 0o700);
    // timeout: a short write by Evernote is waited out instead of failing the run.
    const src = new DatabaseSync(srcPath, { readOnly: true, timeout: busyTimeoutMs });
    try {
      src.prepare('SELECT count(*) FROM sqlite_master').get(); // takes the shared lock; throws BUSY with its code
      await backup(src, path);
    } catch (e) {
      throw explainBackupFailure(e, srcPath, tmpRoot);
    } finally {
      src.close();
    }
    const result = integrityCheck(path);
    if (result !== 'ok') throw new Error(`the copied database failed SQLite's integrity_check: ${result}`);
    return { path, dir, addCloser, cleanup };
  } catch (e) {
    try { cleanup(); } catch { /* the original error matters more; the exit hook retries */ }
    throw isBusy(e) ? new EvernoteBusyError() : e;
  }
}
