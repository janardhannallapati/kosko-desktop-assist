// Builds a small Evernote data directory on disk from Evernote's real DDL (evernote-schema.sql), with one row for
// every edge the reader must handle. No real account data: every title, word and file here is invented.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = readFileSync(new URL('./evernote-schema.sql', import.meta.url), 'utf8');
export const USER_ID = '1001';
export const HOST_DIR = 'https%3A%2F%2Fwww.evernote.com';

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (n) => String(n).padStart(32, 'a').slice(-32).replace(/[^0-9a-f]/g, 'b');

export const ID = {
  nbWork1: guid(101), nbWork2: guid(102), nbLoose: guid(103), nbShared: guid(104),
  tagAlpha: guid(201), tagBeta: guid(202),
  nActive: guid(301), nEmptyText: guid(302), nSpace: guid(303), nTrashed: guid(304), nBadId: '../../escape',
  aPresent: guid(401), aMissing: guid(402), aWrongSize: guid(403), aInactive: guid(404), aBadHash: guid(405),
  aTrashedNote: guid(406), aOnBadIdNote: guid(407)
};
export const HASH = { present: hash(1), missing: hash(2), wrongSize: hash(3), inactive: hash(4), trashed: hash(6),
  onBadIdNote: hash(7), bad: 'ZZ../not-hex' };

