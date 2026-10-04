# Kosko desktop assist

Moves a whole Evernote account into [Kosko](https://kosko.app) from your own computer.

- It reads Evernote's local data from a read-only copy. The database file never leaves your machine.
- On a paid Evernote plan, the formatted notes come from Evernote's official MCP server, after you sign in to
  Evernote once (read-only access).
- Before anything is sent, it writes the exact plan to disk, so you can inspect it.

**Status: early development.** Nothing is sent to Kosko yet. Today it contains:

- `accounts`: lists the Evernote accounts on this computer (user id, database size, last written). It reads file
  names and sizes only.
- `src/reader/`: reads one account from a private snapshot of Evernote's local database (notebooks, stacks,
  tags, notes with their plain text, attachments in the local cache, and the text Evernote recognised in
  images). The snapshot goes in a `0700` temp folder and is deleted when the run ends. Evernote's own files are
  opened read-only and never written. If the database is not a version the reader knows, it refuses to read
  anything.
- `dry-run`: writes the whole import plan for one account to a folder you choose (`kosko-plan.json`, readable
  only by you), plus a one-screen summary. Every number is checked against a direct count of Evernote's
  database, and the run fails if any differs. Nothing is sent.
- `probe-mcp`: a measurement tool that checks how fast Evernote's MCP server hands out notes. It never stores
  note titles or bodies, and it never writes your tokens to disk.

```sh
node bin/kosko-assist.mjs accounts                       # Windows / macOS: finds Evernote's folder itself
node bin/kosko-assist.mjs accounts --data-dir <folder>   # anywhere else, e.g. WSL: /mnt/c/Users/<you>/AppData/Roaming/Evernote
node bin/kosko-assist.mjs dry-run --out ./kosko-dry-run    # add --data-dir as above where needed
node bin/kosko-assist.mjs probe-mcp --out ./probe-out
npm test
```

Requires Node 22.16 or later (for `node:sqlite`'s backup API). No dependencies.

Licensed under the Apache License, Version 2.0 (see `LICENSE`).
