import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDataDirs, listAccounts } from '../src/reader/locate.mjs';
import { buildSyntheticAccount, HOST_DIR } from './fixtures/synthetic-db.mjs';

// A fake filesystem: the set of directories that exist, and what a directory lists.
function fakeFs(dirs, listing = {}) {
  const set = new Set(dirs);
  return { exists: (p) => set.has(p), readdir: (p) => listing[p] ?? [] };
}

test('Windows APPDATA path', () => {
  const p = 'C:\\Users\\u\\AppData\\Roaming\\Evernote';
  const out = findDataDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, ...fakeFs([p]) });
  assert.deepEqual(out, [p]);
});

test('Store package glob', () => {
  const pkgs = 'C:\\Users\\u\\AppData\\Local\\Packages';
  const store = `${pkgs}\\Evernote.Evernote_q4d96b2w5wcc2\\LocalCache\\Roaming\\Evernote`;
  const out = findDataDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    ...fakeFs([pkgs, store, `${pkgs}\\Microsoft.Photos_x\\LocalCache\\Roaming\\Evernote`],
      { [pkgs]: ['Microsoft.Photos_x', 'Evernote.Evernote_q4d96b2w5wcc2'] }) });
  assert.deepEqual(out, [store]);
});

test('macOS both paths, in order', () => {
  const a = '/Users/u/Library/Application Support/Evernote';
  const b = '/Users/u/Library/Containers/com.evernote.Evernote/Data/Library/Application Support/Evernote';
  assert.deepEqual(findDataDirs({ platform: 'darwin', home: '/Users/u', env: {}, ...fakeFs([a, b]) }), [a, b]);
});

test('dataDir override wins on every platform, and nothing is found on Linux without it', () => {
  assert.deepEqual(findDataDirs({ platform: 'linux', dataDir: '/mnt/c/x/Evernote', env: {}, ...fakeFs([]) }), ['/mnt/c/x/Evernote']);
  assert.deepEqual(findDataDirs({ platform: 'linux', home: '/home/u', env: {}, ...fakeFs([]) }), []);
});

test('lists every UDB-User file under any host folder, ignoring LocalStorage and other files', () => {
  const { dataDir, dbPath, resourceCacheDir } = buildSyntheticAccount();
  const cn = join(dataDir, 'conduit-storage', 'https%3A%2F%2Fapp.yinxiang.com');
  mkdirSync(cn, { recursive: true });
  writeFileSync(join(cn, 'UDB-User77+RemoteGraph.sql'), 'x');
  for (const f of ['UDB-User1001+LocalStorage.sql', 'LocalSettingsDB.sql', '_ConduitMultiUserDB.sql', 'UDB-Userx+RemoteGraph.sql']) {
    writeFileSync(join(dataDir, 'conduit-storage', HOST_DIR, f), 'x');
  }
  const out = listAccounts(dataDir);
  assert.deepEqual(out.map((x) => x.userId), ['1001', '77']);
  const main = out[0];
  assert.equal(main.dbPath, dbPath);
  assert.equal(main.host, HOST_DIR);
  assert.equal(main.resourceCacheDir, resourceCacheDir);
  assert.equal(main.resourceCacheExists, true);
  assert.ok(main.dbBytes > 0);
  assert.ok(main.modifiedAt instanceof Date);
  assert.equal(out[1].resourceCacheExists, false);
});

test('a data dir with no conduit-storage lists nothing', () => {
  assert.deepEqual(listAccounts('/definitely/not/here'), []);
});

test('the accounts command prints ids and sizes, never a title', () => {
  const { dataDir } = buildSyntheticAccount();
  const out = execFileSync(process.execPath, ['bin/kosko-assist.mjs', 'accounts', '--data-dir', dataDir], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.match(out, /User1001/);
  assert.match(out, /resource-cache: yes/);
  assert.doesNotMatch(out, /Active note|Receipts|hello world/);
});