// recoIndex as Evernote stores it: hex of the XML. Item 1 has a tie (first wins), item 2 an entity and a lower
// second candidate, item 3 no <t> at all (an object region), item 4 a decimal and a hex character reference.
export const RECO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE recoIndex PUBLIC "SYSTEM" "http://xml.evernote.com/pub/recoIndex.dtd">
<recoIndex docType="unknown" objType="image" objID="x" engineVersion="7.0.24.1" recoType="service" lang="en" objWidth="100" objHeight="40">
<item x="1" y="1" w="10" h="5"><t w="50">Invoice</t><t w="50">lnvoice</t></item>
<item x="12" y="1" w="10" h="5"><t w="31">R&amp;D</t><t w="87">R&amp;D&lt;2&gt;</t></item>
<item x="30" y="1" w="10" h="5"><object type="face" w="40"/></item>
<item x="40" y="1" w="10" h="5"><t w="90">caf&#233;&#x21;</t></item>
</recoIndex>`;
export const RECO_WORDS = 'Invoice R&D<2> café!';

const NOTE_DEFAULTS = { isMetadata: 0, isUntitled: 0, isExternal: 0, content_localChangeTimestamp: 0,
  content_hash: 'h', content_size: 0, internal_shareCountProfiles: '{}', internal_maxResourceVersion: 0,
  internal_resourcesChanged: 0, internal_contentChanged: 0, internal_activeResourceCount: 0,
  localChangeTimestamp: 0, version: 1 };

function insert(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

const T0 = Date.UTC(2014, 2, 4, 10, 30, 15); // whole seconds, as in the real data

/**
 * Creates <root>/Evernote with conduit-storage/<host>/UDB-User1001+RemoteGraph.sql and resource-cache/User1001.
 * `mutate(db)` runs after the rows are written (e.g. to drop a column for the schema tests).
 */
export function buildSyntheticAccount({ root = mkdtempSync(join(tmpdir(), 'kosko-synth-')), mutate } = {}) {
  const dataDir = join(root, 'Evernote');
  const dbDir = join(dataDir, 'conduit-storage', HOST_DIR);
  const cacheDir = join(dataDir, 'resource-cache', `User${USER_ID}`);
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const dbPath = join(dbDir, `UDB-User${USER_ID}+RemoteGraph.sql`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = delete');
  db.exec(SCHEMA);
  insert(db, '_DBMetadata', { id: 'major_database_version', version: 3 });
  insert(db, '_DBMetadata', { id: 'migration_version', version: 139 });

  const nb = (id, label, stack, recipient = null) => insert(db, 'Nodes_Notebook', { id, created: T0, updated: T0,
    isPublished: 0, inWorkspace: 0, isExternal: 0, isShared: 0, reminderNotifyEmail: 0, reminderNotifyInApp: 0,
    internal_shareCountProfiles: '{}', personal_Stack_id: stack, recipient_Stack_id: recipient, label,
    localChangeTimestamp: 0, version: 1 });
  nb(ID.nbWork1, 'Receipts', 'Work');
  nb(ID.nbWork2, 'Projects', 'Work');
  nb(ID.nbLoose, 'Loose', null);
  nb(ID.nbShared, 'From a friend', null, 'Shared stack');

  // 467: two Spaces with one name (the owner's account has two "Work"s); nSpace sits in the older one.
  const ws = (id, label, created) => insert(db, 'Nodes_Workspace', { id, accessStatus: 'OWNER', description: '', workspaceType: 'OPEN',
    created, updated: created, isSample: 0, notesCount: 0, notebooksCount: 0, internal_shareCountProfiles: '{}', label,
    localChangeTimestamp: 0, version: 1 });
  ws('ws-1', 'Personal', T0);
  ws('ws-2', 'Personal', T0 + 5000);

  insert(db, 'Nodes_Tag', { id: ID.tagAlpha, label: 'alpha', localChangeTimestamp: 0, version: 1 });
  insert(db, 'Nodes_Tag', { id: ID.tagBeta, label: 'beta', parent_Tag_id: ID.tagAlpha, localChangeTimestamp: 0, version: 1 });

  const note = (id, label, extra) => insert(db, 'Nodes_Note', { ...NOTE_DEFAULTS, id, label, created: T0, updated: T0 + 1000, ...extra });
  note(ID.nActive, 'Active note', { parent_Notebook_id: ID.nbWork1 });
  note(ID.nEmptyText, 'Empty text', { parent_Notebook_id: ID.nbLoose, created: T0 + 60_000 });
  note(ID.nSpace, 'In a Space', { parent_Workspace_id: 'ws-1', created: T0 + 120_000 });
  note(ID.nTrashed, 'Trashed note', { parent_Notebook_id: ID.nbWork1, deleted: T0 + 999_000 });
  note(ID.nBadId, 'Odd id', { parent_Notebook_id: ID.nbWork2, created: T0 + 180_000 });

  insert(db, 'Offline_Search_Note_Content', { id: ID.nActive, content: 'hello world' });
  insert(db, 'Offline_Search_Note_Content', { id: ID.nEmptyText, content: '' });
  insert(db, 'Offline_Search_Note_Content', { id: ID.nTrashed, content: 'gone' });
  insert(db, 'Offline_Search_Note_Content', { id: ID.nBadId, content: 'odd' });
  // nSpace has no plain-text row at all.

  insert(db, 'NoteTag', { id: 'nt1', Note_id: ID.nActive, Tag_id: ID.tagAlpha });
  insert(db, 'NoteTag', { id: 'nt2', Note_id: ID.nActive, Tag_id: ID.tagBeta });
  insert(db, 'NoteTag', { id: 'nt3', Note_id: ID.nTrashed, Tag_id: ID.tagAlpha });

  const att = (id, noteId, dataHash, dataSize, isActive = 1, filename = 'file.png') => insert(db, 'Attachment', {
    id, filename, mime: 'image/png', width: 1, height: 1, isActive, dataHash, dataSize, applicationDataKeys: '[]',
    owner: 1, shardId: 's1', version: 1, parent_Note_id: noteId, isDownloadedLocally: 1 });
  att(ID.aPresent, ID.nActive, HASH.present, 5, 1, 'receipt.png');
  att(ID.aMissing, ID.nActive, HASH.missing, 7, 1, 'lost.pdf');
  att(ID.aWrongSize, ID.nActive, HASH.wrongSize, 9);
  att(ID.aInactive, ID.nActive, HASH.inactive, 3, 0);
  att(ID.aBadHash, ID.nEmptyText, HASH.bad, 4);
  att(ID.aTrashedNote, ID.nTrashed, HASH.trashed, 2);
  att(ID.aOnBadIdNote, ID.nBadId, HASH.onBadIdNote, 1);

  const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
  insert(db, 'AttachmentRecognition', { id: ID.aPresent, content: hex(RECO_XML) });
  insert(db, 'AttachmentRecognition', { id: ID.aWrongSize, content: 'zz-not-hex' });
  insert(db, 'AttachmentRecognition', { id: ID.aMissing, content: '' }); // scanned, no text found
  insert(db, 'AttachmentRecognition', { id: ID.aTrashedNote, content: hex(RECO_XML) });

  if (mutate) mutate(db);
  db.close();

  const put = (noteId, h, bytes) => {
    mkdirSync(join(cacheDir, noteId), { recursive: true });
    writeFileSync(join(cacheDir, noteId, h), Buffer.alloc(bytes, 1));
    writeFileSync(join(cacheDir, noteId, `${h}.meta`), '{}');
  };
  put(ID.nActive, HASH.present, 5);
  put(ID.nActive, HASH.wrongSize, 4); // recorded 9
  put(ID.nTrashed, HASH.trashed, 2);
  // aMissing has no file; aBadHash and aOnBadIdNote must never be looked up.

  return { root, dataDir, dbPath, resourceCacheDir: cacheDir, userId: USER_ID };
}

/** What the reader must report for the account above. */
export const EXPECTED_COUNTS = Object.freeze({
  notes: 4, trashedNotes: 1, notesWithoutNotebook: 1, notebooks: 4, stacks: 2, tags: 2,
  noteTags: 2, noteTagsAll: 3, attachments: 5, attachmentBytes: 5 + 7 + 9 + 4 + 1, ocr: 3, ocrAll: 4,
  emptyPlainText: 2,
  // stored OCR on active attachments: the recoIndex XML as hex, plus the 10-char 'zz-not-hex' record, halved
  ocrStoredBytes: Buffer.byteLength(RECO_XML, 'utf8') + 5
});
