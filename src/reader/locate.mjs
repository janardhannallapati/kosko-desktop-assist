// Where Evernote 10 keeps its data, and which accounts are in it. Each signed-in account has a graph database
// conduit-storage/<host>/UDB-User<id>+RemoteGraph.sql (SQLite despite the name) and an attachment cache
// resource-cache/User<id>/<noteId>/<dataHash>. Only the Windows desktop path is verified on a real machine; the
// Store and macOS paths follow Electron's defaults, and every platform accepts an explicit dataDir.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';

const ACCOUNT_FILE = /^UDB-User(\d+)\+RemoteGraph\.sql$/;

export function findDataDirs({ platform = process.platform, env = process.env, home = homedir(), dataDir,
  exists = existsSync, readdir = readdirSync } = {}) {
  if (dataDir) return [dataDir];
  const candidates = [];
  if (platform === 'win32') {
    const p = nodePath.win32;
    if (env.APPDATA) candidates.push(p.join(env.APPDATA, 'Evernote'));
    if (env.LOCALAPPDATA) {
      const pkgs = p.join(env.LOCALAPPDATA, 'Packages');
      if (exists(pkgs)) {
        for (const name of readdir(pkgs)) {
          if (name.startsWith('Evernote.Evernote_')) candidates.push(p.join(pkgs, name, 'LocalCache', 'Roaming', 'Evernote'));
        }
      }
    }
  } else if (platform === 'darwin') {
    const p = nodePath.posix;
    candidates.push(p.join(home, 'Library', 'Application Support', 'Evernote'));
    candidates.push(p.join(home, 'Library', 'Containers', 'com.evernote.Evernote', 'Data', 'Library', 'Application Support', 'Evernote'));
  }
  return candidates.filter((c) => exists(c));
}

/** @returns {{ userId, host, dbPath, dbBytes, modifiedAt, resourceCacheDir, resourceCacheExists }[]} largest first */
export function listAccounts(dataDir) {
  const conduit = nodePath.join(dataDir, 'conduit-storage');
  if (!existsSync(conduit)) return [];
  const accounts = [];
  for (const host of readdirSync(conduit).sort()) {
    const hostDir = nodePath.join(conduit, host);
    let files;
    try { files = statSync(hostDir).isDirectory() ? readdirSync(hostDir) : []; } catch { continue; } // dangling / no access
    for (const file of files.sort()) {
      const m = file.match(ACCOUNT_FILE);
      if (!m) continue;
      const dbPath = nodePath.join(hostDir, file);
      let s;
      try { s = statSync(dbPath); } catch { continue; }
      const resourceCacheDir = nodePath.join(dataDir, 'resource-cache', `User${m[1]}`);
      accounts.push({ userId: m[1], host, dbPath, dbBytes: s.size, modifiedAt: s.mtime, resourceCacheDir,
        resourceCacheExists: existsSync(resourceCacheDir) });
    }
  }
  // Largest first: the account a user wants to move is almost always the one with the most in it.
  return accounts.sort((x, y) => y.dbBytes - x.dbBytes || x.userId.localeCompare(y.userId));
}
