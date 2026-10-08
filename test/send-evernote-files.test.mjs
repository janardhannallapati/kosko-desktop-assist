// 513 — the files W2 could not find on this computer (`missing_from_cache`), fetched on the --evernote route with
// get_attachment's signed URL, checked by MD5 and stored through the same mint + PUT as W2, so the note's upgrade
// carries the file where its placeholder was. Against the fake MCP server and the in-memory Kosko (511's update path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ID, HASH } from './fixtures/synthetic-db.mjs';
import { setup, send, byGuid, BODIES } from './fixtures/evernote-setup.mjs';

const md5 = (b) => createHash('md5').update(b).digest('hex');
const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A file Evernote holds but this computer's resource cache does not: a real MD5 over real bytes.
const SCAN = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
const SCAN_MD5 = md5(SCAN);
const ODD = new Uint8Array([1, 1, 2, 3, 5, 8]);
const ODD_MD5 = md5(ODD);
const BIG = new Uint8Array(64).fill(7);
const BIG_MD5 = md5(BIG);

function attachment(db, { id, hash, size, mime = 'image/png', filename }) {
  const row = { id, filename, mime, width: 1, height: 1, isActive: 1, dataHash: hash, dataSize: size, applicationDataKeys: '[]',
    owner: 1, shardId: 's1', version: 1, parent_Note_id: ID.nActive, isDownloadedLocally: 0 };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "Attachment" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
}

/** The synthetic account plus missing-from-cache files on the Active note, which its ENML places after the table. */
async function filesSetup({ extra = [], mcp = {}, kosko } = {}) {
  const s = await setup({ mcp, kosko, mutate: (db) => {
    attachment(db, { id: guid(411), hash: SCAN_MD5, size: SCAN.length, filename: 'scan.png' });
    for (const e of extra) attachment(db, e);
  } });
  const n = s.mcp.state.notes.get(ID.nActive);
  n.enml = BODIES[ID.nActive].replace('</en-note>', `<div>after</div><en-media hash="${SCAN_MD5}" type="image/png"/></en-note>`);
  n.resources = [{ hash: SCAN_MD5, mime: 'image/png', name: 'scan.png', sizeBytes: SCAN.length },
    ...extra.map((e) => ({ hash: e.hash, mime: e.mime ?? 'image/png', name: e.filename, sizeBytes: e.size }))];
  s.mcp.state.files.set(SCAN_MD5, SCAN);
  return s;
}

const nodesWith = (doc, md5Hex) => {
  const out = [];
  (function w(n) { if (String(n.attrs?.path ?? '').includes(md5Hex)) out.push(n); (n.content ?? []).forEach(w); })(doc);
  return out;
};
const attachmentCalls = (s) => s.mcp.state.calls.filter((c) => c.tool === 'get_attachment');

