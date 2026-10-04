// Reads one Evernote account from a private snapshot. Everything a later step needs comes out of here: the
// notebook tree (a stack is just a name on a notebook), tags, links, notes with their plain text, attachments
// with their cache file, and OCR. Trashed notes are counted and never yielded. counts() runs its own count(*)
// queries whose predicates are typed out literally, sharing no constant with the iterators, so the dry run can
// catch a wrong WHERE in either one.
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotDb } from './snapshot.mjs';
import { checkSchema } from './schema.mjs';
import { parseRecoIndex, RecoIndexError } from './recoindex.mjs';

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MD5 = /^[0-9a-f]{32}$/;

const ACTIVE_NOTE = 'n.deleted IS NULL';
const ACTIVE_ATTACHMENT = `a.isActive = 1 AND ${ACTIVE_NOTE}`;

// Deliberately NOT built from ACTIVE_NOTE / ACTIVE_ATTACHMENT: a shared constant would make a wrong filter
// invisible to the comparison these counts exist for.
const COUNT_SQL = {
  notes: 'SELECT count(*) c FROM Nodes_Note WHERE deleted IS NULL',
  trashedNotes: 'SELECT count(*) c FROM Nodes_Note WHERE deleted IS NOT NULL',
  notesWithoutNotebook: 'SELECT count(*) c FROM Nodes_Note WHERE deleted IS NULL AND parent_Notebook_id IS NULL',
  notebooks: 'SELECT count(*) c FROM Nodes_Notebook',
  stacks: 'SELECT count(DISTINCT coalesce(personal_Stack_id, recipient_Stack_id)) c FROM Nodes_Notebook',
  tags: 'SELECT count(*) c FROM Nodes_Tag',
  noteTags: 'SELECT count(*) c FROM NoteTag WHERE Note_id IN (SELECT id FROM Nodes_Note WHERE deleted IS NULL)',
  noteTagsAll: 'SELECT count(*) c FROM NoteTag',
  attachments: `SELECT count(*) c FROM Attachment WHERE isActive = 1
        AND parent_Note_id IN (SELECT id FROM Nodes_Note WHERE deleted IS NULL)`,
  attachmentBytes: `SELECT coalesce(sum(dataSize), 0) c FROM Attachment WHERE isActive = 1
        AND parent_Note_id IN (SELECT id FROM Nodes_Note WHERE deleted IS NULL)`,
  ocr: `SELECT count(*) c FROM AttachmentRecognition WHERE id IN (SELECT id FROM Attachment WHERE isActive = 1
        AND parent_Note_id IN (SELECT id FROM Nodes_Note WHERE deleted IS NULL))`,
  ocrAll: 'SELECT count(*) c FROM AttachmentRecognition',
  // R4: how big the stored OCR is (hex, so half its length in bytes), against the words the dry run keeps.
  ocrStoredBytes: `SELECT coalesce(sum(length(content)), 0) / 2 c FROM AttachmentRecognition WHERE id IN
        (SELECT id FROM Attachment WHERE isActive = 1 AND parent_Note_id IN (SELECT id FROM Nodes_Note WHERE deleted IS NULL))`,
  emptyPlainText: `SELECT count(*) c FROM Nodes_Note WHERE deleted IS NULL
        AND id NOT IN (SELECT id FROM Offline_Search_Note_Content WHERE content <> '')`
};

function cacheEntry(resourceCacheDir, noteId, dataHash, size) {
  if (!GUID.test(noteId) || !MD5.test(dataHash)) return { path: null, status: 'invalid-id', actualSize: null };
  const path = join(resourceCacheDir, noteId, dataHash);
  let actual;
  try { actual = statSync(path).size; } catch { return { path, status: 'missing', actualSize: null }; }
  return { path, status: actual === size ? 'present' : 'size-mismatch', actualSize: actual };
}

/**
 * Snapshots the account's database, checks its schema, and returns the reader. Throws (and deletes the snapshot)
 * before yielding anything if the database is busy, damaged or an unknown version.
 */
