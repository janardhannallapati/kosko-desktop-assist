// Kosko 524 — the account and the Evernote exports for Kosko's ENEX proof (scripts/desktop-assist/enex-proof.mjs): the
// free plan's path, where the tool's plain-text run is followed by an ENEX drop on /import that upgrades every note.
//
// The 515 proof account (proof-account.mjs), plus what W5's demo needs:
//
//   Same second A, B   two notes created in one second, with different titles, in one notebook; A links to "Split two"
//                      by Evernote GUID under text that names no note, so only the GUID can resolve it
//   Split one, two     two notes created in one second, in two notebooks (two export files)
//   Twin × 2           two notes created in one second with ONE title: never matched, imported as new
//
// And real file hashes: the synthetic account's cache files are named by invented hashes, while an export carries the
// bytes and the reader hashes them. So the four cached files whose size is right are renamed to their real MD5 (the DB,
// the cache and the ENML all agree), which is what Evernote's own data holds. A file the cache lacks (the Fetched note's
// scan) is in the export, because Evernote has it; lost.pdf is in neither.
//
// writeEnexExports(acct, dir, { later }) writes one .enex per notebook (a note in a Space and no notebook goes in a file
// named after the Space). `later: true` is the LATER export: three notes edited in Evernote (LATER_EDITED).
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProofAccount, PROOF_BODIES, PROOF_ID, FETCHED, PROOF_HASH } from './proof-account.mjs';
import { ID, HASH } from '../fixtures/synthetic-db.mjs';
import { HEADER } from '../fixtures/evernote-setup.mjs';
import { enexFile } from '../fixtures/enex-writer.mjs';

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const md5 = (b) => createHash('md5').update(b).digest('hex');
const href = (g) => `evernote:///view/1001/s1/${g}/${g}/`;

export const ENEX_ID = { nSameA: guid(331), nSameB: guid(332), nSplit1: guid(333), nSplit2: guid(334), nTwin1: guid(335), nTwin2: guid(336) };
export const TWIN_TITLE = 'Twin';
const T0 = Date.UTC(2014, 2, 4, 10, 30, 15);
const SECOND = { same: T0 + 30 * 60_000, split: T0 + 31 * 60_000, twin: T0 + 32 * 60_000 };

// The synthetic cache's file bytes (synthetic-db.mjs `put`: Buffer.alloc(size, 1)), and the real MD5 each is renamed to.
const CACHED = [[ID.nActive, HASH.present, 5], [ID.nSpace, HASH.telugu, 6], [ID.nSpace, HASH.largeScan, 8], [ID.nSpace, HASH.noWords, 10]];
export const REAL_HASH = Object.fromEntries(CACHED.map(([, h, size]) => [h, md5(Buffer.alloc(size, 1))]));

const EXTRA_BODIES = {
  [ENEX_ID.nSameA]: `${HEADER}<en-note><div><b>First</b> of the pair</div><div>See <a href="${href(ENEX_ID.nSplit2)}">over there</a>.</div></en-note>`,
  [ENEX_ID.nSameB]: `${HEADER}<en-note><ul><li>second of the pair</li></ul></en-note>`,
  [ENEX_ID.nSplit1]: `${HEADER}<en-note><div><i>split</i> one</div></en-note>`,
  [ENEX_ID.nSplit2]: `${HEADER}<en-note><h2>split two</h2></en-note>`,
  [ENEX_ID.nTwin1]: `${HEADER}<en-note><div><u>twin</u> left</div></en-note>`,
  [ENEX_ID.nTwin2]: `${HEADER}<en-note><div><u>twin</u> right</div></en-note>`,
  // The Odd id note is never listed by Evernote's MCP server, so 515 has no ENML for it; an export does.
  [ID.nBadId]: `${HEADER}<en-note><div><b>odd</b></div></en-note>`
};

/** The three notes the LATER export carries edited (Evernote edits, after the first drop). */
export const LATER_EDITED = [PROOF_ID.nTable, ENEX_ID.nSameA, PROOF_ID.nPictures];
const edit = (enml) => enml.replace('</en-note>', '<div>Edited in Evernote later.</div></en-note>');

const NOTE_DEFAULTS = { isMetadata: 0, isUntitled: 0, isExternal: 0, content_localChangeTimestamp: 0, content_hash: 'h', content_size: 0,
  internal_shareCountProfiles: '{}', internal_maxResourceVersion: 0, internal_resourcesChanged: 0, internal_contentChanged: 0,
  internal_activeResourceCount: 0, localChangeTimestamp: 0, version: 1 };
const insert = (db, table, row) => {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
};