test('run 1 leaves a placeholder; run 2 fetches the file by its signed URL, stores it under the note\'s key, and the upgrade carries it', async () => {
  const s = await filesSetup();
  const r1 = await send(s, { evernote: false });
  assert.equal(r1.exitCode, 0, r1.out);
  const [placeholder] = nodesWith(byGuid(s, ID.nActive).content, SCAN_MD5);
  assert.equal(placeholder.attrs.path, `enex-resource:${SCAN_MD5}`);
  assert.equal(placeholder.attrs.missing, 'missing_from_cache');

  const r2 = await send(s);
  assert.equal(r2.exitCode, 0, r2.out);
  const note = byGuid(s, ID.nActive);
  const [node] = nodesWith(note.content, SCAN_MD5);
  assert.equal(node.attrs.path, `notes/${note.id}/images/${SCAN_MD5}.png`, 'W2\'s key scheme, under the note\'s own id');
  assert.equal(node.attrs.missing ?? null, null, 'the placeholder is replaced, not joined');
  const after = note.content.content.findIndex((n) => n.content?.[0]?.text === 'after');
  const appended = note.content.content.indexOf(nodesWith(note.content, HASH.missing)[0]); // a file no <en-media> places
  const pos = note.content.content.indexOf(node);
  assert.ok(pos > after && pos < appended, `where the ENML puts it, not appended (${after} < ${pos} < ${appended})`);
  assert.ok(s.kosko.state.stored.has(node.attrs.path), 'PUT through the minted URL');
  assert.equal(s.kosko.state.uploads.find((u) => u.path === node.attrs.path).bytes, SCAN.length);
  assert.equal(s.kosko.state.dropRefusals, 0);
  assert.equal(s.kosko.job(r2.jobId).summary.notes.updated, 3);
  // The signed URL is fetched with no Evernote auth header (461), and get_attachment goes through the pacer.
  assert.deepEqual(s.mcp.state.downloads.map((d) => [d.hash, d.auth]), [[SCAN_MD5, false]]);
  const at = s.mcp.state.calls.map((c) => c.at);
  assert.ok(at.slice(1).every((t, i) => t - at[i] >= Math.floor(1000 / 1.1)), 'get_attachment is paced like get_note');
  // lost.pdf (W2's synthetic missing file) is not one Evernote holds: still missing, placeholder kept, named.
  const job = s.kosko.job(r2.jobId);
  assert.deepEqual(job.summary.evernoteFiles, { fetched: 1, stillMissing: 1, downloaded: 1, unreachable: 0 });
  assert.deepEqual(job.receipt.desktop.missing.map((m) => m.name), ['lost.pdf']);
  assert.equal(nodesWith(note.content, HASH.missing)[0].attrs.missing, 'missing_from_cache');
  assert.match(r2.out, /Files missing from this computer: 1 fetched from Evernote, 1 still missing\./);
  assert.ok(!r2.out.includes('scan.png') && !r2.out.includes(SCAN_MD5), 'counts only on the console');
});

test('benign: run 3 changes nothing — no get_attachment, no download, no upload, nothing written', async () => {
  const s = await filesSetup();
  await send(s, { evernote: false });
  await send(s);
  const scanCalls = attachmentCalls(s).filter((c) => c.hash === SCAN_MD5).length;
  const uploads = s.kosko.state.uploads.length;
  const versions = s.kosko.state.versions.length;
  const r3 = await send(s);
  assert.equal(r3.exitCode, 0, r3.out);
  const job = s.kosko.job(r3.jobId);
  assert.deepEqual(job.summary.notes, { created: 0, updated: 0, skipped: 4, not_imported: 0 });
  // The stored file is minted again (upload: null), so Evernote is not asked for it a second time.
  assert.equal(attachmentCalls(s).filter((c) => c.hash === SCAN_MD5).length, scanCalls);
  assert.equal(s.mcp.state.downloads.length, 1);
  assert.equal(s.kosko.state.uploads.length, uploads);
  assert.equal(s.kosko.state.versions.length, versions);
  assert.deepEqual(job.summary.evernoteFiles, { fetched: 1, stillMissing: 1, downloaded: 0, unreachable: 0 });
});

test('a download whose MD5 is not the resource hash is never stored: the placeholder stays and it is counted', async () => {
  const s = await filesSetup();
  s.mcp.state.files.set(SCAN_MD5, new Uint8Array([9, 8, 7, 6, 5, 4, 3, 0])); // same size, other bytes
  await send(s, { evernote: false });
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const note = byGuid(s, ID.nActive);
  const [node] = nodesWith(note.content, SCAN_MD5);
  assert.equal(node.attrs.path, `enex-resource:${SCAN_MD5}`);
  assert.equal(node.attrs.missing, 'missing_from_cache');
  assert.ok(!s.kosko.state.uploads.some((u) => u.path.includes(SCAN_MD5)), 'nothing PUT');
  assert.deepEqual(s.kosko.job(r.jobId).summary.evernoteFiles, { fetched: 0, stillMissing: 2, downloaded: 0, unreachable: 0 });
  assert.ok(s.kosko.job(r.jobId).receipt.desktop.missing.some((m) => m.name === 'scan.png'));
});

