// The dry run: read the whole account, write the exact plan to a folder the user chose, and prove the reading is
// complete by comparing what was written with the reader's separate count(*) queries. Sends nothing.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { registerCleanup } from '../reader/snapshot.mjs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { listAccounts } from '../reader/locate.mjs';
import { openAccount } from '../reader/reader.mjs';
import { JsonObjectWriter } from './json-stream.mjs';
import { renderSummary } from './summary.mjs';

const TOOL_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
// The numbers that are both written to the plan and counted by the reader (457 rule 4).
const CHECKED = ['notes', 'notesWithoutNotebook', 'emptyPlainText', 'notebooks', 'stacks', 'tags', 'noteTags',
  'attachments', 'attachmentBytes', 'ocr'];

// The real path of p, or of its nearest existing ancestor plus the rest: a symlink or Windows junction into
// Evernote's folder must not get past the check below.
function realish(p) {
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail.unshift(head.slice(up.length).replace(/^[\\/]/, ''));
    head = up;
  }
  return join(realpathSync.native(head), ...tail);
}

function isInside(child, parent) {
  const rel = relative(realish(parent), realish(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pickAccount(dataDir, accountId) {
  const accounts = listAccounts(dataDir);
  if (!accounts.length) throw new Error(`no Evernote accounts in ${dataDir}`);
  const ids = accounts.map((a) => `User${a.userId}`).join(', ');
  const account = accountId ? accounts.find((a) => a.userId === String(accountId)) : accounts[0];
  if (!account) throw new Error(`no account User${accountId} in ${dataDir}; found ${ids}`);
  return { account, others: accounts.filter((a) => a !== account) };
}

/**
 * @returns {Promise<{ ok, exitCode, planPath, summaryPath, summaryText, differences }>}
 * Throws, with nothing written, when --out is inside Evernote's folder, the account is unknown, Evernote is busy,
 * or the schema is not one the reader knows.
 */
// renameSync over a file another program holds open fails on Windows (EPERM/EBUSY): an editor showing the last
// plan, or antivirus scanning it. Retry briefly before giving up.
function renameWithRetry(rename, from, to, tries = 5) {
  for (let i = 1; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * i);
    }
  }
}

export async function runDryRun({ dataDir, accountId, outDir, tmpRoot, open = openAccount, now = Date.now,
  log = (s) => process.stdout.write(s), rename = renameSync, platform = process.platform, home = homedir() }) {
  if (!outDir) throw new Error('--out <folder> is required: the plan is written only where you say');
  if (isInside(outDir, dataDir)) throw new Error("--out is inside Evernote's data folder; choose a folder of your own");
  const started = now();
  const { account, others } = pickAccount(dataDir, accountId);
  const reader = await open(account, { tmpRoot });
  const planPath = join(outDir, 'kosko-plan.json');
  const partial = `${planPath}.partial`;
  let writer;
  let keepPartial = false;
  // Ctrl-C or a kill while writing must not leave a half-written plan (titles and text in clear) behind.
  const unregister = registerCleanup(() => { writer?.abort(); rmSync(partial, { force: true }); });
  try {
    mkdirSync(outDir, { recursive: true });
    const expected = reader.counts();
    writer = new JsonObjectWriter(partial);
    const tally = {};
    writer.value('format', 'kosko-plan');
    writer.value('version', 1);
    writer.value('generatedAt', new Date(started).toISOString());
    writer.value('tool', { name: 'kosko-desktop-assist', version: TOOL_VERSION });
    writer.value('sent', false);
    writer.value('source', { userId: account.userId, host: account.host, majorVersion: reader.meta.majorVersion,
      migrationVersion: reader.meta.migrationVersion });
    writer.value('counts', expected);
    tally.stacks = writer.array('stacks', reader.stacks());
    tally.notebooks = writer.array('notebooks', reader.notebooks());
    tally.tags = writer.array('tags', reader.tags());
    tally.noteTags = writer.array('noteTags', reader.noteTags());

    const titles = new Map();
    tally.notesWithoutNotebook = 0;
    tally.emptyPlainText = 0;
    tally.notes = writer.array('notes', (function* () {
      for (const n of reader.notes()) {
        titles.set(n.id, n.title);
        if (n.notebookId == null) tally.notesWithoutNotebook++;
        if (n.plainText === '') tally.emptyPlainText++;
        yield n;
      }
    })());

    const problems = { missingFiles: [], sizeMismatch: [], invalidIds: [], ocrErrors: [] };
    tally.attachmentBytes = 0;
    tally.attachments = writer.array('attachments', (function* () {
      for (const a of reader.attachments()) {
        tally.attachmentBytes += a.size;
        const named = { noteId: a.noteId, noteTitle: titles.get(a.noteId) ?? null, filename: a.filename, size: a.size };
        if (a.cache.status === 'missing') problems.missingFiles.push(named);
        if (a.cache.status === 'size-mismatch') problems.sizeMismatch.push({ ...named, actualSize: a.cache.actualSize });
        if (a.cache.status === 'invalid-id') problems.invalidIds.push({ attachmentId: a.id, noteId: a.noteId });
        yield { id: a.id, noteId: a.noteId, dataHash: a.dataHash, mime: a.mime, size: a.size, filename: a.filename,
          cacheStatus: a.cache.status, actualSize: a.cache.actualSize };
      }
    })());

    let ocrTextBytes = 0;
    let ocrWithWords = 0;
    const ocrRead = writer.array('ocr', (function* () {
      for (const o of reader.ocr()) {
        if (o.error) { problems.ocrErrors.push(o); continue; }
        ocrTextBytes += Buffer.byteLength(o.text, 'utf8');
        if (o.wordCount > 0) ocrWithWords++;
        yield o;
      }
    })());
    tally.ocr = ocrRead + problems.ocrErrors.length;
    writer.value('problems', problems);

    const differences = CHECKED.filter((k) => tally[k] !== expected[k])
      .map((k) => `${k}: wrote ${tally[k].toLocaleString('en-US')}, database has ${expected[k].toLocaleString('en-US')}`);
    const passed = differences.length === 0;
    writer.value('check', { passed, differences });
    writer.close();

    const earlierPlanKept = !passed && existsSync(planPath);
    if (passed) {
      try {
        renameWithRetry(rename, partial, planPath);
      } catch (e) {
        unregister(); // the finished, checked plan is worth keeping
        keepPartial = true;
        throw new Error(`the new plan is complete and checked, but ${planPath} could not be replaced (${e.code ?? e.message}); `
          + `it is probably open in another program. Close it and rename ${partial} to kosko-plan.json, or run again.`);
      }
    } else {
      rmSync(partial, { force: true });
    }

    const summaryText = renderSummary({
      account: { ...account, majorVersion: reader.meta.majorVersion, migrationVersion: reader.meta.migrationVersion },
      counts: expected,
      problems: Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.length])),
      ocrTextBytes,
      ocrWithWords,
      check: { passed, differences },
      planPath: passed ? resolve(planPath) : null,
      planBytes: passed ? statSync(planPath).size : 0,
      otherAccounts: others,
      elapsedMs: now() - started,
      earlierPlanKept,
      // NTFS ignores POSIX modes: on Windows the plan is only as private as the folder it is in.
      windowsOutsideProfile: platform === 'win32' && !isInside(outDir, home)
    });
    const summaryPath = join(outDir, 'kosko-plan-summary.txt');
    rmSync(summaryPath, { force: true }); // as for the plan: never write through a symlink planted at this name
    writeFileSync(summaryPath, summaryText, { mode: 0o600, flag: 'wx' });
    log(summaryText);
    return { ok: passed, exitCode: passed ? 0 : 1, planPath: passed ? planPath : null, summaryPath, summaryText, differences };
  } catch (e) {
    writer?.abort();
    if (!keepPartial && existsSync(partial)) rmSync(partial, { force: true });
    throw e;
  } finally {
    unregister();
    reader.close();
  }
}