/** What the ENEX proof expects of a fresh account. */
export const ENEX_EXPECTED = Object.freeze({
  notes: 15, // the 515 proof account's 9 planned notes + 6
  files: 4, // Receipts, Projects, Loose, and the Space's note
  twins: [ENEX_ID.nTwin1, ENEX_ID.nTwin2],
  sameSecondMatched: [ENEX_ID.nSameA, ENEX_ID.nSameB, ENEX_ID.nSplit1, ENEX_ID.nSplit2]
});

export function buildEnexProofAccount({ root } = {}) {
  const extras = [
    [ENEX_ID.nSameA, 'Same second A', 'First of the pair\nSee over there.', SECOND.same, ID.nbLoose],
    [ENEX_ID.nSameB, 'Same second B', 'second of the pair', SECOND.same, ID.nbLoose],
    [ENEX_ID.nSplit1, 'Split one', 'split one', SECOND.split, ID.nbWork1],
    [ENEX_ID.nSplit2, 'Split two', 'split two', SECOND.split, ID.nbWork2],
    [ENEX_ID.nTwin1, TWIN_TITLE, 'twin left', SECOND.twin, ID.nbLoose],
    [ENEX_ID.nTwin2, TWIN_TITLE, 'twin right', SECOND.twin, ID.nbLoose]
  ];
  const acct = buildProofAccount({ root, mutate: (db) => {
    for (const [id, label, text, created, nb] of extras) {
      insert(db, 'Nodes_Note', { ...NOTE_DEFAULTS, id, label, created, updated: created + 1000, parent_Notebook_id: nb });
      insert(db, 'Offline_Search_Note_Content', { id, content: text });
    }
    const set = db.prepare('UPDATE Attachment SET dataHash = ? WHERE dataHash = ?');
    for (const [, h] of CACHED) set.run(REAL_HASH[h], h);
  } });
  for (const [noteId, h] of CACHED) renameSync(join(acct.resourceCacheDir, noteId, h), join(acct.resourceCacheDir, noteId, REAL_HASH[h]));
  return acct;
}

/** A note's ENML as the export carries it: 515's bodies with the real hashes, or the extras'. */
function enmlOf(id, later) {
  let enml = PROOF_BODIES[id] ?? EXTRA_BODIES[id];
  if (!enml) throw new Error(`no ENML for note ${id}`);
  for (const [fake, real] of Object.entries(REAL_HASH)) enml = enml.replaceAll(fake, real);
  return later && LATER_EDITED.includes(id) ? edit(enml) : enml;
}

/** The export's bytes for one attachment: the cache's when its MD5 is right, Evernote's own for the fetched scan. */
function bytesOf(acct, a) {
  if (a.dataHash === PROOF_HASH.fetched) return FETCHED;
  const p = join(acct.resourceCacheDir, a.noteId, a.dataHash);
  if (!existsSync(p)) return null; // lost.pdf: Evernote has no such file either
  const b = readFileSync(p);
  return b.length === a.dataSize && md5(b) === a.dataHash ? b : null;
}

/** One .enex per notebook, written into `dir`. Returns [{ file, notes }] in file-name order. */
export function writeEnexExports(acct, dir, { later = false } = {}) {
  const db = new DatabaseSync(acct.dbPath, { readOnly: true });
  try {
    const notes = db.prepare(`SELECT n.id, n.label, n.created, n.updated, coalesce(nb.label, ws.label) home
      FROM Nodes_Note n LEFT JOIN Nodes_Notebook nb ON nb.id = n.parent_Notebook_id LEFT JOIN Nodes_Workspace ws ON ws.id = n.parent_Workspace_id
      WHERE n.deleted IS NULL ORDER BY n.created, n.id`).all();
    const tags = db.prepare('SELECT t.label FROM NoteTag nt JOIN Nodes_Tag t ON t.id = nt.Tag_id WHERE nt.Note_id = ? ORDER BY t.label');
    const atts = db.prepare(`SELECT parent_Note_id noteId, dataHash, dataSize, mime, filename FROM Attachment
      WHERE parent_Note_id = ? AND isActive = 1 ORDER BY id`);
    const files = new Map();
    for (const n of notes) {
      const resources = atts.all(n.id).map((a) => ({ a, bytes: bytesOf(acct, a) })).filter((r) => r.bytes)
        .map(({ a, bytes }) => ({ bytes, mime: a.mime, fileName: a.filename }));
      const note = { title: n.label, created: n.created, updated: n.updated, tags: tags.all(n.id).map((t) => t.label),
        enml: enmlOf(n.id, later), resources };
      if (!files.has(n.home)) files.set(n.home, []);
      files.get(n.home).push({ id: n.id, note });
    }
    mkdirSync(dir, { recursive: true });
    return [...files.keys()].sort().map((home) => {
      const file = join(dir, `${home}.enex`);
      writeFileSync(file, enexFile(files.get(home).map((x) => x.note)));
      return { file, notes: files.get(home).map((x) => x.id) };
    });
  } finally {
    db.close();
  }
}
