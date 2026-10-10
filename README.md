# Kosko desktop assist

Moves a whole Evernote account into [Kosko](https://kosko.app) from your own computer.

- It reads Evernote's local data from a read-only copy. The database file never leaves your machine.
- On a paid Evernote plan, the formatted notes come from Evernote's official MCP server, after you sign in to
  Evernote once (read-only access).
- Before anything is sent, it writes the exact plan to disk, so you can inspect it.

## Which route fits your Evernote plan

Evernote gives formatted notes only on paid plans, so there are two routes:

- **Paid plan:** this tool, in one run. Sign in to Evernote once (`send --evernote`) and every note arrives
  formatted, with its notebook, stack, tags, files and the words inside its images.
- **Free plan:** this tool first (`send`), which brings every note as plain text with everything else above; then an
  Evernote export (`.enex` files) dropped on Kosko's [Import page](https://kosko.app/import), which formats those
  same notes in place, without making copies.

## Download

No release has been published yet. Once a release is published, its page under
[Releases](https://github.com/janardhannallapati/kosko-desktop-assist/releases) has one file per computer, with nothing
to install first (Node.js is inside it):

- Windows: `kosko-assist-windows-x64.exe`
- Mac with Apple silicon (M1 or later): `kosko-assist-macos-arm64`
- Mac with an Intel processor: `kosko-assist-macos-x64`

`SHA256SUMS.txt` in the same release holds each file's SHA-256, to check a download against.

These builds are **not signed yet**, so the first time you open one, your computer warns you:

- **Windows:** SmartScreen says "Windows protected your PC". Choose **More info**, then **Run anyway**.
- **macOS:** in Terminal, make the file runnable (`chmod +x kosko-assist-macos-arm64`) and run it
  (`./kosko-assist-macos-arm64 accounts`). macOS blocks it the first time. Open **System Settings → Privacy & Security**,
  scroll to the message about `kosko-assist`, choose **Open Anyway**, then run it again.

Signed installers come before the public launch. The commands are the same as below, with the file's name in place
of `node bin/kosko-assist.mjs`, for example `kosko-assist-windows-x64.exe dry-run --out kosko-plan`.

## Run it with Node.js instead

Start without git or a clone, on the computer where Evernote is installed (Node.js 22.16 or newer):

```sh
npx https://github.com/janardhannallapati/kosko-desktop-assist/archive/refs/heads/main.tar.gz dry-run --out kosko-plan
```

The first step sends nothing: it writes a plan you can read in the `kosko-plan` folder.

## What it does

**Status: early development.** Today it contains:

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
- `match`: reads Evernote exports (`.enex`) and checks that each note finds exactly one note in the local database by
  its creation time, the key Kosko uses for notes from an export. It prints counts and names, by title, every note
  that did not match. Nothing is sent anywhere.
- `probe-mcp`: a measurement tool that checks how fast Evernote's MCP server hands out notes. It never stores
  note titles or bodies, and it never writes your tokens to disk.
- `connect`: checks a Kosko import token (made on Kosko's Import page; it starts with `cvit_`, lasts 24 hours and can
  call only the import routes) and prints the storage you have used and have left. It sends nothing else. Paste the
  token when asked, or set `KOSKO_IMPORT_TOKEN`; there is no `--token` option, because a flag is saved in your shell
  history. The token is never written to disk or printed. `src/send/` holds the client the send step uses: it waits
  when Kosko is busy and resumes a stopped run from a checkpoint file next to the plan.
- `send`: moves the account the dry run planned into Kosko — notebooks under their stacks, notes with no notebook in a
  notebook named after their Space, every tag (unused ones too; a nested tag as `parent/child`), every note with its
  plain text, dates and Evernote id, and the attachments that are on this computer. It counts Evernote again first and
  stops if anything changed since the dry run. Ctrl-C stops it; running it again continues the same import, and a
  second run creates nothing. The receipt in Kosko names everything that did not come across.

```sh
node bin/kosko-assist.mjs accounts                       # Windows / macOS: finds Evernote's folder itself
node bin/kosko-assist.mjs accounts --data-dir <folder>   # anywhere else, e.g. WSL: /mnt/c/Users/<you>/AppData/Roaming/Evernote
node bin/kosko-assist.mjs dry-run --out ./kosko-dry-run    # add --data-dir as above where needed
node bin/kosko-assist.mjs match ./my-exports --out ./kosko-match   # a folder of .enex files, or the files themselves
node bin/kosko-assist.mjs probe-mcp --out ./probe-out
node bin/kosko-assist.mjs connect                          # or --app http://127.0.0.1:3003 for a local Kosko
node bin/kosko-assist.mjs send --plan ./kosko-dry-run      # add --data-dir / --app as above where needed
npm test
```

`npm run test:sea` builds the single executable for the computer it runs on into `dist/` (`npm run build:sea` builds
without testing) and runs it through the CLI's main paths. The release workflow does the same on Windows and macOS
when a `v<version>` tag is pushed.

Requires Node 22.16 or later (for `node:sqlite`'s backup API). The runtime dependencies, each pinned to an exact version:

- `@kosko-app/enex-core`: the ENML converter, the `fp1` fingerprint and the note schema (it brings `sax` and
  `hash-wasm`);
- the `@tiptap/*` packages (3.30.5): enex-core's peers, which define the note schema the converter fills;
- `jsdom` (29.1.1): the DOM the converter runs on, loaded only by `send --evernote` and `convert-enml`.

`esbuild` and `postject` are development dependencies, used only to build the single executable.

Licensed under the Apache License, Version 2.0 (see `LICENSE`).

## The shared package

[`packages/enex-core`](packages/enex-core/README.md) is published as `@kosko-app/enex-core`. It holds the ENML
converter, the `fp1` note fingerprint and the note schema, the parts this tool and Kosko's web import must agree on
exactly. Both pin it to one exact version. Its tests run with `npm run test:core`; `npm run test:all` runs both suites.
