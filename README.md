# Kosko desktop assist

Moves a whole Evernote account into [Kosko](https://kosko.app) from your own computer.

- It reads Evernote's local data from a read-only copy. The database file never leaves your machine.
- On a paid Evernote plan, the formatted notes come from Evernote's official MCP server, after you sign in to
  Evernote once (read-only access).
- Before anything is sent, it writes the exact plan to disk, so you can inspect it.

**Status: early development.** Today it contains only `probe-mcp`, a measurement tool that checks how fast
Evernote's MCP server hands out notes. It never stores note titles or bodies, and it never writes your tokens to
disk.

```sh
node bin/kosko-assist.mjs probe-mcp --out ./probe-out
npm test
```

Requires Node 22.5 or later. No dependencies.

Licensed under the Apache License, Version 2.0 (see `LICENSE`).