test('a file still missing is left out of the note\'s version, so the next run asks Evernote again and the upgrade lands', async () => {
  const s = await filesSetup();
  s.mcp.state.files.delete(SCAN_MD5); // Evernote cannot serve it on this run
  await send(s, { evernote: false });
  await send(s);
  assert.equal(nodesWith(byGuid(s, ID.nActive).content, SCAN_MD5)[0].attrs.missing, 'missing_from_cache');
  s.mcp.state.files.set(SCAN_MD5, SCAN); // now it can
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const note = byGuid(s, ID.nActive);
  assert.equal(nodesWith(note.content, SCAN_MD5)[0].attrs.path, `notes/${note.id}/images/${SCAN_MD5}.png`);
  assert.equal(s.kosko.job(r.jobId).summary.notes.updated, 1);
  assert.deepEqual(s.kosko.job(r.jobId).summary.evernoteFiles, { fetched: 1, stillMissing: 1, downloaded: 1, unreachable: 0 });
});

test('a signed URL already expired, or answered 403, is replaced by a new one ONCE', async () => {
  for (const mcp of [{ staleUrls: 1 }, { forbidDownloads: 1 }]) {
    const s = await filesSetup({ mcp });
    const r = await send(s);
    assert.equal(r.exitCode, 0, r.out);
    assert.equal(attachmentCalls(s).filter((c) => c.hash === SCAN_MD5).length, 2, JSON.stringify(mcp));
    assert.equal(s.kosko.job(r.jobId).summary.evernoteFiles.fetched, 1, JSON.stringify(mcp));
    // An expired URL is never even tried; a refused one was tried once.
    assert.equal(s.mcp.state.downloads.length, mcp.staleUrls ? 1 : 2, JSON.stringify(mcp));
  }
  // Twice refused: no third URL; the placeholder stays, counted.
  const s = await filesSetup({ mcp: { forbidDownloads: 2 } });
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(attachmentCalls(s).filter((c) => c.hash === SCAN_MD5).length, 2);
  assert.deepEqual(s.kosko.job(r.jobId).summary.evernoteFiles, { fetched: 0, stillMissing: 2, downloaded: 0, unreachable: 0 });
  assert.equal(nodesWith(byGuid(s, ID.nActive).content, SCAN_MD5)[0].attrs.missing, 'missing_from_cache');
});

test('W2\'s type and size rules decide first: a type Kosko does not store, or a file over the cap, is never fetched', async () => {
  const s = await filesSetup({ kosko: { maxFileBytes: 32 }, extra: [
    { id: guid(412), hash: ODD_MD5, size: ODD.length, mime: 'application/x-msdownload', filename: 'setup.exe' },
    { id: guid(413), hash: BIG_MD5, size: BIG.length, filename: 'big.png' }] });
  s.mcp.state.files.set(ODD_MD5, ODD);
  s.mcp.state.files.set(BIG_MD5, BIG);
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const asked = attachmentCalls(s).map((c) => c.hash);
  assert.ok(asked.includes(SCAN_MD5));
  assert.ok(!asked.includes(ODD_MD5) && !asked.includes(BIG_MD5));
  const note = byGuid(s, ID.nActive);
  assert.equal(nodesWith(note.content, ODD_MD5)[0].attrs.missing, 'type_not_stored');
  assert.equal(nodesWith(note.content, BIG_MD5)[0].attrs.missing, 'over_size_cap');
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.evernoteFiles, { fetched: 1, stillMissing: 1, downloaded: 1, unreachable: 0 });
  assert.equal(job.summary.attachments.type_not_stored, 1);
  assert.equal(job.summary.attachments.over_cap, 1);
});

test('only a note that gets its formatted body is fetched for: a plain-text note keeps W2\'s placeholder', async () => {
  const s = await filesSetup();
  s.mcp.state.notes.get(ID.nActive).active = false; // not listed by Evernote: plain text
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(attachmentCalls(s).length, 0);
  assert.equal(nodesWith(byGuid(s, ID.nActive).content, SCAN_MD5)[0].attrs.missing, 'missing_from_cache');
  assert.deepEqual(s.kosko.job(r.jobId).summary.evernoteFiles, { fetched: 0, stillMissing: 2, downloaded: 0, unreachable: 0 });
});