export async function openAccount({ dbPath, resourceCacheDir }, { tmpRoot } = {}) {
  const snap = await snapshotDb(dbPath, { tmpRoot });
  let db;
  try {
    db = new DatabaseSync(snap.path, { readOnly: true });
    const opened = db;
    snap.addCloser(() => opened.close());
    const versions = checkSchema(db);
    return makeReader(db, snap, versions, resourceCacheDir);
  } catch (e) {
    try { db?.close(); } catch { /* already closed */ }
    try { snap.cleanup(); } catch { /* the exit hook retries */ }
    throw e;
  }
}

function makeReader(db, snap, versions, resourceCacheDir) {
  const all = (sql) => db.prepare(sql).all();
  const iter = (sql) => db.prepare(sql).iterate();
  return {
    meta: { ...versions, snapshotPath: snap.path },

    counts() {
      return Object.fromEntries(Object.entries(COUNT_SQL).map(([k, sql]) => [k, db.prepare(sql).get().c]));
    },

    notebooks() {
      return all(`SELECT id, label, coalesce(personal_Stack_id, recipient_Stack_id) stack, parent_Workspace_id ws,
                  created, updated FROM Nodes_Notebook ORDER BY label, id`)
        .map((r) => ({ id: r.id, name: r.label, stack: r.stack, workspaceId: r.ws, created: r.created, updated: r.updated }));
    },

    stacks() {
      return all(`SELECT coalesce(personal_Stack_id, recipient_Stack_id) name, count(*) n FROM Nodes_Notebook
                  WHERE coalesce(personal_Stack_id, recipient_Stack_id) IS NOT NULL GROUP BY 1 ORDER BY 1`)
        .map((r) => ({ name: r.name, notebookCount: r.n }));
    },

    tags() {
      return all('SELECT id, label, parent_Tag_id FROM Nodes_Tag ORDER BY label, id')
        .map((r) => ({ id: r.id, name: r.label, parentId: r.parent_Tag_id }));
    },

    *noteTags() {
      for (const r of iter(`SELECT t.Note_id, t.Tag_id FROM NoteTag t JOIN Nodes_Note n ON n.id = t.Note_id
                             WHERE ${ACTIVE_NOTE} ORDER BY t.Note_id, t.Tag_id`)) {
        yield { noteId: r.Note_id, tagId: r.Tag_id };
      }
    },

    *notes() {
      for (const r of iter(`SELECT n.id, n.label, n.created, n.updated, n.parent_Notebook_id nb, n.parent_Workspace_id ws,
                             o.content text FROM Nodes_Note n LEFT JOIN Offline_Search_Note_Content o ON o.id = n.id
                             WHERE ${ACTIVE_NOTE} ORDER BY n.created, n.id`)) {
        yield { id: r.id, title: r.label, created: r.created, updated: r.updated, notebookId: r.nb, workspaceId: r.ws,
          plainText: r.text ?? '' };
      }
    },

    *attachments() {
      for (const r of iter(`SELECT a.id, a.parent_Note_id noteId, a.dataHash, a.mime, a.dataSize, a.filename
                             FROM Attachment a JOIN Nodes_Note n ON n.id = a.parent_Note_id
                             WHERE ${ACTIVE_ATTACHMENT} ORDER BY a.parent_Note_id, a.id`)) {
        yield { id: r.id, noteId: r.noteId, dataHash: r.dataHash, mime: r.mime, size: r.dataSize, filename: r.filename,
          cache: cacheEntry(resourceCacheDir, r.noteId, r.dataHash, r.dataSize) };
      }
    },

    *ocr() {
      for (const r of iter(`SELECT r.id, r.content FROM AttachmentRecognition r JOIN Attachment a ON a.id = r.id
                             JOIN Nodes_Note n ON n.id = a.parent_Note_id WHERE ${ACTIVE_ATTACHMENT} ORDER BY r.id`)) {
        try {
          yield { attachmentId: r.id, ...parseRecoIndex(r.content) };
        } catch (e) {
          if (!(e instanceof RecoIndexError)) throw e; // a bug, not a bad record
          yield { attachmentId: r.id, error: e.message };
        }
      }
    },

    close() {
      try { db.close(); } catch { /* already closed */ } finally { snap.cleanup(); }
    }
  };
}
