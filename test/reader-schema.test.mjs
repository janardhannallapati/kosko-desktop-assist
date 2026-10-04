import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checkSchema, SchemaMismatchError, REQUIRED_SCHEMA } from '../src/reader/schema.mjs';
import { buildSyntheticAccount } from './fixtures/synthetic-db.mjs';

function dbWith(mutate) {
  const { dbPath } = buildSyntheticAccount({ mutate });
  return new DatabaseSync(dbPath, { readOnly: true });
}

test('the real schema passes and reports its versions', () => {
  const db = dbWith();
  assert.deepEqual(checkSchema(db), { majorVersion: 3, migrationVersion: 139 });
});

test('REQUIRED_SCHEMA cannot be changed at runtime', () => {
  assert.ok(Object.isFrozen(REQUIRED_SCHEMA));
  for (const cols of Object.values(REQUIRED_SCHEMA)) assert.ok(Object.isFrozen(cols));
});

test('a dropped column is named', () => {
  const db = dbWith((d) => d.exec('ALTER TABLE Nodes_Tag DROP COLUMN parent_Tag_id'));
  assert.throws(() => checkSchema(db), (e) => e instanceof SchemaMismatchError
    && e.differences.includes('missing column Nodes_Tag.parent_Tag_id') && /Nodes_Tag\.parent_Tag_id/.test(e.message));
});

test('a dropped table is named', () => {
  const db = dbWith((d) => d.exec('DROP TABLE Offline_Search_Note_Content'));
  assert.throws(() => checkSchema(db), (e) => e.differences.includes('missing table Offline_Search_Note_Content'));
});

test('major version 4 refuses', () => {
  const db = dbWith((d) => d.exec("UPDATE _DBMetadata SET version = 4 WHERE id = 'major_database_version'"));
  assert.throws(() => checkSchema(db), (e) => e instanceof SchemaMismatchError
    && e.differences.some((x) => /major_database_version is 4, expected 3/.test(x)));
});

test('a missing major version refuses', () => {
  const db = dbWith((d) => d.exec("DELETE FROM _DBMetadata WHERE id = 'major_database_version'"));
  assert.throws(() => checkSchema(db), SchemaMismatchError);
});

test('every difference is listed, not just the first', () => {
  const db = dbWith((d) => {
    d.exec('ALTER TABLE Attachment DROP COLUMN dataHash');
    d.exec('DROP TABLE NoteTag');
    d.exec("UPDATE _DBMetadata SET version = 9 WHERE id = 'major_database_version'");
  });
  assert.throws(() => checkSchema(db), (e) => e.differences.length === 3);
});

test('an extra column and an extra table pass', () => {
  const db = dbWith((d) => { d.exec('ALTER TABLE Nodes_Note ADD COLUMN brandNew TEXT'); d.exec('CREATE TABLE Shiny(id TEXT)'); });
  assert.deepEqual(checkSchema(db), { majorVersion: 3, migrationVersion: 139 });
});

test('migration 140 passes and is reported', () => {
  const db = dbWith((d) => d.exec("UPDATE _DBMetadata SET version = 140 WHERE id = 'migration_version'"));
  assert.equal(checkSchema(db).migrationVersion, 140);
});