test('a note kept for a Kosko edit does not take the fetched file: it is counted, and named, as still missing there', async () => {
  const s = await filesSetup();
  await send(s, { evernote: false });
  const active = byGuid(s, ID.nActive);
  const edited = structuredClone(active.content);
  edited.content.unshift({ type: 'paragraph', content: [{ type: 'text', text: 'my own line' }] });
  s.kosko.editNote(active.id, { content: edited });
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  const job = s.kosko.job(r.jobId);
  assert.equal(job.summary.skip_reasons.edited_in_kosko, 1);
  assert.deepEqual(byGuid(s, ID.nActive).content, edited, 'the edit stays');
  assert.deepEqual(job.summary.evernoteFiles, { fetched: 0, stillMissing: 2, downloaded: 1, unreachable: 0 });
  assert.ok(job.receipt.desktop.missing.some((m) => m.name === 'scan.png'));
});

test('two files of one note: one get_attachment and download at a time, paced, whatever the upload lanes do', async () => {
  const TWO = new Uint8Array([4, 4, 4, 4, 4]);
  const TWO_MD5 = md5(TWO);
  const s = await filesSetup({ extra: [{ id: guid(414), hash: TWO_MD5, size: TWO.length, filename: 'two.png' }] });
  s.mcp.state.files.set(TWO_MD5, TWO);
  const r = await send(s);
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(s.kosko.job(r.jobId).summary.evernoteFiles.fetched, 2);
  const at = s.mcp.state.calls.map((c) => c.at);
  assert.ok(at.slice(1).every((t, i) => t - at[i] >= Math.floor(1000 / 1.1)), `paced: ${at.slice(1).map((t, i) => t - at[i])}`);
  // Each download follows its own get_attachment, before the next one is asked for.
  const seq = [...s.mcp.state.calls.filter((c) => c.tool === 'get_attachment').map((c) => ({ k: 'ask', at: c.at })),
    ...s.mcp.state.downloads.map((d) => ({ k: 'get', at: d.at }))].sort((a, b) => a.at - b.at || (a.k === 'ask' ? -1 : 1));
  assert.deepEqual(seq.map((e) => e.k).slice(-4), ['ask', 'get', 'ask', 'get']);
});

test('review T3: a get_attachment that keeps failing (5xx) is tried again, then given up: placeholder kept, counted, the run goes on', async () => {
  const s = await filesSetup();
  const real = s.mcp.fetch;
  let tries = 0;
  const f = (url, init) => (typeof init?.body === 'string' && init.body.includes('"get_attachment"') && init.body.includes(SCAN_MD5) ? (tries++, new Response('{}', { status: 500 })) : real(url, init));
  const r = await send(s, { mcpFetch: f });
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(tries, 4, 'tried, then three more');
  const job = s.kosko.job(r.jobId);
  assert.deepEqual(job.summary.evernoteFiles, { fetched: 0, stillMissing: 2, downloaded: 0, unreachable: 1 });
  assert.equal(job.summary.bodies.formatted, 3, 'the note itself is still upgraded');
  assert.equal(nodesWith(byGuid(s, ID.nActive).content, SCAN_MD5)[0].attrs.missing, 'missing_from_cache');
});

test('review T2: Ctrl-C during a download stops the run (exit 130) — never read as a missing file', async () => {
  const s = await filesSetup();
  const ac = new AbortController();
  const real = s.mcp.fetch;
  const f = (url, init) => {
    if (!String(url).includes('/files/')) return real(url, init);
    ac.abort();
    return new Promise((_, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
  };
  const r = await send(s, { mcpFetch: f, signal: ac.signal });
  assert.equal(r.exitCode, 130, r.out);
  assert.equal(s.kosko.job(r.jobId).status, 'running');
  assert.ok(!s.kosko.state.requests.includes('PATCH /api/import/jobs/[id]'), 'the job is not finished as if the file were missing');
});
