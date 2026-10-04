// The tables and columns the reader reads, and nothing else. Evernote's local format is undocumented and changes
// between releases, so the reader refuses to start unless every one of these exists and the database's major
// version is the one it was written against. Extra tables and columns are fine: routine updates add them, and the
// reader names every column it reads. Measured on Evernote 10, major_database_version 3, migration_version 139.

export const EXPECTED_MAJOR_VERSION = 3;

const freezeAll = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze(v)])));

export const REQUIRED_SCHEMA = freezeAll({
  _DBMetadata: ['id', 'version'],
  Nodes_Notebook: ['id', 'label', 'created', 'updated', 'parent_Workspace_id', 'personal_Stack_id', 'recipient_Stack_id'],
  Nodes_Tag: ['id', 'label', 'parent_Tag_id'],
  Nodes_Note: ['id', 'label', 'created', 'updated', 'deleted', 'parent_Notebook_id', 'parent_Workspace_id'],
  NoteTag: ['Note_id', 'Tag_id'],
  Attachment: ['id', 'parent_Note_id', 'dataHash', 'mime', 'dataSize', 'filename', 'isActive'],
  AttachmentRecognition: ['id', 'content'],
  Offline_Search_Note_Content: ['id', 'content']
});

export class SchemaMismatchError extends Error {
  constructor(differences) {
    super(`This Evernote database is not the version Kosko's reader knows, so nothing was read:\n  - ${differences.join('\n  - ')}`);
    this.differences = differences;
  }
}

/** Throws SchemaMismatchError naming every difference; returns the database's versions when it matches. */
export function checkSchema(db) {
  const differences = [];
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    const present = new Set(db.prepare(`PRAGMA table_xinfo("${table}")`).all().map((c) => c.name));
    if (present.size === 0) { differences.push(`missing table ${table}`); continue; }
    for (const c of columns) if (!present.has(c)) differences.push(`missing column ${table}.${c}`);
  }
  let majorVersion = null;
  let migrationVersion = null;
  if (!differences.includes('missing table _DBMetadata')) {
    const v = (id) => db.prepare('SELECT version FROM _DBMetadata WHERE id = ?').get(id)?.version ?? null;
    majorVersion = v('major_database_version');
    migrationVersion = v('migration_version');
    if (majorVersion !== EXPECTED_MAJOR_VERSION) {
      differences.push(`major_database_version is ${majorVersion ?? 'missing'}, expected ${EXPECTED_MAJOR_VERSION}`);
    }
  }
  if (differences.length) throw new SchemaMismatchError(differences);
  return { majorVersion, migrationVersion };
}
